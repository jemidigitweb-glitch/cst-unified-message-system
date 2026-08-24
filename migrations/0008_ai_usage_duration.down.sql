-- Reverses 0008. Dropping the column discards every measured duration; the
-- token counts, models and costs beside them are untouched.
ALTER TABLE cst_app.ai_usage_log
  DROP CONSTRAINT IF EXISTS ck_ai_usage_log_duration_non_negative;

ALTER TABLE cst_app.ai_usage_log
  DROP COLUMN IF EXISTS duration_ms;
