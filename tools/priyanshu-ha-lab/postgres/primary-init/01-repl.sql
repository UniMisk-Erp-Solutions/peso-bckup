-- Priyanshu HA lab only (not production)
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replpass';
CREATE TABLE IF NOT EXISTS ha_lab_probe (
  id serial PRIMARY KEY,
  node text NOT NULL,
  note text,
  created_at timestamptz DEFAULT now()
);
INSERT INTO ha_lab_probe (node, note) VALUES ('46', 'primary_seed');
