"use strict";
const { acquireLock, releaseLock }                    = require("./pipelineLock");
const { discoverSubchapterVCases }                    = require("../courtListenerSearchService");
const { hydrateDocket }                               = require("../caseHydrationService");
const { enrichCase }                                  = require("../enrichmentService");
const { upsertCase, flagForReview }                   = require("../data/caseRepository");
const { upsertOrganization }                          = require("../data/organizationRepository");
const { upsertContact, linkContactToCase }            = require("../data/contactRepository");
const { pushCaseToClose, getContactsForCase }         = require("../integrations/closeIntegration");
const { query }                                       = require("../db/connection");
const logger                                          = require("../logger");

const LOOKBACK_DAYS  = parseInt(process.env.DAILY_SEARCH_LOOKBACK_DAYS || "3", 10);
const MAX_CASES      = parseInt(process.env.DAILY_SEARCH_MAX_CASES     || "30", 10);
const MAX_ENRICHMENTS = parseInt(process.env.DAILY_ENRICH_MAX          || "5",  10);
const PUSH_TO_CLOSE  = process.env.PUSH_TO_CLOSE !== "false";

function getDateString(date) {
  return date.toISOString().slice(0, 10);
}

function buildDateRange(startDate, endDate) {
  if (startDate && endDate) return { from: startDate, to: endDate };
  const to   = new Date();
  to.setDate(to.getDate() - 1);
  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  return { from: getDateString(from), to: getDateString(to) };
}

async function getLastSearchDate() {
  const result = await query(
    `SELECT search_end_date FROM automation_runs
     WHERE status IN ('completed','completed_with_errors') AND search_end_date IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`
  );
  return result.rows[0]?.search_end_date || null;
}

// ── Check which discovered docket IDs are already in the DB ──
async function getExistingDocketIds(docketIds) {
  if (!docketIds.length) return new Set();
  try {
    const result = await query(
      "SELECT courtlistener_docket_id FROM cases WHERE courtlistener_docket_id = ANY($1)",
      [docketIds.map(String)]
    );
    return new Set(result.rows.map(r => String(r.courtlistener_docket_id)));
  } catch(e) {
    logger.warn("Could not pre-check existing docket IDs: " + e.message);
    return new Set();
  }
}

// ── Clean extracted names ──
function cleanName(name) {
  if (!name) return name;
  // Remove trailing ", Debtor" or "(Debtor)"
  name = name.replace(/,?\s*(?:,\s*)?debtor\s*$/i, "").trim();
  // Remove trailing "Signature"
  name = name.replace(/\s+Signature\s*$/i, "").trim();
  // Fix exact duplications: "John Smith John Smith" → "John Smith"
  const words = name.split(/\s+/);
  if (words.length >= 4) {
    const half = Math.floor(words.length / 2);
    if (words.slice(0, half).join(" ").toLowerCase() === words.slice(half).join(" ").toLowerCase()) {
      name = words.slice(0, half).join(" ");
    }
  }
  return name.trim();
}

