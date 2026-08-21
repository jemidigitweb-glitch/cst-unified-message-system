import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { getDraftModelClient } from "@/lib/ai/gemini-client";
import { closeAllPools, getAppPool } from "@/lib/db/pools";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * The Generate Reply path, end to end, against the real database and the real
 * model: route handler -> conversation -> rule files -> Gemini -> draft storage.
 *
 * OPT-IN via RUN_LIVE_GEMINI=1. It spends tokens and writes a draft revision to
 * cst_app, so it is not part of the default suite.
 *
 *   RUN_LIVE_GEMINI=1 npx vitest run tests/ai/draft-route-live.test.ts
 *
 * It WRITES: one draft and its revisions, for whichever conversation it picks.
 * That is the only thing this phase can write, and it is removed again in
 * afterAll so a repeated run does not accumulate drafts.
 */

loadEnvFile();

const DIRECTORY = join(__dirname, "..", "..", "Knowledge-source");
const ready =
  process.env.RUN_LIVE_GEMINI === "1" &&
  existsSync(DIRECTORY) &&
  readdirSync(DIRECTORY).some((name) => name.endsWith(".xlsx")) &&
  getDraftModelClient() !== undefined &&
  process.env.APP_DB_HOST !== undefined;

/** A conversation whose newest message came from the customer. */
async function pickConversation(): Promise<string | null> {
  const { rows } = await getAppPool().query(
    `SELECT c.id
       FROM cst_app.conversations c
      WHERE c.message_count BETWEEN 1 AND 8
        AND EXISTS (SELECT 1 FROM cst_app.conversation_messages m
                     WHERE m.conversation_id = c.id AND m.direction = 'inbound')
      ORDER BY c.id
      LIMIT 1`,
  );
  return rows.length === 0 ? null : String(rows[0]!.id);
}

let used: string | null = null;

afterAll(async () => {
  if (used !== null) {
    // Cascades to revisions and their sources.
    await getAppPool()
      .query("DELETE FROM cst_app.draft_replies WHERE conversation_id = $1", [used])
      .catch(() => undefined);
  }
  await closeAllPools();
});

describe.skipIf(!ready)("Generate Reply, against a real conversation", () => {
  it("generates, stores and returns a draft", async () => {
    const conversationId = await pickConversation();
    expect(conversationId, "no suitable conversation in the database").not.toBeNull();
    used = conversationId;

    const { POST, GET } = await import("@/app/api/conversations/[conversationId]/draft/route");
    const params = Promise.resolve({ conversationId: conversationId! });

    const response = await POST(new Request("http://localhost/x", { method: "POST" }), { params });
    const body = (await response.json()) as {
      error?: string;
      code?: string;
      draftReply?: string;
      revision?: number;
      sourcesUsed?: { ref: string }[];
      missingInformation?: string[];
      requiresReview?: boolean;
      ruleAreas?: string[];
    };

    // A failure here should say WHY, which is the whole point of this task.
    expect(body.error ?? "no error", `code=${body.code}`).toBe("no error");
    expect(response.status).toBe(200);

    expect(body.draftReply!.length).toBeGreaterThan(40);
    expect(body.revision).toBe(1);
    expect(body.ruleAreas).toContain("Message Handling");

    console.log("\n--- draft ---\n" + body.draftReply);
    console.log("--- areas ---", body.ruleAreas?.join(", "));
    console.log("--- sources ---", body.sourcesUsed?.map((s) => s.ref).join(", ") || "(none)");
    console.log("--- missing ---", body.missingInformation?.join(" | ") || "(none)");

    // It is readable back, which is what the panel does next.
    const read = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ conversationId: conversationId! }),
    });
    const stored = (await read.json()) as {
      draft: { revisions: { bodyText: string; revision: number }[] } | null;
    };
    expect(stored.draft?.revisions[0]?.bodyText).toBe(body.draftReply);
  }, 120_000);

  it("regenerates into a new revision rather than overwriting", async () => {
    expect(used, "first test must have run").not.toBeNull();
    const { POST } = await import("@/app/api/conversations/[conversationId]/draft/route");

    const response = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ conversationId: used! }),
    });
    const body = (await response.json()) as { revision?: number; error?: string };

    expect(body.error ?? "no error").toBe("no error");
    expect(body.revision).toBe(2);
  }, 120_000);

  it("saves a human edit as a further revision, and never as an overwrite", async () => {
    const { PATCH, GET } = await import("@/app/api/conversations/[conversationId]/draft/route");

    const edited = "Edited by the reviewer for this test.";
    const response = await PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyText: edited }),
      }),
      { params: Promise.resolve({ conversationId: used! }) },
    );
    const body = (await response.json()) as { revision?: number; error?: string };
    expect(body.error ?? "no error").toBe("no error");
    expect(body.revision).toBe(3);

    const read = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ conversationId: used! }),
    });
    const stored = (await read.json()) as {
      draft: { revisions: { bodyText: string; origin: string }[] } | null;
    };
    // Newest first, and the generated revisions are still there underneath.
    expect(stored.draft?.revisions[0]?.bodyText).toBe(edited);
    expect(stored.draft?.revisions).toHaveLength(3);
    expect(stored.draft?.revisions.filter((r) => r.origin === "generated")).toHaveLength(2);
  }, 60_000);
});
