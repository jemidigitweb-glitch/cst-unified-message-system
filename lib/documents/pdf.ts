/**
 * A minimal PDF writer: text, rules, and nothing else.
 *
 * ------------------------------------------------------------------------
 * WHY THERE IS NO PDF LIBRARY HERE
 * ------------------------------------------------------------------------
 * This project's entire runtime dependency set is `next`, `pg`, `react`,
 * `react-dom`, `server-only` and `zod`. An invoice is a single-column page of
 * text and horizontal rules, which needs no layout engine, no font embedding
 * and no headless browser — the PDF base-14 fonts are guaranteed present in
 * every reader, so `Helvetica` needs only to be named. Pulling in a renderer
 * for that would add a supply-chain surface out of all proportion to a page of
 * text.
 *
 * The trade is deliberate and bounded: this writer supports left-aligned text
 * runs, two weights, and rules. It has no wrapping, no tables, no images, no
 * colour and no unicode beyond WinAnsi (see `encodeWinAnsi`). If the document
 * ever needs more than that, swapping in a real library is a contained change,
 * because `renderPdf` is the only function that knows what a PDF is.
 *
 * ------------------------------------------------------------------------
 * COORDINATES
 * ------------------------------------------------------------------------
 * PDF's origin is the BOTTOM-left and y grows upward, which is the opposite of
 * every screen coordinate system and the usual source of upside-down output.
 * Callers here work in the natural direction — y is measured DOWN from the top
 * of the page — and `renderPdf` performs the single flip.
 */

/** A4 in PDF points (1/72"), the standard page for a UK/EU invoice. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

export type PdfFont = "regular" | "bold";

/**
 * One run of text. `y` is measured DOWN from the top of the page.
 *
 * `align: "right"` treats `x` as the RIGHT edge and shifts the run left by its
 * measured width — which is what makes a column of money line up on its last
 * digit instead of its first.
 */
export type PdfText = {
  readonly kind: "text";
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: PdfFont;
  readonly text: string;
  readonly align?: "left" | "right";
};

/** A horizontal rule. `y` is measured DOWN from the top of the page. */
export type PdfRule = {
  readonly kind: "rule";
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  readonly width: number;
};

export type PdfItem = PdfText | PdfRule;
export type PdfPage = readonly PdfItem[];

/**
 * The few WinAnsi code points that are NOT Latin-1 at the same value.
 *
 * WinAnsiEncoding matches Latin-1 from 0xA0 upward, so most accented European
 * text — which this business has a great deal of, selling into Germany — passes
 * straight through. The 0x80–0x9F block is where the two differ, and these are
 * the characters that actually turn up in product titles and addresses.
 */
const WIN_ANSI_EXTRAS = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85], // …
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e],
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98],
  [0x2122, 0x99], // ™
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e],
  [0x0178, 0x9f], // Ÿ
]);

/** What an unrepresentable character becomes. Visible, never silently dropped. */
const SUBSTITUTE = 0x3f; // '?'

/**
 * Text to WinAnsi bytes, with PDF string escaping.
 *
 * LOSSY, AND DELIBERATELY VISIBLE. A character WinAnsi cannot represent becomes
 * `?` rather than disappearing, so a mangled title is obvious on the page
 * instead of quietly shortening a product name. A SKU is unaffected in
 * practice — they are ASCII — and `renderPdf` never alters the string it is
 * given beyond this encoding.
 */
export function encodeWinAnsi(value: string): Buffer {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0)!;
    let byte: number;
    if (code === 0x0a || code === 0x0d) byte = 0x20; // newlines never span runs
    else if (code < 0x20) byte = SUBSTITUTE;
    else if (code < 0x80) byte = code;
    else if (WIN_ANSI_EXTRAS.has(code)) byte = WIN_ANSI_EXTRAS.get(code)!;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else byte = SUBSTITUTE;

    // PDF literal strings: `(`, `)` and `\` must be escaped or the stream ends
    // early and the file is corrupt.
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/* ------------------------------------------------------------------------- *
 * MEASUREMENT
 *
 * Helvetica's own advance widths, in 1/1000 em, taken from the Adobe AFM
 * metrics for the base-14 fonts. They are what a reader will use to draw the
 * text, so measuring with anything else — an average, a character count —
 * produces a column that fits on paper and overlaps in a viewer.
 *
 * This is arithmetic about LAYOUT. Nothing here touches a money value: the
 * amounts are strings from the database, and measuring one to right-align it
 * does not parse, round or alter it.
 * ------------------------------------------------------------------------- */

