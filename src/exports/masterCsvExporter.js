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
  "automation_run_id",
  "record_status",
  "needs_review",
  "review_reason",
  "case_internal_id",
  "courtlistener_docket_id",
  "case_number",
  "case_name",
  "debtor_name",
  "chapter",
  "is_subchapter_v",
  "petition_date",
  "days_since_petition",
  "filing_status",
  "court_name",
  "court_id",
  "state",
  "assigned_judge",
  "courtlistener_case_url",
  "first_discovered_at",
  "last_checked_at",
  "organization_internal_id",
  "organization_name",
  "legal_name",
  "organization_type",
  "organization_domain",
  "organization_website",
  "organization_phone",
  "organization_address_1",
  "organization_city",
  "organization_state",
  "organization_zip",
  "organization_industry",
  "contact_internal_id",
  "contact_type",
  "contact_role",
  "first_name",
  "last_name",
  "full_name",
  "title",
  "primary_email",
  "primary_email_status",
  "primary_email_confidence",
  "primary_phone",
  "primary_phone_status",
  "verification_status",
  "overall_confidence_score",
  "do_not_contact",
  "is_primary_contact",
  "relationship_source",
  "relationship_confidence",
  "audience",
  "suggested_pipeline",
  "outreach_priority",
  "approved_for_crm_import",
];

function getAudience(contactType) {
  const map = {
    principal:            "principal",
    debtor_attorney:      "attorney",
    subchapter_v_trustee: "trustee",
  };
  return map[contactType] || "other";
}

function getSuggestedPipeline(contactType) {
  const map = {
    principal:            "Principal Sales",
    debtor_attorney:      "Attorney Partnerships",
    subchapter_v_trustee: "Trustee Relationships",
  };
  return map[contactType] || "";
}

function getOutreachPriority(daysSince, contactType, isSubV) {
  if (!isSubV) return "low";
  if (contactType === "principal") {
    if (daysSince <= 3)  return "urgent";
    if (daysSince <= 10) return "high";
    if (daysSince <= 21) return "medium";
    return "low";
  }
  if (contactType === "debtor_attorney") return daysSince <= 21 ? "high" : "medium";
  return "low";
}

async function generateMasterCsv(runId) {
  const generatedAt = new Date().toISOString();

  // FIXED: join organization through the contact's own organization_id
  // so each contact gets their own org (debtor company, law firm, etc.)
  const result = await query(`
    SELECT
      c.id                          AS case_id,
      c.courtlistener_docket_id,
      c.case_number,
      c.case_name,
      c.debtor_name,
      c.chapter,
      c.is_subchapter_v,
      c.petition_date,
      c.filing_status,
      c.court_name,
      c.court_id,
      c.state,
      c.assigned_judge,
      c.courtlistener_absolute_url,
      c.first_discovered_at,
      c.last_checked_at,
      c.needs_review,
      c.review_reason,
      o.id                          AS org_id,
      o.organization_name,
      o.legal_name,
      o.organization_type,
      o.domain                      AS org_domain,
      o.website                     AS org_website,
      o.primary_phone               AS org_phone,
      o.address_line_1              AS org_address_1,
      o.city                        AS org_city,
      o.state                       AS org_state,
      o.zip                         AS org_zip,
      o.industry                    AS org_industry,
      ct.id                         AS contact_id,
      ct.contact_type,
      cc.role                       AS contact_role,
      ct.first_name,
      ct.last_name,
      ct.full_name,
      ct.title,
      ct.primary_email,
      ct.primary_email_status,
      ct.primary_email_confidence,
      ct.primary_phone,
      ct.primary_phone_status,
      ct.verification_status,
      ct.overall_confidence_score,
      ct.do_not_contact,
      cc.is_primary,
      cc.source_type                AS rel_source,
      cc.confidence_score           AS rel_confidence
    FROM cases c
    LEFT JOIN case_contacts cc ON cc.case_id = c.id
    LEFT JOIN contacts ct      ON ct.id = cc.contact_id
    LEFT JOIN organizations o  ON o.id = ct.organization_id
    WHERE (ct.do_not_contact = FALSE OR ct.do_not_contact IS NULL)
      AND ct.id IS NOT NULL
    ORDER BY c.petition_date DESC NULLS LAST, c.id, ct.contact_type
  `);

  const lines = [HEADERS.join(",")];

  for (const row of result.rows) {
    const petitionDate = row.petition_date ? new Date(row.petition_date) : null;
    const daysSince    = petitionDate
      ? Math.floor((Date.now() - petitionDate.getTime()) / 86400000)
      : null;

    const audience = getAudience(row.contact_type);
    const pipeline = getSuggestedPipeline(row.contact_type);
    const priority = getOutreachPriority(daysSince, row.contact_type, row.is_subchapter_v);

    lines.push(rowToCsv([
      generatedAt,
      runId || "",
      "active",
      row.needs_review ? "yes" : "no",
      row.review_reason || "",
      row.case_id,
      row.courtlistener_docket_id,
      row.case_number,
      row.case_name,
      row.debtor_name,
      row.chapter,
      row.is_subchapter_v ? "yes" : "no",
      formatDate(row.petition_date),
      daysSince !== null ? daysSince : "",
      row.filing_status,
      row.court_name,
      row.court_id,
      row.state,
      row.assigned_judge,
      row.courtlistener_absolute_url,
      formatDate(row.first_discovered_at),
      formatDate(row.last_checked_at),
      row.org_id,
      row.organization_name,
      row.legal_name,
      row.organization_type,
      row.org_domain,
      row.org_website,
      row.org_phone,
      row.org_address_1,
      row.org_city,
      row.org_state,
      row.org_zip,
      row.org_industry,
      row.contact_id,
      row.contact_type,
      row.contact_role,
      row.first_name,
      row.last_name,
      row.full_name,
      row.title,
      row.primary_email,
      row.primary_email_status,
      row.primary_email_confidence,
      row.primary_phone,
      row.primary_phone_status || "unverified",
      row.verification_status,
      row.overall_confidence_score,
      row.do_not_contact ? "yes" : "no",
      row.is_primary ? "yes" : "no",
      row.rel_source,
      row.rel_confidence,
      audience,
      pipeline,
      priority,
      "no",
    ]));
  }

  logger.info(`Master CSV generated: ${lines.length - 1} rows`);
  return { csv: lines.join("\n"), rowCount: lines.length - 1 };
}

module.exports = { generateMasterCsv };
