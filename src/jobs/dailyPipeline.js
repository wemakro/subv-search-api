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

const LOOKBACK_DAYS = parseInt(process.env.DAILY_SEARCH_LOOKBACK_DAYS || "3", 10);
const MAX_CASES     = parseInt(process.env.DAILY_SEARCH_MAX_CASES     || "30", 10);

function getDateString(date) {
  return date.toISOString().slice(0, 10);
}

function buildDateRange(startDate, endDate) {
  if (startDate && endDate) return { from: startDate, to: endDate };

  // Default: yesterday with lookback overlap to catch delayed indexing
  const to   = new Date();
  to.setDate(to.getDate() - 1);
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
     WHERE status IN ('completed','completed_with_errors')
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

  const existing = await query(
    "SELECT id FROM cases WHERE courtlistener_docket_id = $1",
    [hydratedCase.docketId]
  );
  const isNew = existing.rows.length === 0;

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

    // Separate direct contact info from company fallback
    const directEmail   = p.email   || null;
    const directPhone   = p.phone   || null;
    const companyPhone  = hydratedCase.debtor?.phone || null;

    // Only use a phone if it appears to be a direct number, not the company main line
    const phoneToSave   = directPhone || null; // never fall back to company phone for principal
    const emailToSave   = directEmail || null;
    const emailStatus   = directEmail ? "unverified" : null;
    const emailInferred = false; // petition/courtlistener source is not inferred

    const confidence = p.confidence === "HIGH" ? 0.9
                     : p.confidence === "MEDIUM" ? 0.6 : 0.3;

    const contact = await upsertContact({
      full_name:                p.name,
      title:                    p.title || p.role || null,
      contact_type:             "principal",
      organization_id:          orgId,
      primary_email:            emailToSave,
      primary_email_status:     emailStatus,
      primary_email_confidence: confidence,
      primary_email_inferred:   emailInferred,
      primary_phone:            phoneToSave,
      overall_confidence_score: confidence,
      verification_status:      "unverified",
    });

    if (contact?.id) {
      await linkContactToCase(caseDbId, contact.id, "principal", {
        isPrimary:  p.isPrimary || false,
        sourceType: p.source || "courtlistener_structured",
        confidence,
      });
    }
  }

  // Save attorneys
  for (const a of (hydratedCase.attorneys || [])) {
    if (!a.name) continue;
    let firmId = null;
    if (a.firm || a.contactRaw) {
      const firmName = a.firm || (a.contactRaw || "").split("\n")[0] || "Unknown Firm";
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
  if (trustee?.name &&
      trustee.name !== "US Trustee" &&
      trustee.name !== "U.S. Trustee") {
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

  if ((hydratedCase.principals || []).length === 0) {
    await flagForReview(caseDbId, "No principal identified");
  }

  return { isNew, caseDbId };
}

async function processCase(discovered, runId, dryRun) {
  const docketId = discovered.docketId;
  if (!docketId) {
    logger.warn("Skipping case with no docketId");
    return null;
  }

  logger.info(`Processing case: ${discovered.caseName || docketId}`);

  try {
    const hydrated = await hydrateDocket(docketId);
    if (hydrated.error) {
      logger.warn(`Hydration error for ${docketId}: ${hydrated.error}`);
      return { error: hydrated.error, docketId };
    }

    const { isNew, caseDbId } = await saveCaseToDb(hydrated, runId, dryRun);
    logger.info(`Case ${docketId} ${isNew ? "created" : "updated"} — db id: ${caseDbId}`);
    return { docketId, caseDbId, isNew, caseName: hydrated.caseName };
  } catch(e) {
    logger.error(`Failed to process case ${docketId}: ${e.message}`);
    return { error: e.message, docketId };
  }
}

async function runDailyPipeline(opts = {}) {
  const dryRun      = opts.dryRun      || false;
  const triggeredBy = opts.triggeredBy || "manual";
  const court       = opts.court       || "all";

  let { from, to } = buildDateRange(opts.startDate, opts.endDate);

  // If no explicit start date, extend back from last successful run
  if (!opts.startDate) {
    const lastDate = await getLastSearchDate();
    if (lastDate) {
      const d = new Date(lastDate);
      d.setDate(d.getDate() - LOOKBACK_DAYS);
      from = getDateString(d);
    }
  }

  logger.info(`Daily pipeline starting — ${from} to ${to} | dry: ${dryRun}`);

  const run = await acquireLock({
    runType: "daily", startDate: from, endDate: to, triggeredBy, dryRun,
  });

  if (!run) return { error: "Pipeline already running — skipped" };

  const stats = {
    cases_found:            0,
    new_cases_created:      0,
    existing_cases_updated: 0,
    contacts_created:       0,
    contacts_updated:       0,
    cases_failed:           0,
    error_summary:          [],
  };

  try {
    const discovered = await discoverSubchapterVCases({
      dateFrom: from, dateTo: to, court, maxPages: 10,
    });

    stats.cases_found = discovered.length;
    logger.info(`Discovered ${discovered.length} cases`);

    const toProcess = discovered.slice(0, MAX_CASES);
    if (discovered.length > MAX_CASES) {
      logger.warn(`Capping at ${MAX_CASES} cases`);
    }

    for (const d of toProcess) {
      const result = await processCase(d, run.id, dryRun);
      if (!result) continue;

      if (result.error) {
        stats.cases_failed++;
        stats.error_summary.push({ docketId: result.docketId, error: result.error });
      } else if (result.isNew) {
        stats.new_cases_created++;
      } else {
        stats.existing_cases_updated++;
      }

      // Delay between cases to respect CourtListener rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    const completedRun = await releaseLock(run.id, stats);
    logger.info(`Pipeline complete — ${stats.new_cases_created} new, ${stats.existing_cases_updated} updated, ${stats.cases_failed} failed`);

    return {
      runId:                run.id,
      status:               completedRun.status,
      dateRange:            { from, to },
      casesFound:           stats.cases_found,
      newCasesCreated:      stats.new_cases_created,
      existingCasesUpdated: stats.existing_cases_updated,
      casesFailed:          stats.cases_failed,
      errors:               stats.error_summary,
      dryRun,
    };
  } catch(e) {
    logger.error(`Pipeline failed: ${e.message}`);
    await releaseLock(run.id, { failed: true, error_summary: [{ error: e.message }] });
    return { runId: run.id, error: e.message };
  }
}

module.exports = { runDailyPipeline };
