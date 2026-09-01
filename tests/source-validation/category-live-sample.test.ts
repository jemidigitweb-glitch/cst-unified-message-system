import { writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getSourcePool } from "@/lib/db/pools";
import { classifyConversationCategory } from "@/lib/knowledge/message-category";

/**
 * Live category sampler. Opt-in, read-only, aggregates only.
 *
 * Run: CST_CATEGORY_SAMPLE=1 npx vitest run tests/source-validation/category-live-sample.test.ts
 * It is skipped in the normal suite and never runs unattended.
 *
 * Same discipline as `ebay-live-source.test.ts`: every statement is a SELECT,
 * the pool pins `default_transaction_read_only=on`, and the report holds counts
 * and masked shapes — never a body, handle, order number or address.
 */

const ENABLED = process.env.CST_CATEGORY_SAMPLE === "1";
const OUT = process.env.CST_CATEGORY_OUT ?? "";
const LIMIT = Number(process.env.CST_CATEGORY_LIMIT ?? "400");

type Thread = { key: string; market: string; messages: string[] };

const EBAY = `
SELECT h.item_id::text || ':' || h.sender_id AS key,
       h.receive_date,
       b.message AS body
FROM customer_service.ebay_message_headers h
JOIN customer_service.ebay_messages b ON b.message_id = h.ext_message_id
WHERE h.folder_id = 0
  AND h.message_type IS NOT NULL
  AND b.message IS NOT NULL AND btrim(b.message) <> 'null'
  AND h.receive_date >= now() - interval '120 days'
ORDER BY h.receive_date DESC
LIMIT $1`;

const MAIL = (table: string) => `
SELECT coalesce(nullif(btrim(m.order_id), ''), 'msg:' || m.id::text) AS key,
       m.date AS receive_date,
       m.message_content AS body
FROM customer_service.${table} m
WHERE m.message_content IS NOT NULL AND btrim(m.message_content) <> ''
  AND m.from_msg IS NOT NULL
  AND m.from_msg NOT ILIKE '%ledsone%'
  AND m.from_msg NOT ILIKE '%electricalsone%'
  AND m.date >= now() - interval '120 days'
ORDER BY m.date DESC
LIMIT $1`;

/** eBay bodies are JSON-encoded string scalars; everything else is plain. */
function decode(raw: string, market: string): string | null {
  if (market !== "ebay") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function threadsFrom(
  sql: string,
  market: string,
  limit: number,
): Promise<Thread[]> {
  const { rows } = await getSourcePool().query({ text: sql, values: [limit] });
  const grouped = new Map<string, string[]>();
  for (const row of rows as { key: string; body: string }[]) {
    const text = decode(row.body, market);
    if (text === null || text.trim() === "") continue;
    const key = `${market}:${row.key}`;
    const list = grouped.get(key) ?? [];
    // Oldest first, matching how the inbox reads a thread.
    list.unshift(text);
    grouped.set(key, list);
  }
  return [...grouped.entries()].map(([key, messages]) => ({ key, market, messages }));
}

/**
 * Diagnostic probes, tight enough that a hit means something.
 *
 * The first version used `\bno\s` for absence, which matched "no problem" and
 * "I do not know" and made every bucket noise. These are the assertions a
 * category would actually be built on.
 */
const PROBES: readonly (readonly [string, RegExp])[] = [
  ["damage_en", /\b(?:damaged|broken|cracked|crack|smashed|shattered|chipped|dented|scratched)\b/],
  ["damage_de", /\b(?:besch(?:ä|ae)digt|zerbrochen|gebrochen|riss|risse|delle|kratzer|gesprungen)\b/],
  ["fault", /\b(?:faulty|does\s?n[o']?t\s+work|not\s+working|defect\w*|kaputt|funktioniert\s+nicht)\b/],
  ["absence", /\b(?:missing|not\s+included|nicht\s+enthalten|fehlt|fehlen|unvollst)\b/],
  ["wrong_item", /\b(?:wrong\s+(?:item|product|one|size|colou?r)|falsche[rns]?\s+artikel)\b/],
  ["not_as_described", /\b(?:not\s+as\s+described|nicht\s+wie\s+beschrieben|listing\s+says)\b/],
  ["delivery", /\b(?:tracking|not\s+(?:yet\s+)?arrived|where\s+is\s+my|noch\s+nicht\s+angekommen)\b/],
  ["money", /\b(?:refund|money\s+back|erstattung|r(?:ü|ue)ckerstattung)\b/],
  ["paperwork", /\b(?:invoice|vat|receipt|rechnung|quittung)\b/],
  ["german", /\b(?:ich|nicht|bitte|und\s+die|sehr\s+geehrte)\b/],
];

function probesOf(messages: string[]): string[] {
  const joined = messages.join(" ").toLowerCase();
  return PROBES.filter(([, re]) => re.test(joined)).map(([name]) => name);
}

describe.skipIf(!ENABLED)("live category sample (read-only)", () => {
  afterAll(async () => {
    await closeAllPools();
  });

  it("classifies a recent sample and reports counts only", async () => {
    const pool = getSourcePool();
    const guard = await pool.query({ text: "SHOW default_transaction_read_only" });
    expect((guard.rows[0] as { default_transaction_read_only: string }).default_transaction_read_only)
      .toBe("on");

    const threads = [
      ...(await threadsFrom(EBAY, "ebay", LIMIT)),
      ...(await threadsFrom(MAIL("shopify_messages"), "shopify", Math.floor(LIMIT / 2))),
      ...(await threadsFrom(MAIL("bandq_messages"), "bandq", Math.floor(LIMIT / 4))),
    ];

    const counts: Record<string, number> = {};
    const perMarket: Record<string, Record<string, number>> = {};
    const suspicious: Record<string, number> = {};

    for (const thread of threads) {
      const category = classifyConversationCategory(thread.messages) ?? "(none)";
      counts[category] = (counts[category] ?? 0) + 1;
      perMarket[thread.market] ??= {};
      perMarket[thread.market][category] = (perMarket[thread.market][category] ?? 0) + 1;

      // A thread that asserts a concrete problem but landed on the catch-all
      // is the thing worth looking at. Recorded as probe names, never as text.
      if (category === "Admin related issues" || category === "(none)") {
        for (const probe of probesOf(thread.messages)) {
          if (probe === "german" || probe === "paperwork") continue;
          const bucket = `${category === "(none)" ? "none" : "Admin"}<-${probe}`;
          suspicious[bucket] = (suspicious[bucket] ?? 0) + 1;
        }
      }
    }

    const report = {
      threads: threads.length,
      counts,
      perMarket,
      suspicious: Object.fromEntries(
        Object.entries(suspicious).sort((a, b) => b[1] - a[1]).slice(0, 15),
      ),
    };
    if (OUT !== "") writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    expect(threads.length).toBeGreaterThan(0);
  }, 120_000);
});
