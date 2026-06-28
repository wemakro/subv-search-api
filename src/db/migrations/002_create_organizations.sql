CREATE TABLE IF NOT EXISTS organizations (
  id                    SERIAL PRIMARY KEY,
  organization_name     TEXT NOT NULL,
  legal_name            TEXT,
  organization_type     TEXT CHECK (organization_type IN
                          ('debtor_company','law_firm','trustee_firm','other')),
  website               TEXT,
  domain                TEXT,
  primary_phone         TEXT,
  address_line_1        TEXT,
  address_line_2        TEXT,
  city                  TEXT,
  state                 TEXT,
  zip                   TEXT,
  country               TEXT DEFAULT 'US',
  industry              TEXT,
  employee_range        TEXT,
  annual_revenue_range  TEXT,
  linkedin_url          TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_type   ON organizations (organization_type);
CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations (domain);
CREATE INDEX IF NOT EXISTS idx_organizations_name   ON organizations (organization_name);
