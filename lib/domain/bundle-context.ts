/**
 * A listing sold as a bundle of separately-stocked components.
 *
 * WHY THIS IS NOT A LIST OF `VerifiedFact`. A bundle's components each carry
 * their own attribute set, and the names collide: the ceiling rose in one real
 * listing has `diameter_mm: 100` while the lampshade in the same bundle has
 * `diameter_mm: 320`. Flattening them into one list produces a contradiction
 * that no reader — model or human — can resolve. Each component therefore keeps
 * its own block, and attribute names inside a block are the sheet's own,
 * unrenamed.
 *
 * PURE DATA. No behaviour, no formatting, no interpretation. How it is rendered
 * for the model is `lib/ai/draft-assembly.ts`'s business; how it is resolved is
 * `lib/context/resolve-bundle-product-context.ts`'s.
 */

/** One stored attribute, exactly as the product sheet holds it. */
export type BundleAttribute = {
  readonly key: string;
  readonly value: string;
};

/** One component of the bundle, and what is verified about it. */
export type BundleComponent = {
  /** The exact component SKU, as `order_combo` recorded it. Never reconstructed. */
  readonly sku: string;
  /** The product master's title, for naming the component. Null when unknown. */
  readonly title: string | null;
  /**
   * Verified attributes, or EMPTY when this component has no product record.
   *
   * An empty list is meaningful and must not be treated as "nothing to say":
   * it is the case that forces `complete` to false.
   */
  readonly attributes: readonly BundleAttribute[];
};

/**
 * What every version of this listing has in common, and what varies.
 *
 * `common` components appear in EVERY decomposable variant, so their facts hold
 * whichever option the customer means. `varyingAgreement` carries the attributes
 * on which the differing components all agree — the 8 colours of one shade share
 * every dimension, so those dimensions are answerable without knowing which
 * colour was meant. Anything the variants disagree on is absent by construction.
 */
export type BundleContext = {
  /** The listing this describes. Carried so a reviewer can tie it back. */
  readonly listingItemRef: string;
  /** How many variants of the listing decomposed consistently. */
  readonly variantCount: number;
  /** Components present in every variant, ordered by SKU for determinism. */
  readonly common: readonly BundleComponent[];
  /** Attributes every variant's differing components agree on. May be empty. */
  readonly varyingAgreement: readonly BundleAttribute[];
  /**
   * Whether EVERY component has a verified product record.
   *
   * False means the component list is known but not fully described, and no
   * statement about what is in the box may be made from it — see
   * `INCLUSION_ATTRIBUTES` in the resolver.
   */
  readonly complete: boolean;
  /** Components with no product record, named so the gap is visible. */
  readonly componentsWithoutRecord: readonly string[];
};
