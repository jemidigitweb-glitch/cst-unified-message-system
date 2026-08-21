/**
 * The opaque reference a conversation is grouped by.
 *
 * For eBay this is a real customer handle. For every other marketplace the
 * source does not expose a usable customer identity — the sender address is a
 * shared platform relay, and grouping on one would merge unrelated people into
 * a single thread. Those marketplaces group on a source reference instead, and
 * where even that is absent the message stands alone under a sentinel derived
 * from its own immutable source primary key.
 *
 * The sentinel is defined here rather than inline in each adapter so that the
 * interface can recognise it and decline to present it as a person's name. It
 * is an internal marker, never displayed.
 */
export const UNRESOLVED_REFERENCE_PREFIX = "unresolved:" as const;

/** Sentinel reference for a message that cannot be grouped with any other. */
export function unresolvedReferenceFor(sourcePk: string): string {
  return `${UNRESOLVED_REFERENCE_PREFIX}${sourcePk}`;
}

/** Whether a stored reference is the ungrouped sentinel rather than a real reference. */
export function isUnresolvedReference(reference: string): boolean {
  return reference.startsWith(UNRESOLVED_REFERENCE_PREFIX);
}
