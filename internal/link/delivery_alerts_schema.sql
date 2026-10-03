-- Global owner policy only. Alerts remain derived from immutable messages and
-- attributed receipts; project deletion needs no additional alert-row cleanup.
CREATE TABLE IF NOT EXISTS delivery_alert_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 ack_timeout_seconds integer NOT NULL DEFAULT 300 CHECK(ack_timeout_seconds BETWEEN 60 AND 86400),
 reply_timeout_seconds integer NOT NULL DEFAULT 1800 CHECK(reply_timeout_seconds=0 OR (reply_timeout_seconds>=ack_timeout_seconds AND reply_timeout_seconds<=604800)),
 enabled_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 CHECK(NOT enabled OR enabled_at IS NOT NULL)
);
INSERT INTO delivery_alert_policy(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS messages_delivery_deadline ON messages(created_at,id);
CREATE INDEX IF NOT EXISTS messages_direct_reply ON messages(reply_to,channel_id,author_id,created_at) WHERE reply_to IS NOT NULL;