/** Advance widths for codes 32..126, in order. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Accented Latin-1 characters measured as their base letter.
 *
 * Exact for Helvetica: `Ä` advances as `A`, `ö` as `o`. The business sells into
 * Germany, so this is the common case rather than an edge one, and treating
 * every accented character as an average width is what makes a German product
 * title wrap one word too early or one word too late.
 */
function foldToBase(code: number): number {
  if (code >= 0xc0 && code <= 0xc5) return 0x41; // À-Å
  if (code === 0xc6) return 0x41;
  if (code === 0xc7) return 0x43; // Ç
  if (code >= 0xc8 && code <= 0xcb) return 0x45; // È-Ë
  if (code >= 0xcc && code <= 0xcf) return 0x49; // Ì-Ï
  if (code === 0xd1) return 0x4e; // Ñ
  if (code >= 0xd2 && code <= 0xd6) return 0x4f; // Ò-Ö
  if (code >= 0xd9 && code <= 0xdc) return 0x55; // Ù-Ü
  if (code === 0xdd) return 0x59; // Ý
  if (code >= 0xe0 && code <= 0xe5) return 0x61; // à-å
  if (code === 0xe7) return 0x63; // ç
  if (code >= 0xe8 && code <= 0xeb) return 0x65; // è-ë
  if (code >= 0xec && code <= 0xef) return 0x69; // ì-ï
  if (code === 0xf1) return 0x6e; // ñ
  if (code >= 0xf2 && code <= 0xf6) return 0x6f; // ò-ö
  if (code >= 0xf9 && code <= 0xfc) return 0x75; // ù-ü
  if (code === 0xdf) return 0x73; // ß, as `s`
  return 0x6f; // anything else: `o`, a mid-width letter
}

/** The width of one run, in points. */
export function textWidth(value: string, size: number, font: PdfFont): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  let mille = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const index = (code >= 32 && code <= 126 ? code : foldToBase(code)) - 32;
    mille += table[index] ?? 556;
  }
  return (mille * size) / 1000;
}

/**
 * Breaks text into lines that fit `maxWidth`.
 *
 * ON WORD BOUNDARIES WHERE IT CAN, and on character boundaries where a single
 * token is itself too wide — which is the case that matters for a SKU. Nothing
 * is dropped, nothing is ellipsised and no hyphen is inserted: a hyphen would
 * add a character to a value that must survive byte for byte, and a customer
 * reading a wrapped SKU must be able to type it back exactly.
 */
export function wrapText(
  value: string,
  maxWidth: number,
  size: number,
  font: PdfFont,
): string[] {
  if (value === "") return [""];

  const lines: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current !== "") lines.push(current);
    current = "";
  };

  /** Splits a token that cannot fit on a line of its own. */
  const breakToken = (token: string) => {
    let piece = "";
    for (const character of token) {
      if (piece !== "" && textWidth(piece + character, size, font) > maxWidth) {
        lines.push(piece);
        piece = character;
      } else {
        piece += character;
      }
    }
    current = piece;
  };

  for (const token of value.split(/\s+/).filter((part) => part !== "")) {
    const candidate = current === "" ? token : `${current} ${token}`;
    if (textWidth(candidate, size, font) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (textWidth(token, size, font) <= maxWidth) current = token;
    else breakToken(token);
  }
  pushCurrent();

  return lines.length === 0 ? [""] : lines;
}

