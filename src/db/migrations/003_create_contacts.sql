CREATE TABLE IF NOT EXISTS contacts (
  id                        SERIAL PRIMARY KEY,
  first_name                TEXT,
  middle_name               TEXT,
  last_name                 TEXT,
  full_name                 TEXT NOT NULL,
  title                     TEXT,
  contact_type              TEXT CHECK (contact_type IN
                              ('principal','debtor_attorney',
                               'subchapter_v_trustee','other')),
  organization_id           INTEGER REFERENCES organizations (id),
  primary_email             TEXT,
  primary_email_status      TEXT DEFAULT 'unverified',
  primary_email_confidence  NUMERIC(4,3),
  secondary_email           TEXT,
  primary_phone             TEXT,
  primary_phone_status      TEXT DEFAULT 'unverified',
  secondary_phone           TEXT,
  linkedin_url              TEXT,
  website                   TEXT,
  address_line_1            TEXT,
  address_line_2            TEXT,
  city                      TEXT,
  state                     TEXT,
  zip                       TEXT,
  country                   TEXT DEFAULT 'US',
  verification_status       TEXT DEFAULT 'unverified'
                              CHECK (verification_status IN
                              ('unverified','partially_verified','verified',
                               'needs_review','rejected')),
  overall_confidence_score  NUMERIC(4,3),
  do_not_contact            BOOLEAN DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_type         ON contacts (contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_full_name    ON contacts (full_name);
CREATE INDEX IF NOT EXISTS idx_contacts_email        ON contacts (primary_email);
CREATE INDEX IF NOT EXISTS idx_contacts_organization ON contacts (organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_dnc          ON contacts (do_not_contact);
