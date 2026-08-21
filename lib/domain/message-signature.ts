/**
 * The name a message is signed with.
 *
 * Messages on the unverified-direction feeds carry no sender field — the
 * adapters deliberately never select one — but most written messages sign
 * themselves off:
 *
 *     Kind regards,
 *
 *     Zara
 *
 * That is a structure, not a topic, which is why reading it is acceptable where
 * inferring meaning from message text is not. The rule is narrow and refuses
 * anything it is not sure about: a recognised closing phrase ON ITS OWN LINE,
 * followed by one short line that looks like a person's name. Everything else
 * yields null and the caller falls back to a neutral title.
 *
 * WHAT THIS NAME IS, AND IS NOT. It is whoever wrote the message. On these
 * feeds that may be a customer or one of our own agents — the source does not
 * establish direction, which is exactly why these marketplaces are on this feed
 * at all. So the name must never be presented as "the customer", and nothing
 * downstream may treat it as a counterparty identity.
 */

/**
 * Closing phrases, English and German — both appear in this data. Matched only
 * when the phrase is the entire line, so "Thanks again for your cooperation."
 * is not mistaken for a sign-off.
 */
const CLOSINGS = [
  "kind regards",
  "best regards",
  "warm regards",
  "warmest regards",
  "regards",
  "yours sincerely",
  "yours faithfully",
  "sincerely",
  "many thanks",
  "thanks",
  "thank you",
  "cheers",
  "best wishes",
  "all the best",
  "mit freundlichen grüßen",
  "mit freundlichen gruessen",
  "freundliche grüße",
  "viele grüße",
  "beste grüße",
  "liebe grüße",
  "herzliche grüße",
] as const;

/** Trailing punctuation a closing may carry. */
const CLOSING_SUFFIX = /[,.!]*$/;

/**
 * Words that mean the line names an organisation or role rather than a person.
 * "Temu team" and "Customer Services" are signatures, but not of anybody.
 */
const NOT_A_PERSON = [
  "team",
  "teams",
  "support",
  "service",
  "services",
  "centre",
  "center",
  "department",
  "ltd",
  "limited",
  "llc",
  "inc",
  "gmbh",
  "plc",
  "co",
  "company",
  "group",
  "sales",
  "marketing",
  "notifications",
  "noreply",
  "seller",
  "customer",
  "admin",
  "specialist",
  "manager",
] as const;

const MAX_NAME_LENGTH = 40;
const MAX_NAME_WORDS = 3;

/** How far past the closing to look for the name before giving up. */
const MAX_LOOKAHEAD_LINES = 3;

function isClosing(line: string): boolean {
  const normalized = line.trim().toLowerCase().replace(CLOSING_SUFFIX, "");
  return CLOSINGS.some((closing) => closing === normalized);
}

/**
 * Whether a line reads as a person's name.
 *
 * Conservative on purpose: letters, spaces and the punctuation real names carry
 * (O'Neill, Anne-Marie, Jr.). Anything with a digit, an address, a URL or a
 * role word is rejected rather than guessed at.
 */
function looksLikeName(line: string): boolean {
  const candidate = line.trim();
  if (candidate === "" || candidate.length > MAX_NAME_LENGTH) return false;
  if (!/^[\p{L}][\p{L}\p{M}'’.\- ]*$/u.test(candidate)) return false;

  const words = candidate.split(/\s+/);
  if (words.length > MAX_NAME_WORDS) return false;

  return !words.some((word) =>
    NOT_A_PERSON.includes(
      word.toLowerCase().replace(/[.'’-]/g, "") as (typeof NOT_A_PERSON)[number],
    ),
  );
}

/**
 * The name a body is signed with, or null when it is not signed by a person.
 *
 * The LAST closing in the body wins: a reply that quotes an earlier message
 * carries that message's sign-off above its own.
 */
export function senderNameFromBody(body: string | null): string | null {
  if (body === null) return null;

  const lines = body.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isClosing(lines[index]!)) continue;

    // The name usually follows a blank line, sometimes immediately.
    let seen = 0;
    for (let next = index + 1; next < lines.length && seen < MAX_LOOKAHEAD_LINES; next += 1) {
      const line = lines[next]!.trim();
      if (line === "") continue;
      seen += 1;
      if (looksLikeName(line)) return line;
      // The first non-empty line after the closing was not a name, so this
      // sign-off has none. Keep scanning earlier closings.
      break;
    }
  }

  return null;
}
