"use strict";
const { acquireLock, releaseLock }         = require("./pipelineLock");
const { discoverSubchapterVCases }         = require("../courtListenerSearchService");
const { hydrateDocket }                    = require("../caseHydrationService");
const { enrichCase }                       = require("../enrichmentService");
const { upsertCase, flagForReview }        = require("../data/caseRepository");
const { upsertOrganization }               = require("../data/organizationRepository");
const { upsertContact, linkContactToCase } = require("../data/contactRepository");
const { query }                            = require("../db/connection");
const logger                               = require("../logger");

// How many days back to search to catch delayed CourtListener indexing
const LOOKBACK_DAYS = parseInt(process.env.DAILY_SEARCH_LOOKBACK_DAYS || "3", 10);
const MAX_CASES     = parseInt(process.env.DAILY_SEARCH_MAX_CASES     || "50", 10);

function getDateString(date) {
  return date.toISOString().slice(0, 10);
}

function buildDateRange(startDate, endDate) {
  // If explicit dates provided use them
  if (startDate && endDate) return { from: startDate, to: endDate };

  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  return {
    from: getDateString(from),
    to:   getDateString(to),
  };
}

async function getLastSearchDate() {
  const result = await query(
    `SELECT search_end_date
     FROM automation_runs
     WHERE status IN ('completed', 'completed_with_errors')
       AND search_end_date IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`
  );
  return result.rows[0]?.search_end_date || null;
}

async function saveCaseToDb(hydratedCase, runId, dryRun) {
  if (dryRun) {
    logger.info(`[DRY RUN] Would save case: ${hydratedCase.caseName} (${hydratedCase.docketId})`);
    return { isNew: true, caseDbId: null };
  }

  // Check if case already exists
  const existing = await query(
    "SELECT id FROM cases WHERE courtlistener_docket_id = $1",
    [hydratedCase.docketId]
  );
  const isNew = existing.rows.length === 0;

  // Upsert the case
  const savedCase = await upsertCase(hydratedCase);
  if (!savedCase) throw new Error("upsertCase returned null");

  const caseDbId = savedCase.id;

  // Save debtor organization
  let orgId = null;
  if (hydratedCase.debtorName || hydratedCase.caseName) {
    const org = await upsertOrganization({
      organization_name: hydratedCase.debtorName || hydratedCase.caseName,
      legal_name:        hydratedCase.caseName || null,
      organization_type: "debtor_company",
      website:           null,
      phone:             hydratedCase.debtor?.phone || null,
      address:           hydratedCase.debtor?.address || null,
    });
    orgId = org?.id || null;
  }

  // Save principals
  for (const p of (hydratedCase.principals || [])) {
    if (!p.name) continue;
    const contact = await upsertContact({
      full_name:               p.name,
      title:                   p.title || p.role || null,
      contact_type:            "principal",
      organization_id:         orgId,
      primary_email:           p.email || null,
      primary_email_status:    p.email ? "unverified" : null,
      primary_email_confidence:p.confidence === "HIGH" ? 0.9
                              : p.confidence === "MEDIUM" ? 0.6 : 0.3,
      primary_phone:           p.phone || null,
      overall_confidence_score:p.confidence === "HIGH" ? 0.9
                              : p.confidence === "MEDIUM" ? 0.6 : 0.3,
      verification_status:     "unverified",
    });
    if (contact?.id) {
      await linkContactToCase(caseDbId, contact.id, "principal", {
        isPrimary:  p.isPrimary || false,
        sourceType: p.source || "courtlistener_structured",
        confidence: p.confidence === "HIGH" ? 0.9
                  : p.confidence === "MEDIUM" ? 0.6 : 0.3,
      });
    }
  }

  // Save attorneys
  for (const a of (hydratedCase.attorneys || [])) {
    if (!a.name) continue;

    // Save law firm
    let firmId = null;
    if (a.firm || a.contactRaw) {
      const firmName = a.firm || a.contactRaw?.split("\n")[0] || "Unknown Firm";
      const firm = await upsertOrganization({
        organization_name: firmName,
        organization_type: "law_firm",
        phone:             a.phone || null,
      });
      firmId = firm?.id || null;
    }

    const contact = await upsertContact({
      full_name:               a.name,
      title:                   "Attorney",
      contact_type:            "debtor_attorney",
      organization_id:         firmId,
      primary_email:           a.email || null,
      primary_email_status:    a.email ? "unverified" : null,
      primary_phone:           a.phone || null,
      overall_confidence_score:0.8,
      verification_status:     "unverified",
    });
    if (contact?.id) {
      await linkContactToCase(caseDbId, contact.id, "debtor_attorney", {
        isPrimary:  false,
        sourceType: "courtlistener_structured",
        confidence: 0.8,
      });
    }
  }

  // Save trustee
  const trustee = hydratedCase.trustee;
  if (trustee?.name && trustee.name !== "US Trustee" && trustee.name !== "U.S. Trustee") {
    const contact = await upsertContact({
      full_name:               trustee.name,
      title:                   "Subchapter V Trustee",
      contact_type:            "subchapter_v_trustee",
      primary_email:           trustee.email || null,
      primary_email_status:    trustee.email ? "unverified" : null,
      primary_phone:           trustee.phone || null,
      overall_confidence_score:trustee.confidence === "HIGH" ? 0.9 : 0.6,
      verification_status:     "unverified",
    });
    if (contact?.id) {
      await linkContactToCase(caseDbId, contact.id, "subchapter_v_trustee", {
        isPrimary:  true,
        sourceType: trustee.source || "ustp_directory",
        confidence: trustee.confidence === "HIGH" ? 0.9 : 0.6,
      });
    }
  }

  // Flag for review if principal is missing
  if ((hydratedCase.principals || []).length === 0) {
    await flagForReview(caseDbId, "No principal identified");
  }

  return { isNew, caseDbId };
}

async function processCase(discovered, runId, dryRun) {
  const docketId =
