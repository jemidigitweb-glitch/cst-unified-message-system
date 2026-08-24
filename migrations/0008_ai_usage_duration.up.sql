-- -----------------------------------------------------------------------------
-- 0008  Generation duration on the AI usage log.
--
-- ADDITIVE, and deliberately nullable. Every row already in this table was
-- written before anything was being timed, and there is no honest value to
-- backfill them with: a zero would say "instant" and any estimate would be a
-- number nobody measured. NULL says "not recorded", which is the truth, and the
-- sidebar prints exactly that.
--
-- ONE TABLE. The duration belongs beside the tokens and the model it describes;
-- a second table keyed on the same revision would be two answers to one
-- question the first time a write half-failed.
--
-- WHAT IS TIMED is the whole user-visible operation: retrieval, File Search,
-- the model call, validation and the save. Not page rendering, and never an
-- estimate -- the route subtracts two monotonic readings taken around the work.
--
-- integer, not smallint: a 120s provider timeout is 120,000 ms, and the column
-- must be able to hold a run that hit it rather than overflow.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.ai_usage_log
  ADD COLUMN IF NOT EXISTS duration_ms integer;

COMMENT ON COLUMN cst_app.ai_usage_log.duration_ms IS
  'Measured wall-clock milliseconds for the whole generation, request to saved draft. NULL means not recorded, never zero.';

-- A negative duration is not a slow run, it is a bug in whoever wrote the row.
ALTER TABLE cst_app.ai_usage_log
  DROP CONSTRAINT IF EXISTS ck_ai_usage_log_duration_non_negative;

ALTER TABLE cst_app.ai_usage_log
  ADD CONSTRAINT ck_ai_usage_log_duration_non_negative
  CHECK (duration_ms IS NULL OR duration_ms >= 0);
