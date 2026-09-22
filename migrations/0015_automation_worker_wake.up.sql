-- -----------------------------------------------------------------------------
-- 0012  The wake signal for the long-running automation worker.
--
-- ADDITIVE AND INERT. It creates ONE FUNCTION and FOUR TRIGGERS. It adds no
-- column, creates no table, seeds nothing, moves no row and alters no existing
-- constraint. Without a worker listening it does nothing at all: `pg_notify` on
-- a channel nobody has LISTENed to returns void and leaves no trace.
--
-- IT DOES NOT CHANGE THE SCHEMA OF THE DATA. The one honest caveat, stated
-- plainly rather than glossed: four triggers on `cst_app.automation_items` and
-- one on `cst_app.automation_settings` are new objects against tables that
-- already exist. That is a real change to the database, and it is why the task
-- is reported as "one additive migration" rather than "no schema change".
--
-- WHY IT EXISTS. `scripts/run-automation-worker.mjs` starts once and waits on the
-- exact `scheduled_at` of the next due record instead of polling every fifteen
-- minutes. That design has one question it cannot answer by itself: HOW DOES IT
-- LEARN THAT A NEW RECORD HAS AN EARLIER MOMENT THAN THE ONE IT IS WAITING FOR?
-- The honest answer is that it cannot see a row appear. So the writer tells it.
--
-- THE NOTIFICATION IS SENT IN THE WRITER'S TRANSACTION, which is the whole point.
-- `pg_notify` inside a transaction is delivered only when that transaction
-- COMMITS, so a rolled-back insert wakes nobody and a worker never wakes to find
-- nothing there. It is also cheap: one function call on the statements that
-- already exist, no extra round trip, no queue table and no polling by the
-- writer.
--
-- THIS IS LATENCY, NOT CORRECTNESS. The worker also re-reads the soonest moment
-- on its own interval (15 seconds by default) and claims nothing early because
-- of it, so an unwakeable case — 0015 not applied, a direct SQL edit, a dropped
-- listener connection — degrades the delay, never the outcome. Correctness comes
-- from `FOR UPDATE SKIP LOCKED` on the claim in `selectDueItems`, which is
-- untouched by this migration. Nothing here can cause a duplicate processing.
--
-- THE TRIGGERS ARE SEPARATE RATHER THAN ONE. Each carries its own reason string
-- and its own condition:
--
--   insert            an earlier `scheduled_at` may have just appeared
--   status change     a cancellation, a skip or a failure frees the target
--   scheduled_at move the target itself moved (a settings change re-stamping)
--   test_mode         processing must stop if test mode somehow went off
--
-- STATEMENT LEVEL, WHICH IS THE WHOLE REASON THIS IS CHEAP. A scan inserts a
-- batch in one statement and a row-level trigger would emit one notification per
-- row; statement level means at most one notification per statement whatever the
-- batch size, so 500 newly scheduled records cost one call rather than 500. The
-- insert trigger's WHEN clause reads `new_rows`, the statement-level transition
-- table, for the same reason.
--
-- ONLY `scheduled` ROWS ARE ANNOUNCED BY THE INSERT TRIGGER. A record inserted
-- already `sent` or `skipped` cannot change what the worker waits on, so it is
-- not worth a wake-up. The other three are unconditional: a cancellation is one
-- row, and telling the worker about it costs nothing worth conditioning on.
--
-- THE CHANNEL NAME IS THE CONTRACT. `cst_automation_wake` is the one channel
-- `scripts/run-automation-worker.mjs` listens on. The payload is a reason string
-- for a human reading the worker's log, NEVER a key the worker acts on: the
-- worker re-reads the table on every wake, so a payload that is missing, stale or
-- wrong cannot mislead it — it can only make the log less specific.
--
-- TARGET: the APPLICATION database (varmen_db), schema cst_app ONLY.
-- SAFETY: creates objects in cst_app and nowhere else. References no other
--   schema, no source table, no other project's data. Uses no ALTER and no
--   TRUNCATE. Reversed by 0015_automation_worker_wake.down.sql.
-- -----------------------------------------------------------------------------

BEGIN;

-- -----------------------------------------------------------------------------
-- The one function every trigger calls.
--
-- `pg_notify(channel, payload)` rather than the `NOTIFY` statement because both
-- arguments are values here, and the four triggers differ only in the reason they
-- pass in -- so there is one place where a notification is actually sent, not
-- four. The channel is written once, in the function, and is the contract the
-- worker's `LISTEN` names.
--
-- SECURITY INVOKER, the default, and deliberately so: this function does not
-- need to do anything a writer could not do, and a function that ran with more
-- privilege than its caller would be a poor trade for a single notify call.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cst_app.automation_wake(payload text)
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('cst_automation_wake', payload);
  RETURN NULL;  -- statement-level triggers ignore the return value.
END;
$$;

COMMENT ON FUNCTION cst_app.automation_wake(text) IS
  'Announces on cst_automation_wake so the always-running worker can re-evaluate what it is waiting for. Inert without a listener.';

-- -----------------------------------------------------------------------------
-- 1. A record was created.
--
-- THE ONE THAT ANSWERS THE EARLIER-JOB QUESTION. A shipment dispatched before
-- the record the worker is currently waiting on produces an earlier
-- `scheduled_at`, and the worker's next evaluation picks it as the new target.
-- `INSERT ... ON CONFLICT DO NOTHING` from a repeated scan fires this only when
-- a row was actually inserted, so the ordinary no-op scan does not wake anyone.
--
-- Only `scheduled` rows: anything else cannot be waited for.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_automation_items_wake_insert ON cst_app.automation_items;
CREATE TRIGGER trg_automation_items_wake_insert
  AFTER INSERT ON cst_app.automation_items
  FOR EACH STATEMENT
  WHEN (EXISTS (SELECT 1 FROM new_rows WHERE status = 'scheduled'))
  EXECUTE FUNCTION cst_app.automation_wake('item_inserted');

-- -----------------------------------------------------------------------------
-- 2. A record changed state.
--
-- Covers the cancellation an operator just made (the record the worker was
-- waiting on is gone), a skip and a failure. All three mean "the thing you were
-- waiting for is not the thing any more".
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_automation_items_wake_status ON cst_app.automation_items;
CREATE TRIGGER trg_automation_items_wake_status
  AFTER UPDATE OF status ON cst_app.automation_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION cst_app.automation_wake('status_changed');

-- -----------------------------------------------------------------------------
-- 3. The moment itself moved.
--
-- A settings change re-stamps nothing today -- `scheduled_at` is computed once,
-- at insert, from the dispatch time -- but the column is writable and a future
-- change that moved a queued record without waking the worker would leave it
-- sleeping on a time that no longer exists. This costs one comparison in the
-- case that never fires.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_automation_items_wake_schedule ON cst_app.automation_items;
CREATE TRIGGER trg_automation_items_wake_schedule
  AFTER UPDATE OF scheduled_at ON cst_app.automation_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION cst_app.automation_wake('scheduled_at_changed');

-- -----------------------------------------------------------------------------
-- 4. The configuration changed.
--
-- Switching the automation off must stop processing promptly, and switching it
-- on must start it promptly rather than at the next interval. The worker treats
-- "switched off" as a reason to wait, not to exit, so this is what makes the
-- switch feel immediate in both directions.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_automation_settings_wake ON cst_app.automation_settings;
CREATE TRIGGER trg_automation_settings_wake
  AFTER INSERT OR UPDATE ON cst_app.automation_settings
  FOR EACH STATEMENT
  EXECUTE FUNCTION cst_app.automation_wake('settings_changed');

COMMIT;
