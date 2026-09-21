import { NextResponse } from "next/server";

import {
  scanRefusal,
  settingsPatchRefusal,
} from "@/lib/domain/automation/automation-settings-service";
import {
  POST_DISPATCH_AUTOMATION_KEY,
  automationSettingsPatchSchema,
} from "@/lib/domain/automation/automation-types";
import { getAppPool } from "@/lib/db/pools";
import {
  automationSettings,
  isAutomationStoreMissing,
  updateAutomationSettings,
} from "@/lib/repositories/automation-repository";

/**
 * Post-dispatch automation configuration.
 *
 *   GET    the current configuration and whether scanning is running
 *   PATCH  switch it on or off, change the delay, the storefronts, the floor
 *
 * THE SECOND MUTABLE THING IN THIS APPLICATION, and the first that is not a
 * draft. `tests/guards/api-surface.test.ts` carries a narrow exemption for this
 * exact path, plus a test pinning what it may write.
 *
 * IT CANNOT MOVE A RECORD. This route touches `automation_settings` and
 * nothing else: no status, no result, and — there being no such thing anywhere
 * in this phase — no transport. Switching the automation ON causes records to
 * be scheduled and, when due, processed in TEST MODE. It does not cause a
 * message to be transmitted to anybody, because nothing in this application can
 * do that.
 *
 * SWITCHING ON REQUIRES A FLOOR, A STOREFRONT AND A TEMPLATE.
 * `settingsPatchRefusal` rejects `enabled: true` without them — that one click
 * would otherwise queue a record for every shipment this business has ever
 * sent. It also refuses `testMode: false` outright: there is no transport, so
 * a live run could only fail.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const settings = await automationSettings(getAppPool(), POST_DISPATCH_AUTOMATION_KEY);
    if (settings === undefined) {
      return NextResponse.json({ error: "Automation is not configured" }, { status: 404 });
    }
    const refusal = scanRefusal(settings);
    return NextResponse.json({
      settings,
      scanStatus:
        refusal === null ? { running: true, reason: null } : { running: false, reason: refusal.reason },
    });
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json({ error: "Automation storage is not available yet." }, { status: 503 });
    }
    console.error("[automations] settings read failed", cause);
    return NextResponse.json({ error: "Unable to load automation settings" }, { status: 500 });
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const parsed = automationSettingsPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid automation configuration" }, { status: 400 });
  }

  try {
    const pool = getAppPool();
    const current = await automationSettings(pool, POST_DISPATCH_AUTOMATION_KEY);
    if (current === undefined) {
      return NextResponse.json({ error: "Automation is not configured" }, { status: 404 });
    }

    const refused = settingsPatchRefusal(current, parsed.data);
    if (refused !== null) {
      return NextResponse.json({ error: refused, code: "unsafe_configuration" }, { status: 400 });
    }

    const settings = await updateAutomationSettings(
      pool,
      POST_DISPATCH_AUTOMATION_KEY,
      parsed.data,
    );
    if (settings === undefined) {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
    }

    const refusal = scanRefusal(settings);
    return NextResponse.json({
      settings,
      scanStatus:
        refusal === null ? { running: true, reason: null } : { running: false, reason: refusal.reason },
    });
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json({ error: "Automation storage is not available yet." }, { status: 503 });
    }
    console.error("[automations] settings update failed", cause);
    return NextResponse.json({ error: "Unable to update automation settings" }, { status: 500 });
  }
}
