/**
 * Turning a staff row from the order-management directory into a CST agent
 * directory entry.
 *
 * PURE. No network, no database, no clock. Every decision this file makes is a
 * decision about MEANING — what counts as a name, what counts as still
 * employed — and those are the two things worth testing in isolation and worth
 * arguing about in review. The transport is somewhere else.
 *
 * ------------------------------------------------------------------------
 * IT NEVER INVENTS A NAME
 * ------------------------------------------------------------------------
 * `display_name` is NOT NULL in `cst_app.agent_directory`, so a row with no
 * usable name cannot be stored. The temptation is to fill it — "User 241",
 * "Unknown", the username, an email local-part. Every one of those puts a
 * string that is not a person's name into a column a dashboard prints next to
 * their numbers.
 *
 * So this returns a REJECTION instead, and the importer reports it. An agent
 * missing from the directory is visible and fixable at source; an agent called
 * "Unknown 241" looks like a person and never gets fixed.
 *
 * ------------------------------------------------------------------------
 * UNKNOWN STATUS IS TREATED AS INACTIVE, DELIBERATELY
 * ------------------------------------------------------------------------
 * The source vocabulary is inconsistent — `Active` (201), `Remove` (30),
 * `Removed` (2) and one NULL — so a value this file has not seen before is a
 * real possibility rather than a hypothetical.
 *
 * The conservative direction is `active = false`. Wrongly marking a current
 * employee inactive is a visible, complained-about, one-line fix. Wrongly
 * marking a departed one active is invisible, and it is the direction that
 * keeps somebody in a staff list after they have gone.
 *
 * The raw value is preserved in `source_status` either way, and
 * `statusRecognised` tells the importer to report the row rather than swallow
 * it. Falling back quietly is what makes a vocabulary change undetectable.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ------------------------------------------------------------------------
 * No password, token, verification code, email, phone, gender, branch or
 * image. This module cannot leak them because it never receives them: the
 * reader selects four columns.
 */

/** The only directory this schema accepts. Mirrors ck_agent_directory_source_system. */
export const ORDER_MANAGEMENT = "order_management" as const;

/** One staff row, exactly the four columns the reader selects. */
export type SourceStaffRow = {
  readonly sourceUserId: number;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly status: string | null;
};

/** One row ready for `cst_app.agent_directory`. `synced_at` is the writer's. */
export type DirectoryEntry = {
  readonly sourceSystem: typeof ORDER_MANAGEMENT;
  readonly sourceUserId: number;
  readonly displayName: string;
  readonly active: boolean;
  readonly sourceStatus: string | null;
};

export type MappedStaff =
  | {
      readonly ok: true;
      readonly entry: DirectoryEntry;
      /** False when the status was absent or a value this file does not know. */
      readonly statusRecognised: boolean;
    }
  | {
      readonly ok: false;
      readonly sourceUserId: number;
      /** The only reason a row can be rejected: there is no name to store. */
      readonly reason: "no_display_name";
    };

/** Statuses meaning "still here". Compared case-insensitively, trimmed. */
const ACTIVE_STATUSES = new Set(["active"]);

/**
 * Statuses meaning "gone". BOTH SPELLINGS ARE REAL — `Remove` (30 rows) and
 * `Removed` (2). Listing only one would send 2 people down the unknown path and
 * reach the same answer for the wrong reason, hiding a vocabulary the directory
 * actually uses.
 */
const INACTIVE_STATUSES = new Set(["remove", "removed", "inactive", "disabled"]);

function clean(value: string | null): string {
  return value?.trim() ?? "";
}

/**
 * The name to print, or null when there is not one.
 *
 * First name is required: it is the part that identifies a person. A surname
 * alone ("digitweb", and it really is `digitweb` on several rows) is not a
 * name anybody would recognise.
 *
 * FIRST AND LAST ARE COLLAPSED WHEN THEY MATCH. The directory genuinely stores
 * `Sanju / Sanju` and `danujan / danujan`, and "Sanju Sanju" is a stutter, not
 * a fuller name. Collapsing is not inventing — it removes a duplicate the
 * source supplied twice. Compared case-insensitively so `Rakesh / rakesh`
 * collapses too.
 */
export function displayNameOf(row: SourceStaffRow): string | null {
  const first = clean(row.firstName);
  if (first === "") return null;

  const last = clean(row.lastName);
  if (last === "" || last.toLowerCase() === first.toLowerCase()) return first;

  return `${first} ${last}`;
}

/**
 * Whether this status means the person is still with the business, and whether
 * the value was one we recognise.
 */
export function activeFromStatus(status: string | null): {
  readonly active: boolean;
  readonly recognised: boolean;
} {
  const normalised = clean(status).toLowerCase();
  if (ACTIVE_STATUSES.has(normalised)) return { active: true, recognised: true };
  if (INACTIVE_STATUSES.has(normalised)) return { active: false, recognised: true };
  // Unknown or absent. Conservative, and reported — see the module header.
  return { active: false, recognised: false };
}

/** Maps one source row. Rejects rather than guessing when there is no name. */
export function mapStaffRow(row: SourceStaffRow): MappedStaff {
  const displayName = displayNameOf(row);
  if (displayName === null) {
    return { ok: false, sourceUserId: row.sourceUserId, reason: "no_display_name" };
  }

  const { active, recognised } = activeFromStatus(row.status);

  return {
    ok: true,
    statusRecognised: recognised,
    entry: {
      sourceSystem: ORDER_MANAGEMENT,
      sourceUserId: row.sourceUserId,
      displayName,
      active,
      // Verbatim, including its original casing and any leading space. This is
      // the evidence for `active`; normalising it would destroy the thing it
      // exists to show.
      sourceStatus: row.status,
    },
  };
}
