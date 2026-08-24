-- Reverses 0009. Drops the record of which conversations the rule base could
-- not answer; no draft, conversation or message row is touched, because this
-- table references them and owns nothing they depend on.
DROP TABLE IF EXISTS cst_app.conversation_rule_analysis;
