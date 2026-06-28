CREATE TABLE IF NOT EXISTS case_contacts (
  id                  SERIAL PRIMARY KEY,
  case_id             INTEGER NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  contact_id          INTEGER NOT NULL REFERENCES contacts (id),
  role                TEXT,
  is_primary          BOOLEAN DEFAULT FALSE,
  representation_type TEXT,
  source_type         TEXT,
  source_reference    TEXT,
  source_url          TEXT,
  confidence_score    NUMERIC(4,3),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (case_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS idx_case_contacts_case    ON case_contacts (case_id);
CREATE INDEX IF NOT EXISTS idx_case_contacts_contact ON case_contacts (contact_id);
