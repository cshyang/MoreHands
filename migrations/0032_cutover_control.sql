CREATE TABLE cutover_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO cutover_control VALUES (1,'closed',0,0);

CREATE TABLE cutover_producers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  generation TEXT NOT NULL CHECK(generation IN ('g1','g2')),
  kind TEXT NOT NULL CHECK(kind IN ('intake','drain')),
  admitted_at INTEGER NOT NULL
);
CREATE INDEX idx_cutover_producers_admitted ON cutover_producers(admitted_at);
