CREATE TABLE IF NOT EXISTS export_runs (
  id                  SERIAL PRIMARY KEY,
  automation_run_id   INTEGER REFERENCES automation_runs (id),
  export_type         TEXT CHECK (export_type IN
                        ('master','principals','attorneys','trustees',
                         'needs_review','close_import',
                         'attorney_summary','trustee_summary')),
  filename            TEXT,
  file_path           TEXT,
  row_count           INTEGER,
  checksum            TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exports_run  ON export_runs (automation_run_id);
CREATE INDEX IF NOT EXISTS idx_exports_type ON export_runs (export_type);
