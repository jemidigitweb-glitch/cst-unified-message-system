/**
 * Whether a stored listing URL may be shown as a link, and under what text.
 *
 * Pure, and deliberately separate from the lookup that produces the URL. What
 * the source recorded is one question; whether it is safe and honest to put in
 * front of a reviewer as a clickable link is another, and only the second is
 * testable without a database.
 *
 * THE LINK MUST PROVE IT IS THE LISTING BESIDE IT. The sidebar shows an item
 * reference and, on the same row, a link. If those two ever disagreed the
 * reviewer would have no way of knowing — they would click a plausible URL for
 * the wrong product, quote its price or its description back to a customer, and
 * the mistake would look exactly like a correct answer. So the URL is required
 * to carry the very reference it is displayed against, and anything that does
 * not is dropped rather than shown.
 *
 * That check costs nothing today: every one of the 25,489 parent listing rows
 * holding a URL ends in `/<item_id>`, and all 25,489 are `https`. It is here for
 * the day the listing sync changes shape — at which point the link disappears
 * and a reviewer sees the plain reference they saw before this feature existed,
 * rather than a link to whatever the new format happens to point at.
 */

/** One variation axis a listing offers, and every option under it. */
export type ListingVariationView = {
  readonly name: string;
  readonly values: readonly string[];
};

/**
 * The response of `GET /api/conversations/:id/listing`.
 *
 * THE CURRENT LISTING, WHICH IS NOT THE CURRENT ORDER. Everything here is
 * derived from the conversation's own `listing_item_ref` and storefront, so it
 * resolves on a conversation that matched no order at all — which is exactly the
 * conversation a reviewer most needs it on. It says what the customer was
 * looking at; it says nothing about what they bought.
 *
 * NO SKU FIELD, DELIBERATELY. A listing carries many SKUs — one per variant, up
 * to 24 on live rows — and nothing in an item reference says which one a
 * customer means. The authoritative SKU lives on an ORDER line
 * (`order_item_info.item_sku`/`real_sku`), so it is available precisely when an
 * order matched, and it arrives through the order context that already carries
 * it. Adding a field here would invite picking one, and picking one arbitrarily
 * is the failure this contract exists to prevent.
 */
export type ListingLinkResponse = {
  readonly conversationId: string;
  /**
   * The listing URL, or null. Null is the answer for every refusal — no item
   * reference, a marketplace whose listing table cannot be resolved from an
   * item reference alone, nothing recorded, several conflicting URLs, and a URL
   * that failed the checks below. The panel renders all of them identically,
   * because they are all the same fact to a reviewer: there is no link to give.
   */
  readonly listingUrl: string | null;
  /**
   * The conversation's own item reference, echoed back so the panel renders the
   * listing block from one payload rather than joining this response to the
   * conversation by hand. Null where the conversation carries none.
   */
  readonly itemRef: string | null;
  /**
   * The listing's own title, or null. Null for every case `findListingDetails`
   * refuses — no parent row on this storefront, several, or a blank title — and
   * for every non-eBay conversation.
   */
  readonly title: string | null;
  /**
   * Which options the LISTING offers, never which one this customer chose. A
   * list of what is sold cannot contradict a record of what was bought, which is
   * what makes it safe to show beside an order as well as without one. Empty
   * where nothing resolved.
   */
  readonly variations: readonly ListingVariationView[];
};

/**
 * Schemes a link may use.
 *
 * `javascript:`, `data:` and `vbscript:` are the reason this is an allowlist
 * rather than a denylist. The URL is read from a database and rendered into an
 * `href`, which is enough on its own to require the check — the fact that this
 * particular table is filled by the company's own listing sync rather than by
 * anyone outside it is a reason the check passes today, not a reason to skip it.
 *
 * `http:` is admitted alongside `https:` only so that a source that downgrades
 * a URL still produces a working link. Nothing live uses it.
 */
const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

/**
 * The URL to show for one item reference, or null if there is none to show.
 *
 * NO HOST ALLOWLIST, deliberately. The live data spans ten eBay domains
 * (`.co.uk`, `.com`, `.fr`, `.de`, `.es`, `.it`, `.ca`, `.at`, `.ie`, `.nl`) and
 * a fixed list would silently drop the eleventh the day a new site is listed
 * on. The reference check below is the stronger guarantee anyway: it ties the
 * link to the listing it claims to be, whatever the domain.
 */
export function displayableListingUrl(
  rawUrl: string | null,
  itemRef: string | null,
): string | null {
  if (rawUrl === null || itemRef === null) return null;

  const url = rawUrl.trim();
  const reference = itemRef.trim();
  if (url === "" || reference === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL. A relative one has no meaning here — there is no
    // base it could be resolved against that would be the marketplace's.
    return null;
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;

  // A public host, which is the only kind a marketplace listing has. Not a
  // domain allowlist — see above — but a bare label is never one: the URL
  // parser reads a triple-slashed `https:` as having the first path segment for
  // a host, and a loopback name is not a listing either. Every live value
  // clears this; all ten of the eBay domains in the source are dotted.
  if (!parsed.hostname.includes(".")) return null;

  // Compared against the PATH, not the whole URL, so a reference appearing in a
  // query string or a title slug cannot vouch for a link to something else.
  if (!parsed.pathname.endsWith(`/${reference}`)) return null;

  // The source's own string, not `parsed.href`: round-tripping through URL
  // normalises escapes and can rewrite what the reviewer would otherwise find
  // character-for-character in the listing table.
  return url;
}
