import { describe, expect, it } from "vitest";

import { UNRESOLVED_REFERENCE_PREFIX } from "@/lib/domain/conversation-reference";
import {
  BANDQ_SOURCE,
  type BandqSourceRow,
  hasSourceOrderReference,
  normalizeRow,
  readBody,
  sourceOrderRefOf,
} from "@/lib/marketplaces/bandq/adapter";
import { buildQuery, classifyRows } from "@/lib/marketplaces/bandq/message-repository";

/** Synthetic values only. No real customer data appears in any test. */
function row(overrides: Partial<BandqSourceRow> = {}): BandqSourceRow {
  return {
    id: "1",
    message_id: "src-1",
    sub_source: 4,
    message_type: "Question",
    order_id: "0000000001-A",
    message_date: "2026-08-10 09:15:00",
    message_content: "synthetic body",
    ...overrides,
  };
}

describe("body handling", () => {
  it("treats the body as plain text, never as JSON", () => {
    // The eBay decoder would parse this and return the number 5. Applying it
    // here would corrupt or discard real message content.
    expect(readBody("5")).toEqual({ text: "5", status: "decoded" });
    expect(readBody('"quoted"')).toEqual({ text: '"quoted"', status: "decoded" });
  });

  it("reports an absent or blank body as empty rather than failed", () => {
    expect(readBody(null)).toEqual({ text: null, status: "empty" });
    expect(readBody("   ")).toEqual({ text: null, status: "empty" });
  });
});

describe("direction", () => {
  it("marks every message inbound, matching the verified source", () => {
    for (const type of ["Question", "Shipping", "Cancellation", "Return", "General"]) {
      expect(normalizeRow(row({ message_type: type }))!.direction).toBe("inbound");
    }
  });
});

describe("source reference", () => {
  it("carries a present reference through verbatim", () => {
    expect(sourceOrderRefOf("0000000001-A")).toBe("0000000001-A");
    expect(normalizeRow(row())!.sourceMetadata.sourceOrderRef).toBe("0000000001-A");
  });

  it("treats a blank reference as absent", () => {
    expect(sourceOrderRefOf("")).toBeNull();
    expect(sourceOrderRefOf("   ")).toBeNull();
    expect(sourceOrderRefOf(null)).toBeNull();
  });

  it("uses the reference to group, and falls back to the source PK", () => {
    expect(normalizeRow(row())!.counterpartyRef).toBe("0000000001-A");
    const ungrouped = normalizeRow(row({ id: "77", order_id: null }))!;
    expect(ungrouped.counterpartyRef).toBe(`${UNRESOLVED_REFERENCE_PREFIX}77`);
    expect(hasSourceOrderReference(ungrouped)).toBe(false);
  });
});

describe("no fabricated context", () => {
  it("claims no listing or item reference, because the source has none", () => {
    expect(normalizeRow(row())!.listingItemRef).toBeNull();
  });

  it("never derives identity or grouping from an address", () => {
    // The adapter must not even read a sender or recipient column: every
    // message arrives from a platform or courier relay, so an address
    // identifies the channel, not a person.
    const normalized = normalizeRow(row())!;
    expect(Object.keys(normalized.sourceMetadata).sort()).toEqual([
      "messageType",
      "sourceOrderRef",
    ]);
    expect(JSON.stringify(normalized)).not.toMatch(/from_msg|to_msg|sender|recipient/i);
  });

  it("invents no order, SKU, product, tracking or delivery fact", () => {
    const serialised = JSON.stringify(normalizeRow(row())).toLowerCase();
    for (const invented of ["sku", "product", "tracking", "delivered", "refund", "listing_url"]) {
      expect(serialised).not.toContain(invented);
    }
  });
});

describe("timestamps", () => {
  it("carries the source timestamp through unchanged and unlabelled", () => {
    const stamp = "2026-08-10 23:59:59";
    const normalized = normalizeRow(row({ message_date: stamp }))!;
    expect(normalized.sourceTimestamp).toBe(stamp);
    expect(JSON.stringify(normalized)).not.toMatch(/UTC|GMT|BST|Berlin/);
  });
});

describe("source identity", () => {
  it("records the full source coordinates that make sync idempotent", () => {
    const normalized = normalizeRow(row({ id: "12345" }))!;
    expect(normalized.sourceDatabase).toBe(BANDQ_SOURCE.database);
    expect(normalized.sourceSchema).toBe(BANDQ_SOURCE.schema);
    expect(normalized.sourceTable).toBe(BANDQ_SOURCE.messageTable);
    expect(normalized.sourcePk).toBe("12345");
    expect(normalized.marketplace).toBe("bandq");
  });
});

describe("unusable rows", () => {
  it("rejects rather than coerces a row with no account attribution", () => {
    expect(normalizeRow(row({ sub_source: null }))).toBeNull();
  });

  it("counts what it rejected instead of silently dropping it", () => {
    const result = classifyRows([row({ id: "1" }), row({ id: "2", sub_source: null })]);
    expect(result.rowsExamined).toBe(2);
    expect(result.messages).toHaveLength(1);
    expect(result.unusableCount).toBe(1);
  });
});

describe("fetch query", () => {
  it("is bounded, parameterised and ordered by the shared intent", () => {
    const { text, values } = buildQuery({
      window: { mode: "bootstrap", startAt: "2026-08-05 00:00:00" },
      limit: 500,
    });
    expect(text).toContain("customer_service.bandq_messages");
    expect(text).toMatch(/WHERE m\.date >= \$1::timestamp/);
    expect(text).toMatch(/ORDER BY m\.date ASC, m\.id ASC/);
    expect(text).toMatch(/LIMIT \$2/);
    expect(values).toEqual(["2026-08-05 00:00:00", 500]);
  });

  it("resumes strictly after the watermark pair", () => {
    const { text, values } = buildQuery({
      window: { mode: "after", watermark: { sourceTimestamp: "2026-08-10 00:00:00", sourcePk: "9" } },
    });
    expect(text).toMatch(/\(m\.date, m\.id\) > \(\$1::timestamp, \$2::bigint\)/);
    expect(values.slice(0, 2)).toEqual(["2026-08-10 00:00:00", "9"]);
  });

  it("selects the naive timestamp as text so the driver cannot shift it", () => {
    expect(buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-05" } }).text).toMatch(
      /m\.date::text\s+AS message_date/,
    );
  });

  it("selects no sender or recipient column", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-05" } });
    expect(text).not.toMatch(/from_msg|to_msg/);
  });

  it("offers no unbounded window", () => {
    // A start timestamp is structurally required, so a bootstrap cannot become
    // a full historical import by omission.
    // @ts-expect-error the window union has no unbounded member
    expect(() => buildQuery({ window: { mode: "unbounded_backfill" } })).toThrow();
  });
});
