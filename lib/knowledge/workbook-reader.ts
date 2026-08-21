import { inflateRawSync } from "node:zlib";

/**
 * Minimal XLSX reader: ZIP central directory + inflate + XML scrape.
 *
 * NO DEPENDENCY, on purpose. This project already declines a migration
 * framework and an AI SDK for the same reason — a library that only ever needs
 * to do one small thing should be the small thing. Reading a workbook is a
 * one-way, offline, local-file operation over a format that has not changed in
 * fifteen years, and the alternatives (SheetJS, exceljs) are large surfaces to
 * take on for "turn a sheet into strings".
 *
 * READ-ONLY. Nothing here writes a workbook, and nothing here reaches the
 * network. The business's documents are its own; this borrows their contents.
 *
 * SCOPE. Handles what these rule workbooks actually contain: shared strings,
 * inline strings, numbers, and merged-cell layouts. It does NOT evaluate
 * formulas — it returns the cached value Excel last stored, which is what a
 * reader wants. Dates come back as the underlying serial number; no rule
 * content in this corpus is a date.
 */

/** One worksheet, as a grid of strings. `grid[r][c]`, both 0-based. */
export type SheetGrid = readonly (readonly string[])[];

/** A workbook: sheet name in document order -> grid. */
export type Workbook = ReadonlyMap<string, SheetGrid>;

/** Unpacks a ZIP archive into { entry name -> bytes }. */
function unzip(buf: Buffer): Map<string, Buffer> {
  // The End Of Central Directory record is last, after a comment of unknown
  // length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeader = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // The local header's extra field can differ in length from the central
    // one's, so the data offset is recomputed from the local header itself.
    const localNameLen = buf.readUInt16LE(localHeader + 26);
    const localExtraLen = buf.readUInt16LE(localHeader + 28);
    const start = localHeader + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (match) => ENTITIES[match] ?? match);
}

/**
 * Concatenated text of every <t> node in a fragment.
 *
 * A single cell's string is split across several <r> runs when parts of it are
 * styled differently. Joining them is what makes "⚠ NEVER say 'open a case'"
 * arrive as one rule rather than three fragments.
 */
function textOf(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out += decodeXml(match[1] ?? "");
  }
  return out;
}

function sharedStrings(files: Map<string, Buffer>): string[] {
  const xml = files.get("xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((m) =>
    textOf(m[1] ?? ""),
  );
}

/** "BC" -> 54. Column letters are base-26 with no zero. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1];
  if (!letters) return 0;
  let n = 0;
  for (const character of letters) n = n * 26 + (character.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, strings: readonly string[]): string[][] {
  const grid: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1]!;
      const body = cellMatch[2] ?? "";
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attributes)?.[1];

      let value: string;
      if (type === "s") {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        value = strings[index] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(body);
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }
      cells[columnIndex(reference)] = value;
    }
    // Sparse arrays: a sheet may skip empty rows and columns entirely.
    grid[rowNumber - 1] = Array.from({ length: cells.length }, (_, i) => cells[i] ?? "");
  }
  return Array.from({ length: grid.length }, (_, i) => grid[i] ?? []);
}

/** Reads every sheet of a workbook, in the order the workbook declares them. */
export function readWorkbook(bytes: Buffer): Workbook {
  const files = unzip(bytes);
  const strings = sharedStrings(files);

  const workbookXml = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const relsXml = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const relationships = new Map(
    [...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(
      ([, id, target]) => [id!, target!.replace(/^\/?xl\//, "").replace(/^\//, "")],
    ),
  );

  const sheets = new Map<string, SheetGrid>();
  for (const match of workbookXml.matchAll(/<sheet[^>]*\/>/g)) {
    const tag = match[0];
    const name = decodeXml(/name="([^"]*)"/.exec(tag)?.[1] ?? "");
    const relationshipId = /r:id="([^"]+)"/.exec(tag)?.[1];
    if (!name || !relationshipId) continue;
    const target = relationships.get(relationshipId);
    const sheetXml = (target && (files.get(`xl/${target}`) ?? files.get(target)))?.toString("utf8");
    if (sheetXml === undefined) continue;
    sheets.set(name, parseSheet(sheetXml, strings));
  }
  return sheets;
}
