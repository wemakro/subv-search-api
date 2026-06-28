"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

function splitName(fullName) {
  if (!fullName) return { first: null, middle: null, last: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], middle: null, last: null };
  if (parts.length === 2) return { first: parts[0], middle: null, last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
}

async function upsertContact(contact) {
  const name = splitName(contact.full_name || contact.name);
  const sql = `
    INSERT INTO contacts (
      first_name, middle_name, last_name, full_name,
      title, contact_type, organization_id,
      primary_email, primary_email_status, primary_email_confidence,
      primary_phone,
      address_line_1, city, state, zip,
      verification_status, overall_confidence_score,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;

  const params = [
    name.first,
    name.middle,
    name.last,
    contact.full_name || contact.name,
    contact.title || null,
    contact.contact_type || "other",
    contact.organization_id || null,
    contact.primary_email || contact.email || null,
    contact.primary_email_status || "unverified",
    contact.primary_email_confidence || null,
    contact.primary_phone || contact.phone || null,
    contact.address_line_1 || null,
    contact.city || null,
    contact.state || null,
    contact.zip || null,
    contact.verification_status || "unverified",
    contact.overall_confidence_score || null,
  ];

  try {
    let result = await query(sql, params);
    if (result.rows.length > 0) return result.rows[0];
    // Already exists — find by name and type
    result = await query(
      `SELECT * FROM contacts
       WHERE full_name = $1 AND contact_type = $2
       ORDER BY created_at ASC LIMIT 1`,
      [params[3], params[5]]
    );
    if (result.rows[0]) {
      // Update with better data if available
      await query(
        `UPDATE contacts SET
          primary_email = COALESCE(primary_email, $1),
          primary_phone = COALESCE(primary_phone, $2),
          title         = COALESCE(title, $3),
          organization_id = COALESCE(organization_id, $4),
          updated_at    = NOW()
        WHERE id = $5`,
        [
          contact.primary_email || contact.email || null,
          contact.primary_phone || contact.phone || null,
          contact.title || null,
          contact.organization_id || null,
          result.rows[0].id,
        ]
      );
      return result.rows[0];
    }
    return null;
  } catch(e) {
    logger.error("upsertContact failed:", e.message);
    throw e;
  }
}

async function linkContactToCase(caseId, contactId, role, opts = {}) {
  const sql = `
    INSERT INTO case_contacts (
      case_id, contact_id, role, is_primary,
      source_type, source_url, confidence_score
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (case_id, contact_id, role) DO UPDATE SET
      confidence_score = COALESCE(EXCLUDED.confidence_score, case_contacts.confidence_score),
      updated_at       = NOW()
    RETURNING *
  `;
  const result = await query(sql, [
    caseId, contactId, role,
    opts.isPrimary || false,
    opts.sourceType || null,
    opts.sourceUrl  || null,
    opts.confidence || null,
  ]);
  return result.rows[0];
}

async function getContactsByCase(caseId) {
  const result = await query(
    `SELECT c.*, cc.role, cc.is_primary, cc.confidence_score
     FROM contacts c
     JOIN case_contacts cc ON cc.contact_id = c.id
     WHERE cc.case_id = $1
     ORDER BY cc.is_primary DESC, c.contact_type`,
    [caseId]
  );
  return result.rows;
}

async function countContacts() {
  const result = await query("SELECT COUNT(*) AS total FROM contacts");
  return parseInt(result.rows[0].total, 10);
}

module.exports = {
  upsertContact,
  linkContactToCase,
  getContactsByCase,
  countContacts,
};
