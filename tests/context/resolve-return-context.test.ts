import { describe, expect, it } from "vitest";

import { resolveEbayReturnContext } from "@/lib/context/resolve-return-context";
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

function fakeSourceClient(returnRows: unknown[]) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      if (config.text.includes("customer_service.ebay_returns")) {
        return { rows: returnRows };
      }
      return { rows: [] };
    },
  };
  return { calls, client };
}

const baseConversation = { id: "32439", marketplace: "ebay" };

const singleOrderSnapshot = {
  id: "9",
  conversation_id: "32439",
  resolution: "single_order",
  sub_source_id: 1,
  order_number: "11-11111-11111",
  listing_item_ref: "167833569765",
  verification_method: "deterministic_single",
};

describe("resolveEbayReturnContext — gating", () => {
  it("returns no facts and touches neither database for a non-eBay conversation", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, {
      ...baseConversation,
      marketplace: "amazon",
    });

    expect(facts).toEqual([]);
    expect(appCalls).toHaveLength(0);
    expect(sourceCalls).toHaveLength(0);
  });

  it("returns no facts when there is no context snapshot at all -- never triggers a first order resolution", async () => {
    const { client: appClient } = fakeAppClient(null);
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(sourceCalls).toHaveLength(0);
  });

  it("returns no facts for a no_order snapshot", async () => {
    const { client: appClient } = fakeAppClient({
      id: "1",
      conversation_id: "32439",
      resolution: "no_order",
      sub_source_id: null,
      order_number: null,
      listing_item_ref: null,
      verification_method: "none",
    });
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(sourceCalls).toHaveLength(0);
  });

  it("returns no facts for an ambiguous snapshot -- never guesses which order's return this is", async () => {
    const { client: appClient } = fakeAppClient({
      id: "2",
      conversation_id: "32439",
      resolution: "ambiguous",
      sub_source_id: null,
      order_number: null,
      listing_item_ref: null,
      verification_method: "none",
    });
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(sourceCalls).toHaveLength(0);
  });

  it("returns no facts when a verified order exists but has no photographed return event", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
  });
});

describe("resolveEbayReturnContext — verified single order with return evidence", () => {
  it("returns return_status, return_reason and return_evidence_available, scoped by order_id + item_id + sub_source", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([
      { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "CLOSED" },
    ]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([
      { name: "return_status", value: "CLOSED" },
      { name: "return_reason", value: "ARRIVED_DAMAGED" },
      { name: "return_evidence_available", value: "Yes" },
    ]);
    const returnsCall = sourceCalls.find((c) => c.text.includes("customer_service.ebay_returns"));
    expect(returnsCall!.values).toEqual(["11-11111-11111", "167833569765", 1]);
    expect(returnsCall!.text).toContain("order_id = $1");
    expect(returnsCall!.text).not.toContain("item_id = $1");
  });

  it("never includes an image URL or any field naming a photo's content -- text facts only", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { client: sourceClient } = fakeSourceClient([
      { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: "WRONG_SIZE", status: "CLOSED" },
    ]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    for (const fact of facts) {
      expect(fact.value).not.toContain("http");
      expect(fact.value).not.toContain("ebayimg");
    }
  });

  it("uses the most recent photographed return event when more than one exists for the same order", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { client: sourceClient } = fakeSourceClient([
      { id: "32373", img: "https://i.ebayimg.com/images/g/old/s-l1600.jpg", reason: "WRONG_SIZE", status: "CLOSED" },
      { id: "41031", img: "https://i.ebayimg.com/images/g/new/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "WAITING_FOR_RMA" },
    ]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([
      { name: "return_status", value: "WAITING_FOR_RMA" },
      { name: "return_reason", value: "ARRIVED_DAMAGED" },
      { name: "return_evidence_available", value: "Yes" },
    ]);
  });

  it("still reports return_evidence_available even when status and reason are both null", async () => {
    const { client: appClient } = fakeAppClient(singleOrderSnapshot);
    const { client: sourceClient } = fakeSourceClient([
      { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: null, status: null },
    ]);

    const facts = await resolveEbayReturnContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([{ name: "return_evidence_available", value: "Yes" }]);
  });
});
