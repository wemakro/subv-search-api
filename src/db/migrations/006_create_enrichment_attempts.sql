CREATE TABLE IF NOT EXISTS enrichment_attempts (
  id                SERIAL PRIMARY KEY,
  case_id           INTEGER REFERENCES cases (id),
  contact_id        INTEGER REFERENCES contacts (id),
  organization_id   INTEGER REFERENCES organizations (id),
  enrichment_stage  TEXT,
  provider          TEXT,
  request_status    TEXT CHECK (request_status IN
                      ('success','failed','skipped','partial')),
  input_summary     TEXT,
  response_summary  TEXT,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_case  ON enrichment_attempts (case_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_stage ON enrichment_attempts (enrichment_stage);
