CREATE TABLE IF NOT EXISTS cases (
  id                          SERIAL PRIMARY KEY,
  courtlistener_docket_id     BIGINT UNIQUE,
  courtlistener_cluster_id    BIGINT,
  courtlistener_absolute_url  TEXT,
  case_number                 TEXT,
  case_name                   TEXT,
  debtor_name                 TEXT,
  chapter                     TEXT,
  is_subchapter_v             BOOLEAN DEFAULT FALSE,
  subchapterv_confidence      TEXT,
  subchapterv_reasons         JSONB,
  court_name                  TEXT,
  court_id                    TEXT,
  district                    TEXT,
  state                       TEXT,
  petition_date               DATE,
  filing_status               TEXT DEFAULT 'active',
  assigned_judge              TEXT,
  date_terminated             DATE,
  date_last_updated           TIMESTAMPTZ,
  first_discovered_at         TIMESTAMPTZ DEFAULT NOW(),
  last_checked_at             TIMESTAMPTZ,
  needs_review                BOOLEAN DEFAULT FALSE,
  review_reason               TEXT,
  raw_hydration_data          JSONB,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_court_case_number
  ON cases (court_id, case_number)
  WHERE case_number IS NOT NULL AND court_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cases_petition_date    ON cases (petition_date);
CREATE INDEX IF NOT EXISTS idx_cases_court_id         ON cases (court_id);
CREATE INDEX IF NOT EXISTS idx_cases_is_subchapter_v  ON cases (is_subchapter_v);
CREATE INDEX IF NOT EXISTS idx_cases_needs_review     ON cases (needs_review);
