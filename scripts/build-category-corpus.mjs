/**
 * Builds the CST category corpus — command line entry point.
 *
 *   node scripts/build-category-corpus.mjs            report only, write nothing
 *   node scripts/build-category-corpus.mjs --write    regenerate the corpus module
 *
 * WHY A BUILD STEP AND NOT A RUNTIME PARSE. Classifying an inbox message must be
 * local, deterministic and fast; reading eleven spreadsheets to answer "what
 * category is this" would be none of those. So the workbooks are read ONCE, here,
 * and the result is committed as plain TypeScript that the classifier imports
 * like any other module. Re-run this after a workbook changes and commit the
 * diff — the corpus test fails loudly if the two ever drift apart.
 *
 * READ-ONLY. This opens the workbooks, reads them, and writes one file inside
 * `lib/knowledge/`. It never writes a workbook and never opens a database.
 *
 * THE ELEVEN CATEGORY SOURCES ONLY. `B2B  customers .xlsx` is customer data and
 * is never opened here. `MESSAGE HANDLING RULES .xlsx` and `Message rules
 * final.xlsx` are handling guidance and an index — neither defines a top-level
 * inbox category — and are not read either.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const SOURCE_DIR = join(ROOT, "Knowledge-source");
const TARGET = join(ROOT, "lib/knowledge/cst-category-corpus.ts");
const WRITE = process.argv.includes("--write");

const { readWorkbook } = await import(pathToFileURL(join(ROOT, "lib/knowledge/workbook-reader.ts")));

/* ------------------------------------------------------------------------- *
 * THE APPROVED SOURCES
 * ------------------------------------------------------------------------- */

/** Workbook file name -> the inbox category it is the authority for. */
const CATEGORY_BY_FILE = [
  ["Delivery_Master_Rules final.xlsx", "Delivery queries"],
  ["PRE-SALES QUERIES.xlsx", "Pre sales queries"],
  ["ADMIN.xlsx", "Admin related issues"],
  ["ORDER BEFORRE SHIPPING And cancelation .xlsx", "Order change, before shipping queries"],
  ["DEFECTIVE .xlsx", "Defective items"],
  ["DAMAGE DECISION GUIDE.xlsx", "Damage queries"],
  ["Wrong item sent  final.xlsx", "Wrong item sent messages"],
  ["missing parts query .xlsx", "Parts missing queries"],
  ["wrong quantity.xlsx", "Wrong quantity sent issues"],
  ["WRONG DESCRIPTION.xlsx", "Wrong description issues"],
  ["RETURNS & REFUNDS — COMPLETE CASE HANDLING MASTER SHEET    final.xlsx", "Return and refunds"],
];

/** Never read for category evidence, and why. Reported so a gap is visible. */
const NOT_A_CATEGORY_SOURCE = [
  ["B2B  customers .xlsx", "Customer account list — customer data, not category rules."],
  ["MESSAGE HANDLING RULES .xlsx", "Handling and tone guidance. Defines no inbox category."],
  ["Message rules final.xlsx", "Index of links to the other workbooks. No rule text of its own."],
];

/* ------------------------------------------------------------------------- *
 * READING THE SHEETS
 * ------------------------------------------------------------------------- */

const clean = (v) => (v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const hdrNorm = (v) => clean(v).replace(/^[\s✅❌⚠🟢🔴🚫🔑📋📦→·•—\-]+/u, "").toLowerCase();

function findHeader(grid, tokens) {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const cells = (grid[r] ?? []).map(hdrNorm);
    if (cells.filter((c) => c !== "").length < 3) continue;
    if (tokens.every((t) => cells.some((c) => t.test(c)))) return { row: r, cells };
  }
  return undefined;
}

function colOf(header, ...patterns) {
  for (const pattern of patterns) {
    const index = header.cells.findIndex((cell) => cell !== "" && pattern.test(cell));
    if (index !== -1) return index;
  }
  return -1;
}

const at = (row, index) => (index < 0 ? "" : clean(row?.[index]));

/**
 * Splits a trigger cell into the individual customer phrases it lists.
 *
 * These cells are written as newline, bullet or slash separated lists, and the
 * comma rule is deliberately narrow: a comma only splits when what follows looks
 * like the start of a new phrase, because "I ordered 2, only 1 arrived" is one
 * phrase and splitting it would leave two meaningless fragments.
 */
