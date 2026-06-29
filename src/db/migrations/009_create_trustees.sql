CREATE TABLE IF NOT EXISTS trustees (
  id                  SERIAL PRIMARY KEY,
  district_code       TEXT NOT NULL,
  district_name       TEXT,
  full_name           TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  contact_type        TEXT DEFAULT 'subchapter_v_trustee',
  program_type        TEXT DEFAULT 'USTP',
  appointment_type    TEXT DEFAULT 'case_by_case',
  source_url          TEXT,
  source_verified_at  DATE,
  active              BOOLEAN DEFAULT TRUE,
  outreach_status     TEXT DEFAULT 'not_contacted',
  last_contacted_at   TIMESTAMPTZ,
  next_follow_up_at   TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trustees_district ON trustees (district_code);
CREATE INDEX IF NOT EXISTS idx_trustees_name     ON trustees (full_name);
CREATE INDEX IF NOT EXISTS idx_trustees_active   ON trustees (active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trustees_district_name
  ON trustees (district_code, full_name);
