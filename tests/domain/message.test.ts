import { describe, expect, it } from "vitest";

import {
  MESSAGE_ORDERING,
  SOURCE_TIMEZONE_CONFIRMED,
  alignmentFor,
  sourceMessageKeyOf,
} from "@/lib/domain/message";

describe("message direction (neutral)", () => {
  it("renders customer messages left and previous CST replies right", () => {
    expect(alignmentFor("inbound")).toBe("left");
    expect(alignmentFor("outbound")).toBe("right");
  });
});

describe("message ordering (neutral)", () => {
  it("sorts by source timestamp with the source PK only as a tiebreaker", () => {
    expect(MESSAGE_ORDERING).toEqual({
      primary: "source_timestamp",
      primaryDirection: "asc",
      tiebreaker: "source_pk",
      tiebreakerDirection: "asc",
    });
  });

  it("expresses ordering as intent, not as marketplace-specific SQL", () => {
    const serialised = JSON.stringify(MESSAGE_ORDERING).toLowerCase();
    expect(serialised).not.toContain("receive_date");
    expect(serialised).not.toContain("order by");
  });
});

describe("source message identity", () => {
  it("builds a key from the full source coordinates", () => {
    expect(
      sourceMessageKeyOf({
        sourceDatabase: "srcdb",
        sourceSchema: "srcschema",
        sourceTable: "srctable",
        sourcePk: "42",
      }),
    ).toBe("srcdb.srcschema.srctable.42");
  });

  it("distinguishes the same PK in different source tables", () => {
    const base = { sourceDatabase: "d", sourceSchema: "s", sourcePk: "1" };
    expect(sourceMessageKeyOf({ ...base, sourceTable: "a" })).not.toBe(
      sourceMessageKeyOf({ ...base, sourceTable: "b" }),
    );
  });
});

describe("source timestamps", () => {
  it("stays unconverted until the ingestion owner confirms the timezone", () => {
    expect(SOURCE_TIMEZONE_CONFIRMED).toBe(false);
  });
});
