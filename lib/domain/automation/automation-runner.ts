import "server-only";

import type { Pool } from "pg";

import { eligibilityForPostDispatch } from "./automation-eligibility-service";
import { scanRefusal } from "./automation-settings-service";
import { renderTemplate, templateIsUsable, templateVariables } from "./automation-template-service";
import { POST_DISPATCH_AUTOMATION_KEY } from "./automation-types";
import {
  automationSettings,
  cancelItem,
  insertScheduledItem,
  itemExistsForShipment,
  markItemFailed,
  markItemProcessed,
  markItemSkipped,
  refreshRecipientName,
  selectDueItems,
  templateById,
} from "@/lib/repositories/automation-repository";
import {
  type SourceQueryable,
  dispatchEventForShipment,
  findDispatchedShipments,
} from "@/lib/repositories/dispatch-event-repository";

/**
 * The post-dispatch automation run: scan, then process what is due.
 *
 * WHAT IT CAN DO. Read the source, create scheduled records, recheck them when
 * they come due, render a saved template, and record the result locally. That
 * is the whole of it.
 *
 * WHAT IT CANNOT DO. Contact anyone. There is no marketplace client, no mail
 * client, no credential read and no network call of any kind in this module or
 * anything beneath it. A processed record is a rendered string in this
 * application's own database, marked `test_mode`.
 *
 * NO MODEL RUNS HERE EITHER. This automation is deterministic: a template, a
 * set of verified source values, and string substitution. The CST conversation
 * draft workflow is a different feature and is untouched.
 *
 * BOUNDED PER INVOCATION. Both halves take a limit, because this runs inside a
 * serverless function with a hard time budget. Whatever a call does not reach
 * stays exactly where it was: an undiscovered shipment is discovered next tick,
 * and an unprocessed due record is processed next tick.
 */

export type AutomationRunSummary = {
  readonly scan:
    | { readonly ran: false; readonly reason: string }
    | {
        readonly ran: true;
        readonly examined: number;
        readonly created: number;
        readonly duplicates: number;
        readonly ineligible: number;
      };
  readonly due: {
    readonly claimed: number;
    readonly processed: number;
    readonly skipped: number;
    readonly failed: number;
  };
};

const REFUSED_DUE: AutomationRunSummary["due"] = {
  claimed: 0,
  processed: 0,
  skipped: 0,
  failed: 0,
};

export async function runPostDispatchAutomation(input: {
  readonly app: Pool;
  readonly source: SourceQueryable;
  readonly scanLimit?: number;
  readonly draftLimit?: number;
}): Promise<AutomationRunSummary> {
  const scanLimit = Math.max(1, Math.min(input.scanLimit ?? 200, 1_000));
  const processLimit = Math.max(1, Math.min(input.draftLimit ?? 50, 200));

  const settings = await automationSettings(input.app, POST_DISPATCH_AUTOMATION_KEY);
  if (settings === undefined) {
    // A missing row is not "use the defaults". It means 0011 has not been
    // seeded, and inventing a `not_before` here is the backfill this whole
    // design exists to prevent.
    return {
      scan: { ran: false, reason: "Post-dispatch automation is not configured." },
      due: REFUSED_DUE,
    };
  }

  /**
   * ONE REFUSAL COVERS BOTH HALVES, deliberately.
   *
   * An operator who switches the automation off expects it to stop — including
   * for records already scheduled. Draining a queue after the switch was thrown
   * would be the opposite of what "off" means.
   */
  const refusal = scanRefusal(settings);
  if (refusal !== null) {
    return { scan: { ran: false, reason: refusal.reason }, due: REFUSED_DUE };
  }

  // Non-null by the refusal above; narrowed for the type system's benefit.
  const notBefore = settings.notBefore!;
  const templateId = settings.templateId!;

  const template = await templateById(input.app, templateId);
  if (template === undefined || !templateIsUsable(template)) {
    return {
      scan: {
        ran: false,
        reason: "The selected message template is missing, unapproved or inactive.",
      },
      due: REFUSED_DUE,
    };
  }

  let examined = 0;
  let created = 0;
  let duplicates = 0;
  let ineligible = 0;

  const discovered = await findDispatchedShipments(input.source, {
    notBefore,
    subSourceIds: settings.enabledSubSources,
    limit: scanLimit,
  });

  for (const event of discovered) {
    examined += 1;

    // The SQL floor and scope are re-applied in full here, in code, against the
    // same rules the recheck will use. Two implementations agreeing is what
    // makes the query an optimisation rather than the policy.
    if (!eligibilityForPostDispatch(settings, event).eligible) {
      ineligible += 1;
      continue;
    }

    /**
     * BOTH HALVES OF THE DUPLICATE PROTECTION.
     *
     * The application asks first, so the ordinary repeated scan does no write
     * at all; the unique key decides it anyway, so two scans running at once
     * cannot both insert. Neither is sufficient alone and neither is redundant.
     * The check is status-blind, so a shipment already processed is never
     * picked up a second time.
     */
    if (
      await itemExistsForShipment(input.app, {
        automationKey: POST_DISPATCH_AUTOMATION_KEY,
        subSourceId: event.subSourceId,
        shipmentId: event.shipmentId,
      })
    ) {
      duplicates += 1;
      continue;
    }

    const inserted = await insertScheduledItem(input.app, {
      automationKey: POST_DISPATCH_AUTOMATION_KEY,
      event,
      dispatchTimeZone: settings.dispatchTimeZone,
      delayHours: settings.delayHours,
      // Stamped now, so changing the selection tomorrow does not rewrite the
      // provenance of a record queued today.
      templateId: template.id,
      templateVersion: template.version,
      testMode: settings.testMode,
    });
    if (inserted.created) created += 1;
    else duplicates += 1;
  }

  const due = await processDueItems({ ...input, limit: processLimit });

  return { scan: { ran: true, examined, created, duplicates, ineligible }, due };
}