async function saveCaseToDb(hydratedCase, runId, dryRun) {
  if (dryRun) {
    logger.info("[DRY RUN] Would save: " + hydratedCase.caseName + " (" + hydratedCase.docketId + ")");
    return { isNew: true, caseDbId: null, orgId: null };
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
  const orgName = (hydratedCase.debtorName || hydratedCase.caseName || "").replace(/,?\s*debtor\s*$/i, "").trim();
  if (orgName) {
    const org = await upsertOrganization({
      organization_name: orgName,
      legal_name:        hydratedCase.caseName || null,
      organization_type: "debtor_company",
      website:           null,
      phone:             hydratedCase.debtor?.phone || null,
      address:           hydratedCase.debtor?.address || null,
    });
    orgId = org?.id || null;
  }

  // Save principals from petition text extraction
  for (const p of (hydratedCase.principals || [])) {
    const pName = cleanName(p.name);
    if (!pName || pName.length < 3) continue;

    const confidence = p.confidence === "HIGH" ? 0.9 : p.confidence === "MEDIUM" ? 0.6 : 0.3;
    const contact = await upsertContact({
      full_name:                pName,
      title:                    cleanName(p.title || p.role) || null,
      contact_type:             "principal",
      organization_id:          orgId,
      primary_email:            p.email  || null,
      primary_email_status:     p.email  ? "unverified" : null,
      primary_email_confidence: confidence,
      primary_email_inferred:   false,
      primary_phone:            p.phone  || null,
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

  // Save attorneys (excluding US Trustee)
  const US_TRUSTEE = /u\.?s\.?\s*trustee|united states trustee|department of justice/i;
  for (const a of (hydratedCase.attorneys || [])) {
    if (!a.name) continue;
    if (US_TRUSTEE.test(a.name) || US_TRUSTEE.test(a.firm || "")) continue;

    let firmId = null;
    if (a.firm) {
      const firm = await upsertOrganization({
        organization_name: a.firm,
        organization_type: "law_firm",
        phone:             a.phone || null,
      });
      firmId = firm?.id || null;
    }
    const contact = await upsertContact({
      full_name:               cleanName(a.name),
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

  // Save trustee (excluding US Trustee office)
  const trustee = hydratedCase.trustee;
  if (trustee?.name && !US_TRUSTEE.test(trustee.name)) {
    const contact = await upsertContact({
      full_name:               cleanName(trustee.name),
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
    await flagForReview(caseDbId, "No principal identified from petition text");
  }

  return { isNew, caseDbId, orgId };
}

// ── Auto-enrich a new case using Gemini ──
async function autoEnrichCase(hydratedCase, caseDbId, orgId) {
  const caseName = hydratedCase.debtorName || hydratedCase.caseName || "";
  if (!caseName || caseName.length < 3) {
    logger.warn("Auto-enrich skipped — no case name: " + hydratedCase.docketId);
    return null;
  }

  logger.info("Auto-enriching: " + caseName);

  try {
    const enriched = await enrichCase(hydratedCase);

    if (!enriched || !enriched.principals || enriched.principals.length === 0) {
      logger.info("Auto-enrich: no owner found for " + caseName);
      return enriched;
    }

    // Find the primary owner (isPrimary=true, or first HIGH confidence)
    const owner = enriched.principals.find(function(p) { return p.isPrimary && p.name; })
               || enriched.principals.find(function(p) { return p.confidence === "HIGH" && p.name; })
               || enriched.principals[0];

    if (!owner || !owner.name || owner.name.length < 3) {
      logger.info("Auto-enrich: owner name too short or missing for " + caseName);
      return enriched;
    }

    const ownerName = cleanName(owner.name);
    if (!ownerName) return enriched;

    const confidence = owner.confidence === "HIGH" ? 0.9 : 0.6;

    const contact = await upsertContact({
      full_name:                ownerName,
      title:                    cleanName(owner.title || owner.role) || "Owner",
      contact_type:             "principal",
      organization_id:          orgId,
      primary_email:            owner.email || null,
      primary_email_status:     owner.email ? "unverified" : null,
      primary_email_confidence: confidence,
      primary_email_inferred:   false,
      primary_phone:            owner.phone || null,
      overall_confidence_score: confidence,
      verification_status:      "unverified",
    });

    if (contact?.id) {
      await linkContactToCase(caseDbId, contact.id, "principal", {
        isPrimary:  true,
        sourceType: "ai_enrichment",
        confidence,
      });
      logger.info("Auto-enrich: saved owner " + ownerName + " for " + caseName);
    }

    return enriched;
  } catch(e) {
    logger.warn("Auto-enrich failed for " + caseName + ": " + e.message);
    return null;
  }
}

async function processCase(discovered, runId, dryRun) {
  const docketId = discovered.docketId;
  if (!docketId) {
    logger.warn("Skipping case with no docketId");
    return null;
  }

  logger.info("Processing case: " + (discovered.caseName || docketId));

  try {
    const hydrated = await hydrateDocket(docketId);
    if (hydrated.error) {
      logger.warn("Hydration error for " + docketId + ": " + hydrated.error);
      return { error: hydrated.error, docketId };
    }

    const { isNew, caseDbId, orgId } = await saveCaseToDb(hydrated, runId, dryRun);
    logger.info("Case " + docketId + " " + (isNew ? "CREATED" : "updated") + " — db id: " + caseDbId);

    return { docketId, caseDbId, isNew, caseName: hydrated.caseName, hydrated, orgId };
  } catch(e) {
    logger.error("Failed to process case " + docketId + ": " + e.message);
    return { error: e.message, docketId };
  }
}

async function runDailyPipeline(opts) {
  opts = opts || {};
  const dryRun      = opts.dryRun      || false;
  const triggeredBy = opts.triggeredBy || "manual";
  const court       = opts.court       || "all";

  let { from, to } = buildDateRange(opts.startDate, opts.endDate);

  if (!opts.startDate) {
    const lastDate = await getLastSearchDate();
    if (lastDate) {
      const d = new Date(lastDate);
      d.setDate(d.getDate() - LOOKBACK_DAYS);
      from = getDateString(d);
    }
  }

  logger.info("Daily pipeline starting — " + from + " to " + to + " | dry: " + dryRun + " | close: " + (PUSH_TO_CLOSE && !dryRun));

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
    close_pushed:           0,
    close_skipped:          0,
    close_errors:           0,
    enrichments_attempted:  0,
    enrichments_succeeded:  0,
    error_summary:          [],
  };

  try {
    // ── SEARCH ──
    const discovered = await discoverSubchapterVCases({
      dateFrom: from, dateTo: to, court, maxPages: 10,
    });

    stats.cases_found = discovered.length;
    logger.info("Discovered " + discovered.length + " cases");

    // ── PRE-FILTER: find which docketIds are already in DB ──
    const allDocketIds = discovered.map(function(d) { return d.docketId; }).filter(Boolean);
    const existingIds  = await getExistingDocketIds(allDocketIds);

    // Prioritize genuinely new cases — process them first, then existing up to cap
    const newDiscovered      = discovered.filter(function(d) { return !existingIds.has(String(d.docketId)); });
    const existingDiscovered = discovered.filter(function(d) { return existingIds.has(String(d.docketId)); });

    logger.info("New: " + newDiscovered.length + " | Already in DB: " + existingDiscovered.length);

    // Take up to MAX_CASES, new cases first
    const toProcess = newDiscovered.concat(existingDiscovered).slice(0, MAX_CASES);
    if (discovered.length > MAX_CASES) {
      logger.warn("Capped at " + MAX_CASES + " cases (" + newDiscovered.length + " new, " + Math.max(0, MAX_CASES - newDiscovered.length) + " existing)");
    }

    const newCasesForClose = [];
    let enrichCount = 0;

    // ── PROCESS CASES ──
    for (const d of toProcess) {
      const result = await processCase(d, run.id, dryRun);
      if (!result) continue;

      if (result.error) {
        stats.cases_failed++;
        stats.error_summary.push({ docketId: result.docketId, error: result.error });
      } else if (result.isNew) {
        stats.new_cases_created++;

        // ── AUTO-ENRICH new cases up to the cap ──
        if (!dryRun && enrichCount < MAX_ENRICHMENTS && result.caseDbId && result.hydrated) {
          stats.enrichments_attempted++;
          const enriched = await autoEnrichCase(result.hydrated, result.caseDbId, result.orgId);
          if (enriched && enriched.principals && enriched.principals.length > 0) {
            stats.enrichments_succeeded++;
          }
          enrichCount++;

          // Rate limit pause between enrichments
          await new Promise(function(r) { setTimeout(r, 1000); });
        }

        // Queue for Close push if Sub-V confirmed
        if (result.caseDbId && result.hydrated?.subchapterV?.isLikely) {
          newCasesForClose.push({
            caseDbId: result.caseDbId,
            hydrated: result.hydrated,
          });
        }
      } else {
        stats.existing_cases_updated++;
      }

      // Respect CourtListener rate limits between hydrations
      await new Promise(function(r) { setTimeout(r, 2000); });
    }

    // ── PUSH NEW CASES TO CLOSE ──
    if (PUSH_TO_CLOSE && !dryRun && newCasesForClose.length > 0) {
      logger.info("Pushing " + newCasesForClose.length + " new Sub-V cases to Close CRM");

      for (const item of newCasesForClose) {
        await new Promise(function(r) { setTimeout(r, 500); });

        // Get all contacts including enriched principal saved during auto-enrich
        const contacts = await getContactsForCase(item.caseDbId, query);

        // Build case row from hydrated data
        const caseRow = {
          case_name:                  (item.hydrated.caseName   || "").replace(/,?\s*debtor\s*$/i, "").trim(),
          debtor_name:                (item.hydrated.debtorName || "").replace(/,?\s*debtor\s*$/i, "").trim(),
          case_number:                item.hydrated.docketNumber   || "",
          court_id:                   item.hydrated.courtId        || "",
          district:                   null,
          state:                      null,
          petition_date:              item.hydrated.dateFiled       || null,
          is_subchapter_v:            item.hydrated.subchapterV?.isLikely || false,
          subchapterv_confidence:     item.hydrated.subchapterV?.confidence || null,
          courtlistener_absolute_url: item.hydrated.absoluteUrl    || null,
          assigned_judge:             item.hydrated.assignedTo     || null,
          website:                    null,
          address:                    item.hydrated.debtor?.address || null,
        };

        const closeResult = await pushCaseToClose(caseRow, contacts);
        if (closeResult.success)      stats.close_pushed++;
        else if (closeResult.skipped) stats.close_skipped++;
        else                          stats.close_errors++;

        logger.info("Close: " + (closeResult.success ? "✓" : closeResult.skipped ? "skip(" + closeResult.reason + ")" : "✗") + " " + (caseRow.case_name || caseRow.case_number));
      }

      logger.info("Close complete: " + stats.close_pushed + " pushed, " + stats.close_skipped + " skipped, " + stats.close_errors + " errors");
    }

    const completedRun = await releaseLock(run.id, stats);
    logger.info(
      "Pipeline complete — " + stats.new_cases_created + " new, " +
      stats.existing_cases_updated + " updated, " + stats.cases_failed + " failed, " +
      stats.enrichments_succeeded + "/" + stats.enrichments_attempted + " enriched, " +
      stats.close_pushed + " → Close"
    );

    return {
      runId:                run.id,
      status:               completedRun.status,
      dateRange:            { from, to },
      casesFound:           stats.cases_found,
      newCasesCreated:      stats.new_cases_created,
      existingCasesUpdated: stats.existing_cases_updated,
      casesFailed:          stats.cases_failed,
      enrichmentsAttempted: stats.enrichments_attempted,
      enrichmentsSucceeded: stats.enrichments_succeeded,
      closePushed:          stats.close_pushed,
      closeSkipped:         stats.close_skipped,
      closeErrors:          stats.close_errors,
      errors:               stats.error_summary,
      dryRun,
    };
  } catch(e) {
    logger.error("Pipeline failed: " + e.message);
    await releaseLock(run.id, { failed: true, error_summary: [{ error: e.message }] });
    return { runId: run.id, error: e.message };
  }
}

module.exports = { runDailyPipeline };
