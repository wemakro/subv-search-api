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
  "contact_internal_id",
  "full_name",
  "first_name",
  "last_name",
  "primary_email",
  "primary_email_status",
  "primary_phone",
  "verification_status",
  "case_count",
  "earliest_case_date",
  "most_recent_case_date",
  "case_numbers",
  "districts",
  "states",
  "approved_for_crm_import",
];

async function generateTrusteeCsv() {
  const generatedAt = new Date().toISOString();

  const result = await query(`
    SELECT
      ct.id                               AS contact_id,
      ct.full_name,
      ct.first_name,
      ct.last_name,
      ct.primary_email,
      ct.primary_email_status,
      ct.primary_phone,
      ct.verification_status,
      COUNT(DISTINCT cc.case_id)          AS case_count,
      MIN(c.petition_date)                AS earliest_case,
      MAX(c.petition_date)                AS latest_case,
      STRING_AGG(DISTINCT c.case_number, ' | ' ORDER BY c.case_number) AS case_numbers,
      STRING_AGG(DISTINCT c.court_id,    ' | ' ORDER BY c.court_id)    AS districts,
      STRING_AGG(DISTINCT c.state,       ' | ' ORDER BY c.state)       AS states
    FROM contacts ct
    JOIN case_contacts cc ON cc.contact_id = ct.id
    JOIN cases c          ON c.id = cc.case_id
    WHERE ct.contact_type = 'subchapter_v_trustee'
      AND (ct.do_not_contact = FALSE OR ct.do_not_contact IS NULL)
    GROUP BY ct.id, ct.full_name, ct.first_name, ct.last_name,
             ct.primary_email, ct.primary_email_status,
             ct.primary_phone, ct.verification_status
    ORDER BY case_count DESC, ct.full_name
  `);

  const lines = [HEADERS.join(",")];

  for (const row of result.rows) {
    lines.push(rowToCsv([
      generatedAt,
      row.contact_id,
      row.full_name,
      row.first_name,
      row.last_name,
      row.primary_email,
      row.primary_email_status,
      row.primary_phone,
      row.verification_status,
      row.case_count,
      formatDate(row.earliest_case),
      formatDate(row.latest_case),
      row.case_numbers,
      row.districts,
      row.states,
      "no",
    ]));
  }

  logger.info(`Trustees CSV generated: ${lines.length - 1} rows`);
  return { csv: lines.join("\n"), rowCount: lines.length - 1 };
}

module.exports = { generateTrusteeCsv };