/**
 * Processes every record whose moment has passed, oldest first.
 *
 * EXPORTED SEPARATELY so it can be driven without a scan — and tested without
 * one. The scan and the processing share nothing but the table between them.
 *
 * ONE TRANSACTION HOLDS THE CLAIM. Rows are selected `FOR UPDATE SKIP LOCKED`
 * and every outcome is written inside the same transaction, so a second run
 * cannot take a record this one is working on, and a crash mid-run leaves rows
 * `scheduled` rather than half-processed.
 */
export async function processDueItems(input: {
  readonly app: Pool;
  readonly source: SourceQueryable;
  readonly limit: number;
}): Promise<AutomationRunSummary["due"]> {
  const settings = await automationSettings(input.app, POST_DISPATCH_AUTOMATION_KEY);
  if (settings === undefined || scanRefusal(settings) !== null) return REFUSED_DUE;

  const connection = await input.app.connect();
  let claimed = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await connection.query("BEGIN");
    const items = await selectDueItems(connection, {
      automationKey: POST_DISPATCH_AUTOMATION_KEY,
      limit: input.limit,
    });
    claimed = items.length;

    for (const item of items) {
      /**
       * THE RECHECK, ON A FRESH SOURCE READ — the reason this step exists.
       *
       * The scan's snapshot is a day old by now, and a day is exactly how long
       * it takes an order to be cancelled, refunded or returned. Rendering from
       * the stored copy would produce a cheerful dispatch update about a parcel
       * the customer has already sent back.
       */
      const event = await dispatchEventForShipment(input.source, item.shipmentId);
      if (event === undefined) {
        await markItemSkipped(connection, { id: item.id, reason: "SHIPMENT_NOT_FOUND" });
        skipped += 1;
        continue;
      }

      const eligible = eligibilityForPostDispatch(settings, event);
      if (!eligible.eligible) {
        await markItemSkipped(connection, { id: item.id, reason: eligible.reason });
        skipped += 1;
        continue;
      }

      // The name shown beside the record comes from the same read the message
      // is rendered from, so a correction in the order system shows here too.
      await refreshRecipientName(connection, {
        id: item.id,
        recipientName: event.customerName,
      });

      /**
       * THE TEMPLATE THIS RECORD WAS QUEUED AGAINST, by id AND version — not
       * whichever one is selected now. A record processed today must be
       * accounted for against the wording that governed it when it was created.
       */
      const template = await templateById(connection, item.templateId);
      if (template === undefined || !templateIsUsable(template)) {
        await markItemFailed(connection, { id: item.id, reason: "TEMPLATE_NOT_USABLE" });
        failed += 1;
        continue;
      }
      if (template.version !== item.templateVersion) {
        await markItemFailed(connection, { id: item.id, reason: "TEMPLATE_VERSION_CHANGED" });
        failed += 1;
        continue;
      }

      const rendered = renderTemplate(template, templateVariables(event));
      if (!rendered.ok) {
        // Named, so an operator can see which value the source did not carry
        // rather than being told the template "failed".
        await markItemFailed(connection, {
          id: item.id,
          reason: `MISSING_TEMPLATE_VALUES: ${rendered.missing.join(", ")}`,
        });
        failed += 1;
        continue;
      }

      /**
       * TEST MODE IS THE ONLY MODE, and this is where that is enforced in code
       * rather than assumed. A record created while test mode was somehow off
       * cannot be processed — it fails, saying so — because the alternative
       * would be an application that quietly recorded a transmission it never
       * made. `markItemProcessed` re-asserts the same condition in SQL, and the
       * table's CHECK constraint refuses the row outright.
       */
      if (!item.testMode || !settings.testMode) {
        await markItemFailed(connection, { id: item.id, reason: "NO_TRANSPORT_CONFIGURED" });
        failed += 1;
        continue;
      }

      const ok = await markItemProcessed(connection, {
        id: item.id,
        renderedBody: rendered.body,
      });
      if (ok) processed += 1;
      else failed += 1;
    }

    await connection.query("COMMIT");
  } catch (cause) {
    await connection.query("ROLLBACK").catch(() => {});
    // The underlying error may name a schema or a column, so it is logged and
    // never returned. Nothing was committed, so every record stays scheduled.
    console.error("[automation] processing failed", cause);
    throw cause;
  } finally {
    connection.release();
  }

  return { claimed, processed, skipped, failed };
}

/** An operator stopping one scheduled record. Nothing else can be cancelled. */
export async function cancelScheduledItem(
  app: Pool,
  input: { readonly id: string; readonly reason: string | null },
): Promise<boolean> {
  return cancelItem(app, input);
}
