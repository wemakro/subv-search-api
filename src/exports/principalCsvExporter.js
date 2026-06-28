"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

function escapeCell(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/^[=+\-@]/.test(str)) return `'${str}`;
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsv(row) { return row.map(escapeCell).join(","); }
function formatDate(val) {
  if (!val) return "";
  try { return new Date(val).toISOString().slice(0, 10); } catch(e) { return ""; }
}

const HEADERS = [
  "export_generated_at",
  "case_number",
  "case_name",
  "debtor_name",
  "is_subchapter_v",
  "petition_date",
  "days_since_petition",
  "court_id",
  "state",
  "courtlistener_case_url",
  "contact_internal_id",
  "full_name",
  "first_name",
  "last_name",
  "title",
  "primary_email",
  "primary_email_status",
  "primary_phone",
  "verification_status",
  "overall_confidence_score",
  "organization_name",
  "organization_website",
  "organization_phone",
  "organization_address_1",
  "organization_city",
  "organization_state",
  "outreach_priority",
  "needs_review",
  "approved_for_crm_import",
];

async function generatePrincipalCsv() {
  const generatedAt = new Date().toISOString();

  const result = await query(`
    SELECT
      c.case_number,
      c.case_name,
      c.debtor_name,
      c.is_subchapter_v,
      c.petition_date,
      c.court_id,
      c.state,
      c.courtlistener_absolute_url,
      c.needs_review,
      ct.id            AS contact_id,
      ct.full_name,
      ct.first_name,
      ct.last_name,
      ct.title,
      ct.primary_email,
      ct.primary_email_status,
      ct.primary_phone,
      ct.verification_status,
      ct.overall_confidence_score,
      o.organization_name,
      o.website        AS org_website,
      o.primary_phone  AS org_phone,
      o.address_line_1,
      o.city,
      o.state          AS org_state
    FROM cases c
    JOIN case_contacts cc ON cc.case_id = c.id
    JOIN contacts ct      ON ct.id = cc.contact_id
    LEFT JOIN organizations o ON o.id = ct.organization_id
    WHERE ct.contact_type = 'principal'
      AND (ct.do_not_contact = FALSE OR ct.do_not_contact IS NULL)
    ORDER BY c.petition_date DESC
  `);

  const lines = [HEADERS.join(",")];

  for (const row of result.rows) {
    const petitionDate = row.petition_date ? new Date(row.petition_date) : null;
    const daysSince    = petitionDate
      ? Math.floor((Date.now() - petitionDate.getTime()) / 86400000)
      : null;

    let priority = "low";
    if (daysSince !== null) {
      if (daysSince <= 3)  priority = "urgent";
      else if (daysSince <= 10) priority = "high";
      else if (daysSince <= 21) priority = "medium";
    }

    lines.push(rowToCsv([
      generatedAt,
      row.case_number,
      row.case_name,
      row.debtor_name,
      row.is_subchapter_v ? "yes" : "no",
      formatDate(row.petition_date),
      daysSince !== null ? daysSince : "",
      row.court_id,
      row.state,
      row.courtlistener_absolute_url,
      row.contact_id,
      row.full_name,
      row.first_name,
      row.last_name,
      row.title,
      row.primary_email,
      row.primary_email_status,
      row.primary_phone,
      row.verification_status,
      row.overall_confidence_score,
      row.organization_name,
      row.org_website,
      row.org_phone,
      row.address_line_1,
      row.city,
      row.org_state,
      priority,
      row.needs_review ? "yes" : "no",
      "no",
    ]));
  }

  logger.info(`Principals CSV generated: ${lines.length - 1} rows`);
  return { csv: lines.join("\n"), rowCount: lines.length - 1 };
}

module.exports = { generatePrincipalCsv };
