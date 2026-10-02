-- Browser reading progress is per principal and independent of native inbox
-- seen/accepted state and transport receipts. Journal positions are not counts.
CREATE TABLE IF NOT EXISTS navigation_reads (
 principal_id text NOT NULL REFERENCES principals(id),
 channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 last_read_seq bigint NOT NULL CHECK(last_read_seq >= 0),
 PRIMARY KEY(principal_id,channel_id)
);
CREATE INDEX IF NOT EXISTS navigation_reads_channel ON navigation_reads(channel_id);
