import { domainOf, isCompanyDomain } from "@/lib/domain/company-domains";

/**
 * Which Shopify messages are CST work, and which are merely in the mailbox.
 *
 * Direction is already decided by the addresses. This is a different question:
 * a courier notification and a bounce are both genuinely inbound, and neither
 * is something a CST agent replies to. Left unfiltered they bury the customers —
 * 42% of the inbound stream in the loaded month is not customer contact.
 *
 * NOTHING HERE READS MEANING. Every rule tests a stored field: the sender's
 * domain, the recipient's domain, the subject line's leading token, or the
 * order reference. No body text is inspected and no wording is interpreted, so
 * a message is never hidden because of what it says.
 *
 * HIDDEN IS NOT DELETED. A filtered message is still stored, still threaded and
 * still carries its direction; it is kept out of the reply inbox and records
 * why, so what was hidden can always be listed and audited.
 */

export const SHOPIFY_FILTER_REASONS = [
  "bounce",
  "courier",
  "platform_notice",
  "marketplace_notice",
  "unsolicited",
] as const;

export type ShopifyFilterReason = (typeof SHOPIFY_FILTER_REASONS)[number];

/**
 * Multi-label public suffixes seen in this mailbox. Needed so `hotmail.co.uk`
 * yields the organisation `hotmail` rather than `co`.
 */
const MULTI_LABEL_SUFFIXES = [
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "com.au",
  "co.nz",
  "co.jp",
  "com.br",
  "co.za",
  "com.tr",
] as const;

/**
 * The organisation label of a domain — the label immediately left of its public
 * suffix. `ebay.com` and `members.ebay.de` both yield `ebay`.
 *
 * Matching on this rather than on a prefix is what stops a lookalike inheriting
 * a real sender's verdict: `ebay.com.attacker.invalid` yields `attacker`, and
 * `notebay.invalid` yields `notebay`. A prefix match would have accepted both
 * as eBay.
 */
export function organisationLabelOf(domain: string): string | null {
  const suffix = MULTI_LABEL_SUFFIXES.find(
    (candidate) => domain === candidate || domain.endsWith(`.${candidate}`),
  );
  const cut = suffix ? domain.length - suffix.length - 1 : domain.lastIndexOf(".");
  if (cut <= 0) return null;
  const remainder = domain.slice(0, cut);
  return remainder.slice(remainder.lastIndexOf(".") + 1) || null;
}

/**
 * Consumer mailbox providers. A sender here is treated as a person until some
 * other rule says otherwise, because this is where customers write from —
 * 2,822 of the loaded month's inbound messages, across 43 domains.
 */
const CONSUMER_MAIL_ORGS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "rocketmail", "hotmail", "outlook",
  "live", "msn", "icloud", "me", "mac", "aol", "btinternet", "sky", "talktalk",
  "virginmedia", "blueyonder", "ntlworld", "tiscali", "web", "gmx", "t-online",
  "freenet", "posteo", "mailbox", "protonmail", "proton", "zoho", "orange",
  "wanadoo", "laposte", "free", "comcast", "verizon", "att", "gmail-smtp",
]);

/** Delivery companies and packaging suppliers. Notifications, not conversations. */
const COURIER_ORGS = new Set([
  "evri", "myhermes", "hermes", "dpd", "dpdgroup", "royalmail", "rmg", "dhl",
  "dhlecommerce", "ups", "fedex", "tnt", "yodel", "parcel2go", "parcelforce",
  "tuffnells", "whistl", "kitepackaging", "packlink", "shiptheory",
]);

/** The shop platform and the apps bolted onto it. Operational alerts. */
const PLATFORM_ORGS = new Set([
  "shopify", "shopifyemail", "myshopify", "judge", "klaviyo", "mailchimp",
  "omnisend", "recharge", "gorgias", "trustpilot", "spocket",
]);

/**
 * Other sales channels whose notices land in this mailbox. eBay's belong in the
 * eBay tab, which already holds them from eBay's own source — showing them here
 * would double-count the same correspondence under the wrong marketplace.
 */
const MARKETPLACE_ORGS = new Set([
  "ebay", "amazon", "wayfair", "faire", "onbuy", "manomano", "etsy", "bol",
  "avasam", "tiktok", "temu", "fruugo", "debenhams", "therange",
]);

/** A non-delivery report. Matched on the subject's opening, not its contents. */
const BOUNCE_SUBJECT =
  /^\s*(mail delivery failed|undeliverable|delivery status notification|returned mail|mail delivery subsystem|delivery has failed|unzustellbar)/i;

/** The shop's own order references, as they appear in a subject line. */
const ORDER_IN_SUBJECT = /#(LED|DC|LSDE|SW|ENC)\s?\d|order\s*#|bestellung\s*#?\s*\d/i;

/** A reply or forward, in the languages this mailbox actually receives. */
const REPLY_SUBJECT = /^\s*(re|aw|antw|antwort|fwd|fw|wg|tr|rif)\s*:/i;

/** An inbound sales enquiry — a lead, and therefore CST work. */
const QUOTE_SUBJECT = /\b(quotation|quote request|request for quote|rfq|enquiry|inquiry|anfrage)\b/i;

export type FilterableRow = {
  readonly from_msg: string | null;
  readonly to_msg: string | null;
  readonly subject: string | null;
  readonly order_id: string | null;
};

function hasOrderSignal(row: FilterableRow): boolean {
  if (row.order_id !== null && row.order_id.trim() !== "") return true;
  const subject = row.subject ?? "";
  return (
    ORDER_IN_SUBJECT.test(subject) || REPLY_SUBJECT.test(subject) || QUOTE_SUBJECT.test(subject)
  );
}

/**
 * Why this message should be kept out of the reply inbox, or null to show it.
 *
 * Order matters. A bounce is a bounce whatever domain relayed it, so that rule
 * runs first; the domain rules follow; and the catch-all runs last so an
 * unrecognised business domain is only hidden when it ALSO shows no sign of
 * being about an order.
 */
export function filterReasonFor(row: FilterableRow): ShopifyFilterReason | null {
  const from = domainOf(row.from_msg);

  // Our own replies are CST work by definition and are never filtered.
  if (isCompanyDomain(from)) return null;

  if (BOUNCE_SUBJECT.test(row.subject ?? "")) return "bounce";
  if (from === null) return null;

  const org = organisationLabelOf(from);
  if (org === null) return null;

  if (COURIER_ORGS.has(org)) return "courier";
  if (PLATFORM_ORGS.has(org)) return "platform_notice";
  if (MARKETPLACE_ORGS.has(org)) return "marketplace_notice";

  // A person's mailbox. Shown even without an order reference: four fifths of
  // genuine customer contact carries none, so requiring one would hide them.
  if (CONSUMER_MAIL_ORGS.has(org)) return null;

  // An unrecognised business domain. Shown only when something stored ties it
  // to an order, a thread, or a quote — otherwise it is unsolicited mail.
  return hasOrderSignal(row) ? null : "unsolicited";
}
