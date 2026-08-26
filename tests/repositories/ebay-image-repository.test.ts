import { describe, expect, it } from "vitest";

import {
  type ProductImage,
  type Queryable,
  type ReturnEvidenceImage,
  findProductListingImages,
  findReturnEvidenceImages,
} from "@/lib/repositories/ebay-image-repository";

function fake(rows: unknown[]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

describe("findProductListingImages", () => {
  it("scopes to the parent listing row only -- item_id, sub_source, and is_parent = 1", async () => {
    const { calls, client } = fake([
      { image_url: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", view_order: 1 },
    ]);

    await findProductListingImages(client, { itemId: "166872810291", subSourceId: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["166872810291", 1]);
    expect(calls[0]!.text).toContain("el.item_id = $1");
    expect(calls[0]!.text).toContain("el.sub_source = $2::int");
    expect(calls[0]!.text).toContain("el.is_parent = 1");
    expect(calls[0]!.text).toContain("eli.product_id = el.id");
  });

  it("maps rows into ProductImage, ordered by view_order", async () => {
    const { client } = fake([
      { image_url: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", view_order: 2 },
      { image_url: "https://i.ebayimg.com/images/g/b/s-l1600.jpg", view_order: null },
    ]);

    const images = await findProductListingImages(client, { itemId: "166872810291", subSourceId: 1 });

    expect(images).toEqual<ProductImage[]>([
      { imageUrl: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", viewOrder: 2 },
      { imageUrl: "https://i.ebayimg.com/images/g/b/s-l1600.jpg", viewOrder: null },
    ]);
  });

  it("returns an empty array when the listing has no parent row or no images", async () => {
    const { client } = fake([]);

    const images = await findProductListingImages(client, { itemId: "no-such-item", subSourceId: 1 });

    expect(images).toEqual([]);
  });
});

describe("findReturnEvidenceImages", () => {
  it("scopes to order_id + item_id + sub_source, never item_id alone", async () => {
    const { calls, client } = fake([
      { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "CLOSED" },
    ]);

    await findReturnEvidenceImages(client, {
      orderNumber: "13-15029-03048",
      itemId: "167833569765",
      subSourceId: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["13-15029-03048", "167833569765", 1]);
    expect(calls[0]!.text).toContain("order_id = $1");
    expect(calls[0]!.text).toContain("item_id = $2::bigint");
    expect(calls[0]!.text).toContain("sub_source = $3::int");
    expect(calls[0]!.text).toContain("img IS NOT NULL");
  });

  it("maps rows into ReturnEvidenceImage", async () => {
    const { client } = fake([
      { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "CLOSED" },
    ]);

    const images = await findReturnEvidenceImages(client, {
      orderNumber: "13-15029-03048",
      itemId: "167833569765",
      subSourceId: 1,
    });

    expect(images).toEqual<ReturnEvidenceImage[]>([
      {
        returnId: "41031",
        imageUrl: "https://i.ebayimg.com/images/g/a/s-l1600.jpg",
        reason: "ARRIVED_DAMAGED",
        status: "CLOSED",
      },
    ]);
  });

  it("returns an empty array when the order has no photographed return event", async () => {
    const { client } = fake([]);

    const images = await findReturnEvidenceImages(client, {
      orderNumber: "13-15029-03048",
      itemId: "167833569765",
      subSourceId: 1,
    });

    expect(images).toEqual([]);
  });
});
