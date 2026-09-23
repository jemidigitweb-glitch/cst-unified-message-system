import { describe, expect, it } from "vitest";

import {
  ORDER_MANAGEMENT,
  activeFromStatus,
  displayNameOf,
  mapStaffRow,
  type SourceStaffRow,
} from "@/lib/domain/agent-directory";

/**
 * The two decisions the staff import makes: what counts as a name, and what
 * counts as still employed. Pure functions, no database.
 *
 * Every fixture below is a shape observed in `order_management.user` (234 rows,
 * ids 1-256) rather than an invented one — including the duplicated
 * first/last names and both spellings of the removal status.
 */

const row = (over: Partial<SourceStaffRow> = {}): SourceStaffRow => ({
  sourceUserId: 43,
  firstName: "mathusha",
  lastName: "digitweb",
  status: "Active",
  ...over,
});

describe("displayNameOf", () => {
  it("joins first and last name", () => {
    expect(displayNameOf(row())).toBe("mathusha digitweb");
  });

  /**
   * The directory really stores `Sanju / Sanju` (id 20) and
   * `danujan / danujan` (id 113). "Sanju Sanju" is a stutter the source
   * supplied twice, not a fuller name.
   */
  it("collapses a last name identical to the first", () => {
    expect(displayNameOf(row({ firstName: "Sanju", lastName: "Sanju" }))).toBe("Sanju");
  });

  it("collapses case-insensitively", () => {
    expect(displayNameOf(row({ firstName: "Rakesh", lastName: "rakesh" }))).toBe("Rakesh");
  });

  it("uses the first name alone when the last is absent or blank", () => {
    expect(displayNameOf(row({ lastName: null }))).toBe("mathusha");
    expect(displayNameOf(row({ lastName: "   " }))).toBe("mathusha");
  });

  it("trims surrounding whitespace", () => {
    expect(displayNameOf(row({ firstName: "  Nyasha ", lastName: " Digitweb  " }))).toBe("Nyasha Digitweb");
  });

  /**
   * A surname alone is not a name anybody would recognise — and on this data it
   * is frequently the literal string "digitweb".
   */
  it("has no name when the first name is missing or blank", () => {
    expect(displayNameOf(row({ firstName: null }))).toBeNull();
    expect(displayNameOf(row({ firstName: "" }))).toBeNull();
    expect(displayNameOf(row({ firstName: "   ", lastName: "digitweb" }))).toBeNull();
  });
});

describe("activeFromStatus", () => {
  it("treats Active as active", () => {
    expect(activeFromStatus("Active")).toEqual({ active: true, recognised: true });
  });

  /** BOTH spellings are real: `Remove` (30 rows) and `Removed` (2). */
  it.each(["Remove", "Removed", "remove", "REMOVED", " Removed "])(
    "treats %s as inactive and recognised",
    (status) => {
      expect(activeFromStatus(status)).toEqual({ active: false, recognised: true });
    },
  );

  it("is case- and whitespace-insensitive for active", () => {
    expect(activeFromStatus("  active ")).toEqual({ active: true, recognised: true });
  });

  /**
   * CONSERVATIVE, AND REPORTED. Marking a current employee inactive is a
   * visible one-line fix; marking a departed one active is invisible.
   */
  it.each([null, "", "   ", "Suspended", "On Leave", "???"])(
    "treats %s as inactive and NOT recognised",
    (status) => {
      expect(activeFromStatus(status)).toEqual({ active: false, recognised: false });
    },
  );
});

describe("mapStaffRow", () => {
  it("maps an active person to a full entry", () => {
    const result = mapStaffRow(row({ sourceUserId: 43 }));
    expect(result).toEqual({
      ok: true,
      statusRecognised: true,
      entry: {
        sourceSystem: ORDER_MANAGEMENT,
        sourceUserId: 43,
        displayName: "mathusha digitweb",
        active: true,
        sourceStatus: "Active",
      },
    });
  });

  /**
   * ID PRESERVATION. The source id is what `agent_activity.source_user_id`
   * refers to; a re-numbered directory would silently re-attribute work.
   */
  it.each([1, 7, 22, 43, 174, 210, 241, 248, 256])("preserves source id %i exactly", (id) => {
    const result = mapStaffRow(row({ sourceUserId: id }));
    expect(result.ok && result.entry.sourceUserId).toBe(id);
  });

  /**
   * Departed staff must still be importable: id 174 (gnanatheepan) has 14,734
   * recorded actions and status `Remove`. Dropping them would make that work
   * anonymous.
   */
  it("keeps a removed person, marked inactive", () => {
    const result = mapStaffRow(row({ sourceUserId: 174, firstName: "gnanatheepan", status: "Remove" }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.active).toBe(false);
    expect(result.ok && result.entry.displayName).toBe("gnanatheepan digitweb");
  });

  it("preserves the raw status verbatim as evidence for `active`", () => {
    const result = mapStaffRow(row({ status: " Removed " }));
    expect(result.ok && result.entry.sourceStatus).toBe(" Removed ");
    expect(result.ok && result.entry.active).toBe(false);
  });

  it("keeps a NULL status as null rather than inventing a value", () => {
    const result = mapStaffRow(row({ status: null }));
    expect(result.ok && result.entry.sourceStatus).toBeNull();
    expect(result.ok && result.statusRecognised).toBe(false);
  });

  /** Reports, never invents. There is no "User 241" fallback anywhere. */
  it("rejects a row with no usable name instead of naming it", () => {
    const result = mapStaffRow(row({ sourceUserId: 99, firstName: null }));
    expect(result).toEqual({ ok: false, sourceUserId: 99, reason: "no_display_name" });
  });

  it("always stamps the one directory the schema accepts", () => {
    const result = mapStaffRow(row());
    expect(result.ok && result.entry.sourceSystem).toBe("order_management");
  });

  /** No credential or contact field can appear on an entry. */
  it("produces exactly five fields and no personal data", () => {
    const result = mapStaffRow(row());
    expect(result.ok && Object.keys(result.entry).sort()).toEqual(
      ["active", "displayName", "sourceStatus", "sourceSystem", "sourceUserId"],
    );
  });
});
