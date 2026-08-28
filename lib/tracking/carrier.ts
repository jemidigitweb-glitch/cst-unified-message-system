/**
 * Which carrier a shipment is with, from what the source system actually stored.
 *
 * WHY THIS EXISTS AT ALL. `carrier_service.carrier` is not a carrier id — it is
 * whatever the shipping integration wrote, and it is inconsistent in ways no
 * caller should have to know about. Measured across 1,137,479 live shipments,
 * Royal Mail alone is stored under FOUR different strings:
 *
 *   Royal Mail 48          88,079 shipments
 *   Royal Mail             82,070
 *   Royal Mail 1st Class   42,372
 *   Royal Mail 24           1,644
 *
 * Those are service levels, not different companies. A tracking provider keyed
 * on the raw string would answer for one of them and silently fail the other
 * three. The same pattern repeats: Evri also appears as its former name
 * Hermes, GLS as "gls" and "gls international", UPS as "UPS" and "UPS Express",
 * Parcelforce as "parcel force".
 *
 * IT REFUSES RATHER THAN GUESSES. An unrecognised string returns `null`, not a
 * nearest match. The whole point of a verified-context layer is that a fact is
 * either established or absent, and asking Royal Mail about a DPD consignment
 * would produce a confident answer about the wrong parcel.
 *
 * PURE. No network, no database, no clock.
 */

/**
 * The carriers this system can name.
 *
 * Every entry is a real carrier in the shipment data, ordered by volume. This
 * is a naming vocabulary, NOT a statement that tracking is available for each —
 * whether any given carrier can be queried is a provider's business, and today
 * none can.
 */
export const CARRIERS = [
  "evri",
  "dhl",
  "amazon_logistics",
  "royal_mail",
  "gls",
  "dpd",
  "etrak",
  "ups",
  "parcelforce",
  "canada_post",
  "usps",
  "fedex",
  "yodel",
  "colissimo",
] as const;

export type Carrier = (typeof CARRIERS)[number];

/** A carrier's name as a person would write it, for display and for prompts. */
export const CARRIER_LABELS: Readonly<Record<Carrier, string>> = {
  evri: "Evri",
  dhl: "DHL",
  amazon_logistics: "Amazon Logistics",
  royal_mail: "Royal Mail",
  gls: "GLS",
  dpd: "DPD",
  etrak: "Etrak",
  ups: "UPS",
  parcelforce: "Parcelforce",
  canada_post: "Canada Post",
  usps: "USPS",
  fedex: "FedEx",
  yodel: "Yodel",
  colissimo: "Colissimo",
};

/**
 * How a stored string is recognised.
 *
 * Written as an explicit, ordered, reviewable table rather than as fuzzy
 * matching. Each pattern was checked against the 29 distinct `carrier` values
 * in the live shipment data, and the comment on each names what it is there to
 * catch — so a reader can tell a deliberate alias from an accident.
 *
 * ORDER MATTERS. `amazon` is tested before the bare-word carriers because
 * "Amazon Logistics Europe" contains no other carrier name, but a future
 * "Amazon UPS" style string would otherwise resolve to UPS.
 */
const RECOGNISED: readonly (readonly [Carrier, RegExp])[] = [
  // "Amazon Logistics Europe", "Amazon Shipping".
  ["amazon_logistics", /\bamazon\b/i],
  // "Royal Mail", "Royal Mail 48", "Royal Mail 24", "Royal Mail 1st Class",
  // and the service names that spell it as one word.
  ["royal_mail", /\broyal\s*mail\b|\brorayalmail\b|\broyalmail\b/i],
  // "Evri", and "Hermes" — the same company before the 2022 rename. Both are
  // still present in the data, so both must resolve to one carrier.
  ["evri", /\bevri\b|\bhermes\b/i],
  ["dhl", /\bdhl\b/i],
  // "gls" and "gls international".
  ["gls", /\bgls\b/i],
  ["dpd", /\bdpd\b/i],
  ["etrak", /\betrak\b/i],
  // "parcel force" is stored with a space; the company spells it as one word.
  ["parcelforce", /\bparcel\s*force\b/i],
  // "UPS" and "UPS Express". Bounded so it cannot match inside another word.
  ["ups", /\bups\b/i],
  ["canada_post", /\bcanada\s*post\b/i],
  ["usps", /\busps\b/i],
  ["fedex", /\bfedex\b|\bfed\s+ex\b/i],
  ["yodel", /\byodel\b/i],
  ["colissimo", /\bcolissimo\b/i],
];

/**
 * The carrier a stored courier string names, or null when it names none.
 *
 * Null is the answer for a great deal of real data and that is correct, not a
 * gap to paper over: 320,593 shipments carry no carrier at all, and others are
 * recorded as "Other", "wayfair", "Pakajo" or "ICS" — resellers and
 * integrations rather than carriers this system could ever query.
 */
export function carrierFrom(stored: string | null | undefined): Carrier | null {
  const text = stored?.trim();
  if (text === undefined || text === "") return null;
  for (const [carrier, pattern] of RECOGNISED) {
    if (pattern.test(text)) return carrier;
  }
  return null;
}

/** Whether a value is one of the carriers this system names. */
export function isCarrier(value: string): value is Carrier {
  return (CARRIERS as readonly string[]).includes(value);
}