/**
 * Breaks text to fit `maxWidth` on CHARACTER boundaries only.
 *
 * For values that must render exactly as stored. `wrapText` splits on
 * whitespace and rejoins with single spaces, which is right for prose and
 * wrong for a SKU: a SKU is opaque, and a run of spaces inside one would come
 * back as a single space on the page. This never looks at whitespace, so
 * concatenating the returned lines reproduces the input byte for byte.
 */
export function wrapExact(
  value: string,
  maxWidth: number,
  size: number,
  font: PdfFont,
): string[] {
  if (value === "") return [""];

  const lines: string[] = [];
  let current = "";
  for (const character of value) {
    if (current !== "" && textWidth(current + character, size, font) > maxWidth) {
      lines.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

/** A number for the content stream: fixed precision, no exponent, no locale. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** One page's items as a PDF content stream. */
function contentStream(items: PdfPage): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item.kind === "rule") {
      const y = PAGE_HEIGHT - item.y;
      parts.push(
        Buffer.from(
          `${num(item.width)} w ${num(item.x1)} ${num(y)} m ${num(item.x2)} ${num(y)} l S\n`,
          "latin1",
        ),
      );
      continue;
    }
    const font = item.font === "bold" ? "/F2" : "/F1";
    const y = PAGE_HEIGHT - item.y;
    const x =
      item.align === "right"
        ? item.x - textWidth(item.text, item.size, item.font)
        : item.x;
    parts.push(
      Buffer.from(`BT ${font} ${num(item.size)} Tf 1 0 0 1 ${num(x)} ${num(y)} Tm (`, "latin1"),
      encodeWinAnsi(item.text),
      Buffer.from(") Tj ET\n", "latin1"),
    );
  }
  return Buffer.concat(parts);
}

/**
 * Pages to a complete PDF file.
 *
 * Objects are numbered: 1 catalog, 2 page tree, 3 regular font, 4 bold font,
 * then a (page, content) pair per page. The cross-reference table records the
 * byte offset of every object, so the whole file is assembled as bytes and the
 * offsets are taken from that buffer rather than computed from string lengths —
 * a character-length assumption is what breaks a PDF the moment a title
 * contains a byte above 0x7F.
 */
export function renderPdf(pages: readonly PdfPage[]): Buffer {
  const sheets = pages.length === 0 ? [[] as PdfPage] : pages;

  const CATALOG = 1;
  const PAGE_TREE = 2;
  const FONT_REGULAR = 3;
  const FONT_BOLD = 4;
  const FIRST_PAGE = 5;

  const pageIds = sheets.map((_, index) => FIRST_PAGE + index * 2);
  const objects = new Map<number, Buffer>();

  objects.set(
    CATALOG,
    Buffer.from(`<< /Type /Catalog /Pages ${PAGE_TREE} 0 R >>`, "latin1"),
  );
  objects.set(
    PAGE_TREE,
    Buffer.from(
      `<< /Type /Pages /Count ${sheets.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(" ")}] >>`,
      "latin1",
    ),
  );
  objects.set(
    FONT_REGULAR,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "latin1",
    ),
  );
  objects.set(
    FONT_BOLD,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      "latin1",
    ),
  );

  sheets.forEach((items, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const stream = contentStream(items);
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent ${PAGE_TREE} 0 R ` +
          `/MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] ` +
          `/Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
        "latin1",
      ),
    );
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
        stream,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  });

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets = new Map<number, number>();

  const highest = FIRST_PAGE + sheets.length * 2 - 1;
  for (let id = 1; id <= highest; id += 1) {
    const body = objects.get(id)!;
    offsets.set(id, offset);
    const chunk = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  }

  const size = highest + 1;
  const xref: string[] = [`xref\n0 ${size}\n`, "0000000000 65535 f \n"];
  for (let id = 1; id <= highest; id += 1) {
    xref.push(`${String(offsets.get(id)!).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(Buffer.from(xref.join(""), "latin1"));
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${size} /Root ${CATALOG} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
      "latin1",
    ),
  );

  return Buffer.concat(chunks);
}
