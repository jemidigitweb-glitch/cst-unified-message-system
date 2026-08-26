import { describe, expect, it } from "vitest";

import { resolveEbayImageContext } from "@/lib/context/resolve-image-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/ebay-image-repository";
import type { Writable as AppWritable } from "@/lib/repositories/context-snapshot-repository";

type Call = { text: string; values?: unknown[] };

function fakeAppClient(existingSnapshot: unknown = null) {
  const calls: Call[] = [];
  const client: AppWritable = {
    query: async (config) => {
      calls.push(config);
      if (config.text.includes("FROM cst_app.context_snapshots") && config.text.startsWith("\nSELECT")) {
        return { rows: existingSnapshot ? [existingSnapshot] : [] };
      }
      return { rows: [] };
    },
  };
  return { calls, client };
}

function fakeSourceClient() {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      if (config.text.includes("listings.ebay_listing_images")) {
        return { rows: [{ image_url: "https://i.ebayimg.com/images/g/product/s-l1600.jpg", view_order: 1 }] };
      }
      if (config.text.includes("customer_service.ebay_returns")) {
        return {
          rows: [
            { id: "41031", img: "https://i.ebayimg.com/images/g/return/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "CLOSED" },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { calls, client };
}

const baseConversation = {
  id: "32439",
  marketplace: "ebay",
  subSourceId: 1,
  listingItemRef: "167833569765",
};

const singleOrderSnapshot = {
  id: "9",
  conversation_id: "32439",
  resolution: "single_order",
  sub_source_id: 1,
  order_number: "13-15029-03048",
  order_date: "2026-08-21",
  order_status_summary: "Dispatched",
  tracking_number: null,
  delivery_courier: null,
  delivery_address: null,
  listing_item_ref: "167833569765",
  verification_method: "deterministic_single",
};

describe("resolveEbayImageContext — marketplace and reference gating", () => {
  it("returns no images and touches neither database for a non-eBay conversation", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, {
      ...baseConversation,
      marketplace: "amazon",
    });

    expect(images).toEqual({ productImages: [], returnEvidenceImages: [] });
    expect(appCalls).toHaveLength(0);
    expect(sourceCalls).toHaveLength(0);
  });

  it("returns no product images when there is no listing item reference", async () => {
    const { client: appClient } = fakeAppClient();
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, {
      ...baseConversation,
      listingItemRef: null,
    });

    expect(images.productImages).toEqual([]);
    expect(sourceCalls.some((c) => c.text.includes("ebay_listing_images"))).toBe(false);
  });
});

describe("resolveEbayImageContext — product images, order-independent", () => {
  it("returns product images even with no context snapshot at all", async () => {
    const { client: appClient } = fakeAppClient(null);
    const { client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, baseConversation);

    expect(images.productImages).toEqual([
      { imageUrl: "https://i.ebayimg.com/images/g/product/s-l1600.jpg", viewOrder: 1 },
    ]);
    expect(images.returnEvidenceImages).toEqual([]);
  });

  it("returns product images for a no_order snapshot, but no return evidence", async () => {
    const { client: appClient } = fakeAppClient({
      id: "1",
      conversation_id: "32439",
      resolution: "no_order",
      sub_source_id: null,
      order_number: null,
      listing_item_ref: null,
      verification_method: "none",
    });
    const { client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, baseConversation);

    expect(images.productImages).toHaveLength(1);
    expect(images.returnEvidenceImages).toEqual([]);
  });

  it("returns product images for an ambiguous snapshot, but no return evidence -- never guesses which order", async () => {
    const { client: appClient } = fakeAppClient({
      id: "2",
      conversation_id: "32439",
      resolution: "ambiguous",
      sub_source_id: null,
      order_number: null,
      listing_item_ref: null,
      verification_method: "none",
    });
    const { client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, baseConversation);

    expect(images.productImages).toHaveLength(1);
    expect(images.returnEvidenceImages).toEqual([]);
  });
});

describe("resolveEbayImageContext — return evidence, verified single order only", () => {
  it("returns return-evidence images scoped by the verified order_number, item_id and sub_source", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient();

    const images = await resolveEbayImageContext(sourceClient, appClient, baseConversation);

    expect(images.returnEvidenceImages).toEqual([
      {
        returnId: "41031",
        imageUrl: "https://i.ebayimg.com/images/g/return/s-l1600.jpg",
        reason: "ARRIVED_DAMAGED",
        status: "CLOSED",
      },
    ]);
    const returnsCall = sourceCalls.find((c) => c.text.includes("customer_service.ebay_returns"));
    expect(returnsCall!.values).toEqual(["13-15029-03048", "167833569765", 1]);
  });

  it("never triggers a fresh order resolution -- reads the existing snapshot only, no write query issued", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient(null);
    const { client: sourceClient } = fakeSourceClient();

    await resolveEbayImageContext(sourceClient, appClient, baseConversation);

    expect(appCalls).toHaveLength(1);
    expect(appCalls[0]!.text.trim().startsWith("SELECT")).toBe(true);
  });
});
