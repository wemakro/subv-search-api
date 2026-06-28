CREATE TABLE IF NOT EXISTS automation_runs (
  id                      SERIAL PRIMARY KEY,
  run_type                TEXT DEFAULT 'daily',
  started_at              TIMESTAMPTZ DEFAULT NOW(),
  completed_at            TIMESTAMPTZ,
  status                  TEXT DEFAULT 'queued'
                            CHECK (status IN
                            ('queued','running','completed',
                             'completed_with_errors','failed')),
  search_start_date       DATE,
  search_end_date         DATE,
  cases_found             INTEGER DEFAULT 0,
  new_cases_created       INTEGER DEFAULT 0,
  existing_cases_updated  INTEGER DEFAULT 0,
  contacts_created        INTEGER DEFAULT 0,
  contacts_updated        INTEGER DEFAULT 0,
  cases_failed            INTEGER DEFAULT 0,
  error_summary           JSONB,
  triggered_by            TEXT DEFAULT 'cron',
  dry_run                 BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_status  ON automation_runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON automation_runs (started_at);