function splitPhrases(value) {
  return clean(value)
    .split(/\r?\n|[;|•·]|,(?=\s*["“']?\p{L})|(?:^|\s)\/(?=\s)/gu)
    .map((part) =>
      part
        .replace(/^[\s✅❌⚠🟢🔴🚫🔑📋📦→·•—\-]+/u, "")
        .replace(/^["“”'']+|["“”'']+$/g, "")
        .trim(),
    )
    .filter((part) => part.length >= 3 && part.length <= 120);
}

/** Every category-evidence row the eleven workbooks yield, in document order. */
function readCorpus() {
  const rules = [];
  const sheetsSeen = [];

  for (const [file, category] of CATEGORY_BY_FILE) {
    const workbook = readWorkbook(readFileSync(join(SOURCE_DIR, file)));
    for (const [sheet, grid] of workbook) {
      const before = rules.length;

      // Shape 1: a scenario table — SCENARIO_ID / CATEGORY_ID / ID plus a
      // situation column and a trigger-keyword column.
      let header = findHeader(grid, [/^(scenario_id|category_id|id)$/, /situation|sub-case/]);
      if (header && colOf(header, /trigger keyword|trigger phrase/) >= 0) {
        const idAt = colOf(header, /^(scenario_id|category_id|id)$/);
        const situationAt = colOf(header, /situation|sub-case/);
        const triggerAt = colOf(header, /trigger keyword|trigger phrase/);
        const conditionAt = colOf(
          header,
          /conditions.*when to use/,
          /classification/,
          /root cause/,
          /key rule|action rule|discount rule|label rule|platform rules|rules & notes|notes/,
        );
        for (let r = header.row + 1; r < grid.length; r++) {
          const row = grid[r] ?? [];
          if (row.filter((cell) => clean(cell) !== "").length < 2) continue;
          const situation = at(row, situationAt);
          const phrases = splitPhrases(at(row, triggerAt));
          if (situation === "" && phrases.length === 0) continue;
          rules.push({
            kind: "scenario",
            category,
            file,
            sheet,
            row: r + 1,
            id: at(row, idAt) || `${sheet} row ${r + 1}`,
            name: situation,
            phrases,
            condition: at(row, conditionAt),
            route: "",
            priority: "",
          });
        }
        sheetsSeen.push({ file, sheet, shape: "scenario", rows: rules.length - before });
        continue;
      }

      // Shape 2: an intent map — INTENT_ID / intent category / customer trigger
      // phrases / route / priority.
      header = findHeader(grid, [/^intent_id$/, /trigger phrase/]);
      if (header) {
        const idAt = colOf(header, /^intent_id$/);
        const nameAt = colOf(header, /intent category|^category$/);
        const phraseAt = colOf(header, /trigger phrase/);
        const routeAt = colOf(header, /^route to/);
        const priorityAt = colOf(header, /^priority$/);
        for (let r = header.row + 1; r < grid.length; r++) {
          const row = grid[r] ?? [];
          if (row.filter((cell) => clean(cell) !== "").length < 2) continue;
          const phrases = splitPhrases(at(row, phraseAt));
          if (phrases.length === 0) continue;
          rules.push({
            kind: "intent",
            category,
            file,
            sheet,
            row: r + 1,
            id: at(row, idAt) || `${sheet} row ${r + 1}`,
            name: at(row, nameAt),
            phrases,
            condition: "",
            route: at(row, routeAt),
            priority: at(row, priorityAt),
          });
        }
        sheetsSeen.push({ file, sheet, shape: "intent", rows: rules.length - before });
        continue;
      }

      // Shape 3: the damage decision matrix, which has no INTENT_ID at all —
      // its identity is the sheet, the damage type and what the customer says.
      header = findHeader(grid, [/^damage type$/, /customer typically says/]);
      if (header) {
        const typeAt = colOf(header, /^damage type$/);
        const saysAt = colOf(header, /customer typically says/);
        const severityAt = colOf(header, /^severity$/);
        const safetyAt = colOf(header, /safety risk/);
        const workingAt = colOf(header, /working status/);
        for (let r = header.row + 1; r < grid.length; r++) {
          const row = grid[r] ?? [];
          if (row.filter((cell) => clean(cell) !== "").length < 2) continue;
          const damageType = at(row, typeAt);
          if (damageType === "") continue;
          rules.push({
            kind: "damage",
            category,
            file,
            sheet,
            row: r + 1,
            id: `${sheet} row ${r + 1}`,
            name: damageType,
            phrases: splitPhrases(at(row, saysAt)),
            condition: [
              at(row, severityAt),
              at(row, safetyAt) && `safety risk: ${at(row, safetyAt)}`,
              at(row, workingAt) && `working: ${at(row, workingAt)}`,
            ]
              .filter(Boolean)
              .join(" · "),
            route: "",
            priority: "",
          });
        }
        sheetsSeen.push({ file, sheet, shape: "damage", rows: rules.length - before });
        continue;
      }

      sheetsSeen.push({ file, sheet, shape: "none", rows: 0 });
    }
  }
  return { rules, sheetsSeen };
}

/* ------------------------------------------------------------------------- *
 * ROUTING ROLE
 *
 * THE FINDING THIS ENCODES. Most of what these workbooks call a "trigger" is not
 * a reason to choose a category. It is a fact about a case whose category is
 * already known — the customer wants a refund, sent a photo, has an electrician
 * waiting, refuses to send images, accepted a discount. Reading all of them as
 * category evidence is how "please refund me" became a Wrong Item case and how
 * the Returns workbook's seller-fault vocabulary ("damaged", "missing part",
 * "wrong item") stole cases from the four categories that own those problems.
 *
 * So every row gets a role, and only PRIMARY_ISSUE may propose a category.
 * ------------------------------------------------------------------------- */

const ROLES = [
  "PRIMARY_ISSUE",
  "SECONDARY_REMEDY",
  "SECONDARY_CONTEXT",
  "INTERNAL_SCENARIO",
  "RESOLUTION_CONFIRMATION",
  "INTERNAL_ONLY",
  "AMBIGUOUS_CATCHALL",
];

/**
 * Roles assigned to a named intent row, with the reason.
 *
 * Keyed by INTENT_ID because that is the identity the workbook itself gives the
 * row. Anything not listed here is PRIMARY_ISSUE for its workbook's category —
 * the default is that a rule book's own scenarios describe its own cases.
 */
const ROLE_BY_ID = new Map([
  /* --- PRE-SALES ------------------------------------------------------- */
  ["INT-PS02", ["SECONDARY_CONTEXT", "Who the customer is, not what they are asking about."]],

  /* --- ADMIN ----------------------------------------------------------- */
  // Admin is the fallback category, and its two safety rows are the exception:
  // they are a genuine primary Admin matter (ADMIN.xlsx sheet D).

  /* --- ORDER CHANGE BEFORE SHIPPING ------------------------------------ */
  [
    "INT-OS08",
    [
      "INTERNAL_SCENARIO",
      "Restricted-price error: an internal cancellation the customer is never told the real reason for. Its triggers are delivery chases ('where is my parcel') and belong to Delivery.",
    ],
  ],

  /* --- DEFECTIVE ------------------------------------------------------- */
  [
    "INT-DF10",
    ["SECONDARY_CONTEXT", "The sheet's own note: 'most issues are NOT defects'. Wiring questions."],
  ],
  [
    "INT-DF12",
    ["SECONDARY_CONTEXT", "Physical damage and absent parts — owned by Damage and Parts missing."],
  ],
  ["INT-DF15", ["SECONDARY_CONTEXT", "Normal behaviour the customer is worried about. No fault claimed."]],
  ["INT-DF16", ["RESOLUTION_CONFIRMATION", "Customer confirms it works."]],
  ["INT-DF17", ["SECONDARY_REMEDY", "Wants a refund rather than a replacement."]],
  ["INT-DF18", ["SECONDARY_CONTEXT", "Warranty period is context; Returns owns the warranty claim."]],
  ["INT-DF20", ["AMBIGUOUS_CATCHALL", "'there is a problem', 'something is wrong'."]],

  /* --- WRONG ITEM SENT -------------------------------------------------- */
  ["INT-WI01", ["SECONDARY_CONTEXT", "Urgency. Says nothing about what arrived."]],
  ["INT-WI10", ["SECONDARY_CONTEXT", "Customer disputes a correct item — 'not what I expected', 'my mistake'."]],
  ["INT-WI12", ["SECONDARY_CONTEXT", "A photo was attached."]],
  ["INT-WI13", ["SECONDARY_CONTEXT", "Customer refuses photos."]],
  ["INT-WI14", ["SECONDARY_REMEDY", "Wants a refund."]],
  ["INT-WI15", ["SECONDARY_REMEDY", "Wants the correct item sent."]],
  ["INT-WI16", ["SECONDARY_CONTEXT", "A unit shortfall. Wrong quantity owns it."]],
  ["INT-WI17", ["INTERNAL_ONLY", "Flagged by a substitution record in the pick list, not by the customer."]],
  ["INT-WI20", ["AMBIGUOUS_CATCHALL", "'something seems wrong', 'I think there's a mistake'."]],

  /* --- PARTS MISSING ---------------------------------------------------- */
  ["INT-MP01", ["SECONDARY_CONTEXT", "Safety alongside a missing part. Admin sheet D owns safety."]],
  ["INT-MP02", ["SECONDARY_CONTEXT", "Urgency. Says nothing about what is absent."]],
  ["INT-MP03", ["SECONDARY_CONTEXT", "A photo was attached."]],
  ["INT-MP06", ["SECONDARY_REMEDY", "Wants a refund."]],
  ["INT-MP07", ["AMBIGUOUS_CATCHALL", "'I think something is missing', 'where is the', 'I was expecting'."]],
  ["INT-MP08", ["SECONDARY_CONTEXT", "Customer refuses photos."]],
  ["INT-MP09", ["SECONDARY_CONTEXT", "Already installed."]],
  ["INT-MP10", ["SECONDARY_CONTEXT", "Listing/instruction confusion. Wrong description owns a listing claim."]],
  ["INT-MP12", ["SECONDARY_CONTEXT", "Struggling to send images."]],
  ["INT-MP13", ["SECONDARY_CONTEXT", "Told the part is out of stock — a restock question."]],
  ["INT-MP14", ["RESOLUTION_CONFIRMATION", "The part arrived."]],
  ["INT-MP15", ["INTERNAL_ONLY", "Triggered by a timer, not by a customer phrase."]],
  ["INT-MP16", ["SECONDARY_CONTEXT", "Variation/SKU mismatch — Wrong item and Wrong description own these."]],
  ["INT-MP17", ["SECONDARY_CONTEXT", "Box damage. Delivery sheet 9.1 owns packaging."]],
  ["INT-MP18", ["SECONDARY_CONTEXT", "Goodwill appeal."]],
  ["INT-MP19", ["SECONDARY_CONTEXT", "Order verification."]],
  ["INT-MP20", ["AMBIGUOUS_CATCHALL", "'I have a problem', 'something is wrong'."]],

  /* --- WRONG QUANTITY --------------------------------------------------- */
  ["INT-WQ01", ["SECONDARY_CONTEXT", "Urgency."]],
  ["INT-WQ02", ["SECONDARY_CONTEXT", "Listing confusion — a listing claim belongs to Wrong description."]],
  ["INT-WQ07", ["SECONDARY_REMEDY", "Wants a refund."]],
  ["INT-WQ08", ["SECONDARY_REMEDY", "Wants a partial refund."]],
  ["INT-WQ09", ["SECONDARY_CONTEXT", "No images available."]],
  ["INT-WQ10", ["SECONDARY_CONTEXT", "Threatens a platform case."]],
  ["INT-WQ12", ["SECONDARY_REMEDY", "Accepted a discount."]],
  ["INT-WQ13", ["SECONDARY_REMEDY", "Wants the missing units sent."]],
  ["INT-WQ18", ["AMBIGUOUS_CATCHALL", "'something wrong with my order', 'not everything is here'."]],

  /* --- WRONG DESCRIPTION ------------------------------------------------ */
  ["INT-WD10", ["SECONDARY_REMEDY", "Wants a refund."]],
  ["INT-WD11", ["SECONDARY_REMEDY", "Accepted a discount."]],
  ["INT-WD12", ["SECONDARY_REMEDY", "Wants an exchange."]],
  ["INT-WD13", ["SECONDARY_CONTEXT", "Has no printer — return logistics."]],

  /* --- RETURNS & REFUNDS ------------------------------------------------ */
  // The single most important block in this table. The Returns workbook lists
  // every seller-fault problem as a return trigger, because inside the returns
  // workflow that is exactly what they are. At inbox level they belong to the
  // categories that own the problem.
  [
    "INT01",
    ["SECONDARY_CONTEXT", "Safety and legal wording raised inside a return. ADMIN.xlsx sheet D owns safety."],
  ],
  [
    "INT04",
    [
      "SECONDARY_CONTEXT",
      "Seller-fault return triggers: 'wrong item', 'damaged', 'broken', 'defective', 'missing part', 'not as described'. Each belongs to the category that owns the problem.",
    ],
  ],
  ["INT05", ["SECONDARY_CONTEXT", "Quality or safety raised mid-case."]],
  ["INT12", ["SECONDARY_CONTEXT", "Cancellation. Order change before shipping owns pre-dispatch cancellation."]],
  ["INT18", ["SECONDARY_CONTEXT", "Customer says they bought elsewhere."]],
  ["INT19", ["SECONDARY_REMEDY", "Accepted a discount."]],
  ["INT22", ["SECONDARY_CONTEXT", "Packaging disposed of."]],
  ["INT25", ["AMBIGUOUS_CATCHALL", "'I have a problem', 'can you help'."]],
  ["INT28", ["SECONDARY_CONTEXT", "Duplicate order. Order change before shipping owns it."]],
  ["INT30", ["SECONDARY_CONTEXT", "VAT and credit notes. ADMIN.xlsx sheet A owns invoices."]],
  ["INT31", ["SECONDARY_CONTEXT", "Pre-dispatch urgency. Order change before shipping owns it."]],
  ["INT-GAP13", ["SECONDARY_CONTEXT", "A partial return mixed with damage on the kept items."]],
  [
    "INT-COMP01",
    ["SECONDARY_REMEDY", "A demand for compensation above the purchase price. A remedy, not a problem."],
  ],
  // Recall is handled by the Returns workbook but categorised by ADMIN.xlsx
  // sheet D — SAFETY & RECALLS, which is where a customer asking "is this
  // product recalled?" belongs before any return exists.
  ...["INT-RC00", "INT-RC01", "INT-RC02", "INT-RC03", "INT-RC04", "INT-RC05", "INT-RC06", "INT-RC07", "INT-RC08"].map(
    (id) => [id, ["SECONDARY_CONTEXT", "Recall handling workflow. ADMIN.xlsx sheet D owns the recall category."]],
  ),

  /* --- RETURNS scenario rows, keyed by sheet ---------------------------- */
  [
    "09 SELLER RETURNS::SS1",
    [
      "SECONDARY_CONTEXT",
      "Seller-side first contact, fault not yet confirmed. Its phrases are the four problem categories verbatim — 'wrong item', 'damaged', 'broken', 'defective' — and each belongs to the category that owns the problem.",
    ],
  ],
  ["09 SELLER RETURNS::SS2", ["SECONDARY_REMEDY", "Wants a replacement."]],
  ["09 SELLER RETURNS::SS3", ["INTERNAL_SCENARIO", "An internal value threshold: replace rather than collect."]],
  ["09 SELLER RETURNS::SS4", ["SECONDARY_REMEDY", "Wants a refund."]],
  ["09 SELLER RETURNS::SS5", ["SECONDARY_REMEDY", "Accepted a partial refund."]],
  ["09 SELLER RETURNS::SS7", ["RESOLUTION_CONFIRMATION", "Return received, refund confirmed."]],
  ["09 SELLER RETURNS::SS12", ["SECONDARY_CONTEXT", "A partial return mixed with damage on the kept items."]],
  [
    "09 SELLER RETURNS::SS13",
    ["SECONDARY_CONTEXT", "Damage or a defect on one component. Damage and Defective own those."],
  ],
  ["11 WARRANTY::WR3", ["SECONDARY_CONTEXT", "Legal threats and safety wording. ADMIN.xlsx sheet D owns safety."]],
  ["17 SPECIAL SITUATIONS::SP2", ["SECONDARY_CONTEXT", "Duplicate order. Order change before shipping owns it."]],
  ["17 SPECIAL SITUATIONS::SP5", ["SECONDARY_CONTEXT", "VAT credit notes. ADMIN.xlsx sheet A owns invoices."]],

  /* --- PARTS MISSING scenario rows -------------------------------------- */
  ["3 — IMAGE PROVIDED::MP01", ["SECONDARY_CONTEXT", "The photo arrived. Says nothing about what is absent."]],
  ["4 — NO IMAGE YET::NI02", ["SECONDARY_CONTEXT", "Struggling to send images."]],
  ["4 — NO IMAGE YET::NI03", ["SECONDARY_CONTEXT", "Chasing the photo we asked for."]],

  /* --- WRONG QUANTITY scenario rows ------------------------------------- */
  ["5 — LISTING CONFUSION::WQ-C2", ["SECONDARY_CONTEXT", "Tone escalating. Says nothing new about the case."]],
  ["5 — LISTING CONFUSION::WQ-C3", ["SECONDARY_CONTEXT", "Who the customer is."]],
  ["4 — LISTING SKU ERROR::WQ-B2", ["SECONDARY_REMEDY", "Refuses a discount, wants the correct quantity."]],
  ["7 — NO IMAGE PROVIDED::WQ-E1", ["PRIMARY_ISSUE", "The customer reporting the shortfall, before any photo."]],

  /* --- DEFECTIVE scenario rows ------------------------------------------ */
  ["1 — PRE-CHECK::DF-PC1", ["AMBIGUOUS_CATCHALL", "First contact, before the fault is classified."]],
  [
    "4 — TRANSFORMERS & DRIVERS::DF-TR5",
    ["SECONDARY_CONTEXT", "A cooling fan running is normal behaviour the customer is worried about, not a fault."],
  ],
  [
    "9 — CABLES & CONNECTORS::DF-CB2",
    ["SECONDARY_CONTEXT", "Inner wires visible through a transparent cable is normal, not a fault."],
  ],
  ["8 — CEILING & WALL LIGHTS::DF-CL6", ["RESOLUTION_CONFIRMATION", "The customer confirms it works."]],

  /* --- WRONG ITEM scenario rows ------------------------------------------ */
  ["3 — SIMILAR ITEM USABLE::WI-A2", ["SECONDARY_REMEDY", "A discount was offered and accepted."]],
  [
    "4 — DIFFERENT ITEM UNUSABLE::WI-B2",
    ["SECONDARY_CONTEXT", "Already installed, packaging gone — about the return, not about what arrived."],
  ],

  /* --- WRONG DESCRIPTION scenario rows ----------------------------------- */
  [
    "9 — COLOUR CLAIMS::WD-G3",
    ["INTERNAL_SCENARIO", "The photo shows the colour matches. A verification outcome, not a customer claim."],
  ],
  ["INT-WD14", ["SECONDARY_CONTEXT", "Already installed. About the remedy, not the description."]],

  /* --- RETURNS scenario rows, continued ---------------------------------- */
  ["08 BUYER RETURNS::BS13", ["SECONDARY_CONTEXT", "Original packaging disposed of."]],
  [
    "10 AFTER 30 DAYS::BR3",
    ["SECONDARY_CONTEXT", "Safety and legal wording. ADMIN.xlsx sheet D owns safety."],
  ],
]);

/**
 * Roles assigned by sheet, for the scenario rows that carry no INTENT_ID.
 *
 * Matched against the sheet name with the workbook's category, most specific
 * first. A sheet not listed here keeps PRIMARY_ISSUE.
 */
const ROLE_BY_SHEET = [
  /* --- workbook-specific, and therefore FIRST -------------------------- */

  // Delivery.
  [/Delivery/, /9 – Damaged in Transit/i, "SECONDARY_CONTEXT", "Damage to the contents belongs to Damage queries. The packaging-only case is decided by the packaging/goods split in the classifier, not by this sheet claiming the word."],
  [/Delivery/, /17 – Partial Order Received/i, "SECONDARY_CONTEXT", "A short delivery is a quantity error. Wrong quantity owns it."],
  [/Delivery/, /18 – Urgent Deadline/i, "SECONDARY_CONTEXT", "Urgency alone is not a delivery case."],
  [/Delivery/, /24 – Refund Not Received/i, "SECONDARY_REMEDY", "A refund chase. Return and refunds owns it."],
  [/Delivery/, /25 – Replacement Not Arrived/i, "SECONDARY_CONTEXT", "Presupposes an open case."],
  [/Delivery/, /26 – Delivery Confirmed/i, "RESOLUTION_CONFIRMATION", "The parcel arrived."],

  // Wrong item sent.
  [/Wrong item/, /INTENTIONAL SUBSTITUTE/i, "INTERNAL_SCENARIO", "Decided by our own substitution record."],
  [/Wrong item/, /CORRECT ITEM DISPUTED/i, "SECONDARY_CONTEXT", "Records show the correct item was sent."],

  // Wrong description.
  [/WRONG DESCRIPTION/, /NO ERROR FOUND/i, "INTERNAL_SCENARIO", "Verification outcome, not a customer claim."],
  [/WRONG DESCRIPTION/, /HIGH VALUE NO PART/i, "INTERNAL_SCENARIO", "An internal value threshold."],

  // Parts missing. The LISTING SKU ERROR sheet stays PRIMARY: "the listing says
  // it includes a bracket and there is no bracket" is a missing-part case that
  // happens to have a listing cause, and Wrong description is separated from it
  // by requiring an asserted listing-vs-reality mismatch, not by demoting this.
  [/missing parts/, /NOT ACTUALLY MISSING/i, "AMBIGUOUS_CATCHALL", "The part may not be missing at all — 'I think something is missing', 'where is the'."],
  [/missing parts/, /PART UNAVAILABLE/i, "SECONDARY_CONTEXT", "Stock news about a part already agreed to be missing."],

  // Order change before shipping.
  [/ORDER BEFORRE/, /RESTRICTED-PRICE ERROR/i, "INTERNAL_SCENARIO", "Internal cancellation; never explained to the customer."],
  [/ORDER BEFORRE/, /REPEAT PURCHASE/i, "SECONDARY_CONTEXT", "Who the customer is."],

  // Returns. The refund engine and the label/logistics sheets are this
  // workbook's own primary cases and must not be caught by the generic
  // remedy rule below.
  [/RETURNS/, /REFUND ENGINE|LABEL & LOGISTICS|BUYER RETURNS|AFTER 30 DAYS|EBAY CASES|AMAZON CASES/i, "PRIMARY_ISSUE", "Return logistics and refund chases are Returns' own cases."],
  [/RETURNS/, /RC-A RECALL SCENARIOS/i, "SECONDARY_CONTEXT", "Recall handling. ADMIN.xlsx sheet D owns the recall category."],
  [/RETURNS/, /LEGAL REFUND RULES/i, "INTERNAL_ONLY", "Statutory entitlement table, not customer language."],
  [/RETURNS/, /18 PRE-DISPATCH QUERIES/i, "SECONDARY_CONTEXT", "Pre-dispatch amendment and cancellation. Order change before shipping owns them."],

  /* --- generic, applied to every workbook that reached this far -------- */

  [/.*/, /PRE-CHECK/i, "AMBIGUOUS_CATCHALL", "First contact, before the case is classified."],
  [/.*/, /FOLLOW-?UP|CLOSING/i, "RESOLUTION_CONFIRMATION", "The case is being closed."],
  [/.*/, /FLOW CHART|RULE ENGINE|ESCALATION MATRIX|VARIABLES|DEFINITIONS|MASTER|GLOSSARY|START HERE|STATE MACHINE|DEVELOPER|TEST CASES|GAP REGISTER|CHANGE LOG|CONFLICT|AUTHORITY|BLOS/i, "INTERNAL_ONLY", "Internal machinery, not customer language."],
  [/.*/, /REFUSES IMAGES|NO RESPONSE/i, "SECONDARY_CONTEXT", "About the evidence, not the case."],
  [/.*/, /WANTS REFUND|REFUND REQUESTED|CUSTOMER WANTS REFUND|REFUSES DISCOUNT/i, "SECONDARY_REMEDY", "The remedy asked for, not the problem."],
  [/.*/, /URGENT DEADLINE/i, "SECONDARY_CONTEXT", "Urgency. Says nothing about what went wrong."],
];

function roleOf(rule) {
  // A scenario id is only unique inside its sheet, so a scenario override is
  // keyed by both. An INTENT_ID is unique in its workbook and is keyed alone.
  const byId = ROLE_BY_ID.get(`${rule.sheet}::${rule.id}`) ?? ROLE_BY_ID.get(rule.id);
  if (byId) return { role: byId[0], why: byId[1] };

  // An explicitly internal row, however it is labelled.
  if (rule.phrases.some((phrase) => /^INTERNAL\b|INTERNAL (USE )?ONLY|triggered by (a )?timer/i.test(phrase))) {
    return { role: "INTERNAL_ONLY", why: "The row says so: no customer phrase." };
  }
  if (/INTERNAL ONLY/i.test(rule.condition)) {
    return { role: "INTERNAL_ONLY", why: "Condition marks the row internal." };
  }

  for (const [filePattern, sheetPattern, role, why] of ROLE_BY_SHEET) {
    if (filePattern.test(rule.file) && sheetPattern.test(rule.sheet)) return { role, why };
  }
  return { role: "PRIMARY_ISSUE", why: "A scenario its own workbook owns." };
}

/* ------------------------------------------------------------------------- *
 * EMIT
 * ------------------------------------------------------------------------- */

const { rules, sheetsSeen } = readCorpus();
for (const rule of rules) {
  const { role, why } = roleOf(rule);
  rule.role = role;
  rule.roleReason = why;
}

const quote = (value) => JSON.stringify(value);

function emit() {
  const lines = [];
  lines.push(`/**
 * THE CST CATEGORY CORPUS — GENERATED. DO NOT EDIT BY HAND.
 *
 *   node scripts/build-category-corpus.mjs --write
 *
 * Every category-evidence row the eleven approved category workbooks contain,
 * with its provenance, the customer language the business wrote against it, the
 * conditions the workbook states, and the routing role that decides whether it
 * may propose an inbox category at all.
 *
 * WHY IT IS COMMITTED RATHER THAN PARSED. Classification is local, deterministic
 * and on the read path of every conversation in the inbox. Reading eleven
 * spreadsheets per message would be none of those things. The workbooks stay the
 * authority; this is their reviewed, reproducible projection.
 *
 * ROLES, AND WHY THEY EXIST. Most rows in these books are triggers for a case
 * whose category is ALREADY KNOWN — the customer wants a refund, attached a
 * photo, has an electrician waiting, refuses images, accepted a discount. Read
 * as category evidence they steal cases: the Returns workbook lists "damaged",
 * "missing part" and "wrong item" because those are reasons to accept a return,
 * not because a damaged item is a returns case. Only PRIMARY_ISSUE may propose.
 */

/** What a row is allowed to do in classification. */
export type RuleRole =
  /** Describes the problem itself. The only role that may propose a category. */
  | "PRIMARY_ISSUE"
  /** The remedy asked for: refund, replacement, exchange, collection, label. */
  | "SECONDARY_REMEDY"
  /** A fact about the case: photos, urgency, disposal, already installed. */
  | "SECONDARY_CONTEXT"
  /** A situation decided by our own records rather than by the customer. */
  | "INTERNAL_SCENARIO"
  /** The customer confirming the case is over. */
  | "RESOLUTION_CONFIRMATION"
  /** Machinery — rule engines, escalation matrices, timers, legal tables. */
  | "INTERNAL_ONLY"
  /** "Something is wrong." True of every category, so evidence for none. */
  | "AMBIGUOUS_CATCHALL";

export type CorpusRule = {
  /** INTENT_ID, SCENARIO_ID or CATEGORY_ID as the workbook writes it. */
  readonly id: string;
  /** The inbox category this rule's workbook is the authority for. */
  readonly category: string;
  readonly file: string;
  readonly sheet: string;
  /** 1-based row, as a person reading the sheet would count it. */
  readonly row: number;
  /** The row's own name: intent category, situation, or damage type. */
  readonly name: string;
  /** Customer language, exactly as the workbook lists it. */
  readonly phrases: readonly string[];
  /** The workbook's own "Conditions — When to Use" or equivalent. */
  readonly condition: string;
  readonly route: string;
  readonly priority: string;
  readonly role: RuleRole;
  /** Why this role, in one line. Written for a reviewer, not for the machine. */
  readonly roleReason: string;
};

/** The eleven approved category workbooks, and the category each one owns. */
export const CATEGORY_SOURCES: readonly (readonly [string, string])[] = [`);
  for (const [file, category] of CATEGORY_BY_FILE) lines.push(`  [${quote(file)}, ${quote(category)}],`);
  lines.push(`];

/** Workbooks deliberately not read for category evidence, and why. */
export const NOT_CATEGORY_SOURCES: readonly (readonly [string, string])[] = [`);
  for (const [file, why] of NOT_A_CATEGORY_SOURCE) lines.push(`  [${quote(file)}, ${quote(why)}],`);
  lines.push(`];

export const CST_CATEGORY_CORPUS: readonly CorpusRule[] = [`);
  for (const rule of rules) {
    lines.push(`  {`);
    lines.push(`    id: ${quote(rule.id)},`);
    lines.push(`    category: ${quote(rule.category)},`);
    lines.push(`    file: ${quote(rule.file)},`);
    lines.push(`    sheet: ${quote(rule.sheet)},`);
    lines.push(`    row: ${rule.row},`);
    lines.push(`    name: ${quote(rule.name)},`);
    lines.push(
      rule.phrases.length === 0
        ? `    phrases: [],`
        : `    phrases: [${rule.phrases.map(quote).join(", ")}],`,
    );
    lines.push(`    condition: ${quote(rule.condition)},`);
    lines.push(`    route: ${quote(rule.route)},`);
    lines.push(`    priority: ${quote(rule.priority)},`);
    lines.push(`    role: ${quote(rule.role)},`);
    lines.push(`    roleReason: ${quote(rule.roleReason)},`);
    lines.push(`  },`);
  }
  lines.push(`];`);
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * REPORT
 * ------------------------------------------------------------------------- */

const byCategory = new Map();
const byRole = new Map();
for (const rule of rules) {
  const c = byCategory.get(rule.category) ?? { rows: 0, phrases: 0, primary: 0 };
  c.rows += 1;
  c.phrases += rule.phrases.length;
  if (rule.role === "PRIMARY_ISSUE") c.primary += 1;
  byCategory.set(rule.category, c);
  byRole.set(rule.role, (byRole.get(rule.role) ?? 0) + 1);
}

console.log(`rows: ${rules.length}   phrases: ${rules.reduce((n, r) => n + r.phrases.length, 0)}`);
console.log("\nper category:");
for (const [category, c] of byCategory) {
  console.log(`  ${category.padEnd(38)} rows=${String(c.rows).padStart(3)} primary=${String(c.primary).padStart(3)} phrases=${c.phrases}`);
}
console.log("\nper role:");
for (const role of ROLES) console.log(`  ${role.padEnd(24)} ${byRole.get(role) ?? 0}`);
const unmatched = sheetsSeen.filter((s) => s.shape === "none");
console.log(`\nsheets read: ${sheetsSeen.length}, of which no recognised evidence table: ${unmatched.length}`);

if (WRITE) {
  writeFileSync(TARGET, emit(), "utf8");
  console.log(`\nwrote ${TARGET}`);
} else {
  console.log("\n(dry run — pass --write to regenerate the corpus module)");
}
