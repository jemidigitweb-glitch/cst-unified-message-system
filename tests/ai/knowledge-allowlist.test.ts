import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CstRule } from "@/lib/domain/knowledge";
import {
  APPROVED_KNOWLEDGE_FILES,
  FORBIDDEN_KNOWLEDGE_FILES,
  isApprovedForUpload,
  renderKnowledgeDocuments,
} from "@/lib/knowledge/knowledge-files";

/**
 * What may leave this machine.
 *
 * Uploading to a third-party vector store cannot be undone — you can delete the
 * file afterwards, but you cannot un-send it. These tests exist because one of
 * the workbooks in `Knowledge-source/` is a customer contact list, and the
 * difference between an allowlist and an exclusion list is the difference
 * between failing closed and failing open.
 */

const DIRECTORY = join(__dirname, "..", "..", "Knowledge-source");
const present =
  existsSync(DIRECTORY) && readdirSync(DIRECTORY).some((name) => name.endsWith(".xlsx"));

function rule(overrides: Partial<CstRule> = {}): CstRule {
  return {
    ref: "DAM-ABC-12",
    title: "Cracked glass on arrival",
    text: "Ask for photographs before offering anything.",
    category: "Damage",
    sourceFile: "DAMAGE DECISION GUIDE.xlsx",
    sourceSheet: "2 - Damage",
    sourceRow: 12,
    ...overrides,
  };
}

describe("the upload allowlist", () => {
  it("refuses the B2B customer workbook", () => {
    expect(isApprovedForUpload("B2B  customers .xlsx")).toBe(false);
  });

  it("refuses anything it has not been told about", () => {
    // The failure mode of an exclusion list: a new file appears and ships.
    expect(isApprovedForUpload("NEW SUPPLIER CONTACTS.xlsx")).toBe(false);
    expect(isApprovedForUpload("customers-export.csv")).toBe(false);
    expect(isApprovedForUpload("")).toBe(false);
  });

  it("accepts each approved workbook", () => {
    for (const name of APPROVED_KNOWLEDGE_FILES) {
      expect(isApprovedForUpload(name), name).toBe(true);
    }
  });

  it("matches regardless of casing and stray whitespace", () => {
    // These filenames carry double spaces and trailing spaces as shipped.
    expect(isApprovedForUpload("  admin.XLSX  ")).toBe(true);
    expect(isApprovedForUpload("  b2b  CUSTOMERS .xlsx ")).toBe(false);
  });

  it("keeps the forbidden list disjoint from the approved list", () => {
    for (const name of FORBIDDEN_KNOWLEDGE_FILES) {
      expect(APPROVED_KNOWLEDGE_FILES).not.toContain(name);
    }
  });
});

describe("rendering documents for the vector store", () => {
  it("drops any rule whose workbook is not approved", () => {
    // Second line of defence: even handed a forbidden rule directly, nothing
    // from it may reach an upload payload.
    const documents = renderKnowledgeDocuments([
      rule(),
      // Reserved domain: this literal can never reach a real person, which is
      // also what keeps the committed-content guard honest.
      rule({ ref: "X-1", sourceFile: "B2B  customers .xlsx", text: "Contact: buyer@example.invalid" }),
    ]);
    const all = documents.map((d) => d.markdown).join("\n");
    expect(all).toContain("[DAM-ABC-12]");
    expect(all).not.toContain("buyer@example.invalid");
    expect(all).not.toContain("[X-1]");
  });

  it("groups by area and keeps each rule whole with its reference", () => {
    const documents = renderKnowledgeDocuments([
      rule({ ref: "DAM-1-1", category: "Damage" }),
      rule({ ref: "DEL-2-2", category: "Delivery", sourceFile: "Delivery_Master_Rules final.xlsx" }),
    ]);
    expect(documents.map((d) => d.area).sort()).toEqual(["Damage", "Delivery"]);
    for (const doc of documents) {
      expect(doc.name).toMatch(/\.md$/);
      expect(doc.ruleCount).toBe(1);
    }
  });

  it("carries the source coordinates so a citation stays traceable", () => {
    const [doc] = renderKnowledgeDocuments([rule()]);
    expect(doc!.markdown).toContain("DAMAGE DECISION GUIDE.xlsx");
    expect(doc!.markdown).toContain("2 - Damage");
    expect(doc!.markdown).toContain("row 12");
  });

  it("produces a filename safe to use as an upload name", () => {
    const [doc] = renderKnowledgeDocuments([rule({ category: "Returns & Refunds" })]);
    expect(doc!.name).toBe("Returns-&-Refunds.md");
    expect(doc!.name).not.toMatch(/[/\\:*?"<>|]/);
  });
});

describe.skipIf(!present)("against the real folder", () => {
  it("withholds every workbook that is not on the allowlist", () => {
    const files = readdirSync(DIRECTORY).filter((name) => name.endsWith(".xlsx"));
    const withheld = files.filter((name) => !isApprovedForUpload(name));
    // The customer list must be among the withheld, whatever else is.
    expect(withheld.some((name) => /b2b/i.test(name))).toBe(true);
  });

  it("approves only files that actually exist", () => {
    const files = readdirSync(DIRECTORY).map((name) => name.trim().toLowerCase());
    for (const approved of APPROVED_KNOWLEDGE_FILES) {
      expect(files, `allowlisted but missing: ${approved}`).toContain(approved.trim().toLowerCase());
    }
  });
});
