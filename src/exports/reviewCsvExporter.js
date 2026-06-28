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
  "case_internal_id",
  "case_number",
  "case_name",
  "debtor_name",
  "petition_date",
  "days_since_petition",
  "court_id",
  "state",
  "courtlistener_case_url",
  "review_reason",
  "principal_found",
  "attorney_found",
  "trustee_found",
  "manual_action_needed",
];

async function generateReviewCsv() {
  const generatedAt = new Date().toISOString();

  const result = await query(`
    SELECT
      c.id                AS case_id,
      c.case_number,
      c.case_name,
      c.debtor_name,
      c.petition_date,
      c.court_id,
      c.state,
      c.courtlistener_absolute_url,
      c.review_reason,
      COUNT(cc.id) FILTER (WHERE ct.contact_type = 'principal')            AS principal_count,
      COUNT(cc.id) FILTER (WHERE ct.contact_type = 'debtor_attorney')      AS attorney_count,
      COUNT(cc.id) FILTER (WHERE ct.contact_type = 'subchapter_v_trustee') AS trustee_count
    FROM cases c
    LEFT JOIN case_contacts cc ON cc.case_id = c.id
    LEFT JOIN contacts ct      ON ct.id = cc.contact_id
    WHERE c.needs_review = TRUE
    GROUP BY c.id, c.case_number, c.case_name, c.debtor_name,
             c.petition_date, c.court_id, c.state,
             c.courtlistener_absolute_url, c.review_reason
    ORDER BY c.petition_date DESC
  `);

  const lines = [HEADERS.join(",")];

  for (const row of result.rows) {
    const petitionDate = row.petition_date ? new Date(row.petition_date) : null;
    const daysSince    = petitionDate
      ? Math.floor((Date.now() - petitionDate.getTime()) / 86400000)
      : null;

    lines.push(rowToCsv([
      generatedAt,
      row.case_id,
      row.case_number,
      row.case_name,
      row.debtor_name,
      formatDate(row.petition_date),
      daysSince !== null ? daysSince : "",
      row.court_id,
      row.state,
      row.courtlistener_absolute_url,
      row.review_reason,
      parseInt(row.principal_count) > 0 ? "yes" : "no",
      parseInt(row.attorney_count)  > 0 ? "yes" : "no",
      parseInt(row.trustee_count)   > 0 ? "yes" : "no",
      "Manual review required — check CourtListener for principal identity",
    ]));
  }

  logger.info(`Review CSV generated: ${lines.length - 1} rows`);
  return { csv: lines.join("\n"), rowCount: lines.length - 1 };
}

module.exports = { generateReviewCsv };
