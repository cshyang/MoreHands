CREATE TABLE IF NOT EXISTS slack_reply_trackers (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT,
  uid TEXT,
  target_json TEXT NOT NULL,
  persona_json TEXT,
  ack_message_ts TEXT,
  publish INTEGER NOT NULL CHECK(publish IN (0,1)),
  response_id TEXT,
  receipt_completed_at INTEGER,
  outcome TEXT CHECK(outcome IN ('completed','failed','aborted')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','staged','delivered','silent','empty','failed','aborted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(instance_id,event_id)
);
CREATE INDEX IF NOT EXISTS idx_slack_reply_trackers_pending
ON slack_reply_trackers(status,instance_id);
CREATE INDEX IF NOT EXISTS idx_slack_reply_trackers_submission
ON slack_reply_trackers(instance_id,submission_id);
