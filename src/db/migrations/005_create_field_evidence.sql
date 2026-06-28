CREATE TABLE IF NOT EXISTS field_evidence (
  id                  SERIAL PRIMARY KEY,
  case_id             INTEGER REFERENCES cases (id),
  organization_id     INTEGER REFERENCES organizations (id),
  contact_id          INTEGER REFERENCES contacts (id),
  field_name          TEXT NOT NULL,
  field_value         TEXT,
  source_type         TEXT,
  source_name         TEXT,
  source_url          TEXT,
  docket_entry_number TEXT,
  document_id         TEXT,
  extraction_method   TEXT CHECK (extraction_method IN
                        ('courtlistener_structured','document_regex',
                         'document_parser','gemini_resolution',
                         'public_web_source','manual_entry')),
  confidence_score    NUMERIC(4,3),
  retrieved_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_case    ON field_evidence (case_id);
CREATE INDEX IF NOT EXISTS idx_evidence_contact ON field_evidence (contact_id);
CREATE INDEX IF NOT EXISTS idx_evidence_field   ON field_evidence (field_name);
