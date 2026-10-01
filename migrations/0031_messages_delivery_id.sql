-- External reply parts are reflected once even when delivery recovery runs repeatedly.
ALTER TABLE messages ADD COLUMN delivery_id TEXT;
CREATE UNIQUE INDEX idx_messages_delivery ON messages(delivery_id);
