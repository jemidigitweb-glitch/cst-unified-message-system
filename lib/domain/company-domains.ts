/**
 * The email domains this business sends from.
 *
 * This list IS the direction rule for any source whose messages are ordinary
 * email: a message from one of these domains to an outside address was sent by
 * us; one from outside to one of these was sent to us. Nothing else about the
 * message is consulted.
 *
 * That makes the list load-bearing, and it has one failure mode worth stating
 * plainly: a MISSING domain silently reclassifies real CST replies as customer
 * messages. It is therefore an explicit, reviewable constant rather than
 * something derived at runtime from whichever domains happen to look busy.
 *
 * Derived from the recipient side of the live source — the mailbox a message
 * arrives at is ours by definition — and cross-checked against the configured
 * marketplace accounts. Every entry below receives real customer mail:
 *
 *   ledsone.co.uk 16,860 · ledsone.de 1,070 · dcvoltage.co.uk 433
 *   electricalsone.co.uk 288 · besbet.co.uk 262 · vintagelite.co.uk 222
 *   ledsone.fr 147 · ledsone.us 109 · vintageinterior.co.uk 78 · ledsone.nl 1
 *
 * STATUS: derived from data, NOT ratified by the business. Adding or removing a
 * domain changes how thousands of messages are classified, so treat a change
 * here as a reviewed decision.
 */
export const COMPANY_EMAIL_DOMAINS: readonly string[] = [
  "ledsone.co.uk",
  "ledsone.de",
  "ledsone.fr",
  "ledsone.us",
  "ledsone.nl",
  "dcvoltage.co.uk",
  "electricalsone.co.uk",
  "besbet.co.uk",
  "vintagelite.co.uk",
  "vintageinterior.co.uk",
];

/** The domain half of an address, lowercased. Null when there is no address. */
export function domainOf(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/>$/, "");
  return domain === "" ? null : domain;
}

/**
 * Whether a domain is ours, including subdomains.
 *
 * Subdomains matter: the platform sends on our behalf from addresses such as
 * `mailernr9.ledsone.co.uk`, and those are unambiguously us. The check is an
 * exact match or a dot-boundary suffix, never a substring — `notledsone.co.uk`
 * and `ledsone.co.uk.example.invalid` are both outside.
 */
export function isCompanyDomain(domain: string | null): boolean {
  if (domain === null) return false;
  return COMPANY_EMAIL_DOMAINS.some(
    (owned) => domain === owned || domain.endsWith(`.${owned}`),
  );
}

/** Whether an address belongs to the company. */
export function isCompanyAddress(address: string | null | undefined): boolean {
  return isCompanyDomain(domainOf(address));
}
