"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

async function upsertOrganization(org) {
  const sql = `
    INSERT INTO organizations (
      organization_name, legal_name, organization_type,
      website, domain, primary_phone,
      address_line_1, city, state, zip, country,
      industry, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  const domain = org.website
    ? (function() {
        try { return new URL(org.website).hostname.replace(/^www\./, ""); }
        catch(e) { return null; }
      })()
    : null;

  const params = [
    org.organization_name || org.name,
    org.legal_name || null,
    org.organization_type || "debtor_company",
    org.website || null,
    domain,
    org.primary_phone || org.phone || null,
    org.address_line_1 || org.address || null,
    org.city || null,
    org.state || null,
    org.zip || null,
    org.country || "US",
    org.industry || null,
  ];

  try {
    let result = await query(sql, params);
    if (result.rows.length > 0) return result.rows[0];
    // Already existed — fetch it
    result = await query(
      "SELECT * FROM organizations WHERE organization_name = $1 AND organization_type = $2 LIMIT 1",
      [params[0], params[2]]
    );
    return result.rows[0] || null;
  } catch(e) {
    logger.error("upsertOrganization failed:", e.message);
    throw e;
  }
}

async function getOrganizationById(id) {
  const result = await query("SELECT * FROM organizations WHERE id = $1", [id]);
  return result.rows[0] || null;
}

module.exports = { upsertOrganization, getOrganizationById };
