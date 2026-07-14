"use strict";
const { acquireLock, releaseLock }         = require("./pipelineLock");
const { discoverSubchapterVCases }         = require("../courtListenerSearchService");
const { hydrateDocket }                    = require("../caseHydrationService");
const { enrichCase }                       = require("../enrichmentService");
const { upsertCase, flagForReview }        = require("../data/caseRepository");
const { upsertOrganization }               = require("../data/organizationRepository");
const { upsertContact, linkContactToCase } = require("../data/contactRepository");
const { pushCaseToClose, getContactsForCase } = require("../integrations/closeIntegration");
const { query }                            = require("../db/connection");
const { matchesAnyName }                   = require("../nameMatch");
const logger                               = require("../logger");

const LOOKBACK_DAYS   = parseInt(process.env.DAILY_SEARCH_LOOKBACK_DAYS || "3",  10);
const MAX_CASES       = parseInt(process.env.DAILY_SEARCH_MAX_CASES     || "10", 10);
const MAX_ENRICHMENTS = parseInt(process.env.DAILY_ENRICH_MAX           || "999", 10);
const PUSH_TO_CLOSE   = process.env.PUSH_TO_CLOSE !== "false";

// ── Sub-V confidence threshold for Close push ──────────────────────────────
// MEDIUM or HIGH = confirmed Sub-V → push to Close
// LOW = uncertain (no is_subchapter_v flag, no trustee) → save to DB only, skip Close
// This prevents large non-Sub-V Chapter 11 cases (GoHealth, etc.) from
// polluting Close while still capturing every real Sub-V case.
const SUBV_CONFIDENCE_FOR_CLOSE = ["HIGH", "MEDIUM"];

function isQualifiedForClose(hydratedCase) {
  const sv = hydratedCase.subchapterV;
  if (!sv) return false;
  // Direct CourtListener flag — gold standard
  if (sv.isSubchapterVFlag === true) return true;
  // Classifier confidence
  if (SUBV_CONFIDENCE_FOR_CLOSE.includes(sv.confidence)) return sv.isLikely === true;
  // Has a known Sub-V trustee assigned — very reliable signal
  const trustee = hydratedCase.trustee;
  if (trustee && trustee.name && !/(u\.?s\.?\s*trustee|united states trustee)/i.test(trustee.name)) {
    return true;
  }
  return false;
}

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

// ── Save Close lead ID back to DB after successful push ────────────────────
async function saveCloseLeadId(caseDbId, closeLeadId) {
  if (!caseDbId || !closeLeadId) return;
  try {
    await query(
      "UPDATE cases SET close_lead_id = $1, close_pushed_at = NOW() WHERE id = $2",
      [closeLeadId, caseDbId]
    );
  } catch(e) {
    logger.warn("Could not save close_lead_id for case " + caseDbId + ": " + e.message);
  }
}

function cleanName(name) {
  if (!name) return name;
  name = name.replace(/,?\s*\(?\s*debtor\s*\)?\s*$/i, "").trim();
  name = name.replace(/\s+Signature\s*$/i, "").trim();
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

  // Save is_subchapter_v flag
  const isSubV = hydratedCase.subchapterV?.isLikely === true;
  await query(
    "UPDATE cases SET is_subchapter_v = $1 WHERE id = $2",
    [isSubV, caseDbId]
  ).catch(e => logger.warn("Could not update is_subchapter_v: " + e.message));

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

  const US_TRUSTEE = /u\.?s\.?\s*trustee|united states trustee|department of justice/i;

  const attorneyNames = (hydratedCase.attorneys || []).map(a => a.name).filter(Boolean);

  for (const p of (hydratedCase.principals || [])) {
    const pName = cleanName(p.name);
    if (!pName || pName.length < 3) continue;
    if (matchesAnyName(pName, attorneyNames)) {
      logger.warn("Skipping principal '" + pName + "' — matches a case attorney");
      continue;
    }
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

  for (const a of (hydratedCase.attorneys || [])) {
    if (!a.name) continue;
    if (US_TRUSTEE.test(a.name) || US_TRUSTEE.test(a.firm || "")) continue;
    let firmId = null;
    if (a.firm) {
      const firm = await upsertOrganization({ organization_name: a.firm, organization_type: "law_firm", phone: a.phone || null });
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

async function autoEnrichCase(hydratedCase, caseDbId, orgId) {
  const caseName = hydratedCase.debtorName || hydratedCase.caseName || "";
  if (!caseName || caseName.length < 3) return null;

  logger.info("Auto-enriching: " + caseName);
  try {
    const enriched = await enrichCase(hydratedCase);
    if (!enriched || !enriched.principals || enriched.principals.length === 0) {
      logger.info("Auto-enrich: no owner found for " + caseName);
      return enriched;
    }

    const owner = enriched.principals.find(p => p.isPrimary && p.name)
               || enriched.principals.find(p => p.confidence === "HIGH" && p.name)
               || enriched.principals[0];

    if (!owner || !owner.name || owner.name.length < 3) return enriched;

    const ownerName = cleanName(owner.name);
    if (!ownerName) return enriched;

    const attorneyNames = (hydratedCase.attorneys || []).map(a => a.name).filter(Boolean);
    if (matchesAnyName(ownerName, attorneyNames)) {
      logger.warn("Auto-enrich: rejecting owner '" + ownerName + "' for " + caseName + " — matches a case attorney");
      return enriched;
    }

    const ai     = enriched.aiData || {};
    const emails = ai.ownerEmails || [];
    const phones = ai.ownerPhones || [];
    const bestEmail = (emails.find(e => e.confidence === "confirmed") || emails[0] || {}).email || owner.email || null;
    const bestPhone = (phones.find(p => p.type === "mobile" || p.type === "direct") || phones[0] || {}).phone || owner.phone || null;
    const confidence = owner.confidence === "HIGH" ? 0.9 : 0.6;

    const contact = await upsertContact({
      full_name:                ownerName,
      title:                    cleanName(owner.title || owner.role) || "Owner",
      contact_type:             "principal",
      organization_id:          orgId,
      primary_email:            bestEmail,
      primary_email_status:     bestEmail ? "unverified" : null,
      primary_email_confidence: confidence,
      primary_email_inferred:   false,
      primary_phone:            bestPhone,
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
  if (!docketId) { logger.warn("Skipping case with no docketId"); return null; }

  try {
    const hydrated = await hydrateDocket(docketId);
    if (hydrated.error) {
      logger.warn("Hydration error for " + docketId + ": " + hydrated.error);
      return { error: hydrated.error, docketId };
    }

    const { isNew, caseDbId, orgId } = await saveCaseToDb(hydrated, runId, dryRun);
    logger.info("Case " + docketId + " " + (isNew ? "CREATED" : "updated") + " — db id: " + caseDbId
      + " — Sub-V: " + hydrated.subchapterV?.confidence);

    return { docketId, caseDbId, isNew, caseName: hydrated.caseName, hydrated, orgId };
  } catch(e) {
    logger.error("Failed to process case " + docketId + ": " + e.message);
    return { error: e.message, docketId };
  }
}

// ── MAIN PIPELINE ──────────────────────────────────────────────────────────
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

  logger.info("Pipeline starting — " + from + " to " + to
    + " | dry: " + dryRun + " | close: " + (PUSH_TO_CLOSE && !dryRun));

  const run = await acquireLock({ runType: "daily", startDate: from, endDate: to, triggeredBy, dryRun });
  if (!run) return { error: "Pipeline already running — skipped" };

  const stats = {
    cases_found: 0, new_cases_created: 0, existing_cases_updated: 0,
    cases_failed: 0, close_pushed: 0, close_skipped: 0, close_not_subv: 0,
    close_errors: 0, enrichments_attempted: 0, enrichments_succeeded: 0,
    error_summary: [],
  };

  try {
    const discovered = await discoverSubchapterVCases({ dateFrom: from, dateTo: to, court, maxPages: 10 });
    stats.cases_found = discovered.length;
    logger.info("Discovered " + discovered.length + " cases");

    const allDocketIds  = discovered.map(d => d.docketId).filter(Boolean);
    const existingIds   = await getExistingDocketIds(allDocketIds);
    const newDiscovered = discovered.filter(d => !existingIds.has(String(d.docketId)));
    const oldDiscovered = discovered.filter(d =>  existingIds.has(String(d.docketId)));

    logger.info("New: " + newDiscovered.length + " | Already in DB: " + oldDiscovered.length);

    const toProcess = newDiscovered.concat(oldDiscovered).slice(0, MAX_CASES);

    const newCasesForClose = [];
    let enrichCount = 0;

    for (const d of toProcess) {
      const result = await processCase(d, run.id, dryRun);
      if (!result) continue;

      if (result.error) {
        stats.cases_failed++;
        stats.error_summary.push({ docketId: result.docketId, error: result.error });
      } else if (result.isNew) {
        stats.new_cases_created++;

        // Enrich every new case
        let enrichedData = null;
        if (!dryRun && enrichCount < MAX_ENRICHMENTS && result.caseDbId && result.hydrated) {
          stats.enrichments_attempted++;
          enrichedData = await autoEnrichCase(result.hydrated, result.caseDbId, result.orgId);
          if (enrichedData?.principals?.length > 0) stats.enrichments_succeeded++;
          enrichCount++;
          await new Promise(r => setTimeout(r, 1000));
        }

        // ── GATE: only push confirmed Sub-V cases to Close ─────────────────
        // This prevents large non-Sub-V Chapter 11 cases from polluting Close.
        // Cases saved to DB regardless — the gate is only for Close.
        if (result.caseDbId && isQualifiedForClose(result.hydrated)) {
          newCasesForClose.push({
            caseDbId:     result.caseDbId,
            hydrated:     result.hydrated,
            enrichedData: enrichedData
          });
        } else if (result.caseDbId) {
          stats.close_not_subv++;
          logger.info("Case " + result.docketId + " skipped for Close — Sub-V confidence: "
            + (result.hydrated?.subchapterV?.confidence || "none"));
        }
      } else {
        stats.existing_cases_updated++;
      }

      // Pause between cases to protect CourtListener rate limit
      await new Promise(r => setTimeout(r, 5000));
    }

    // Push confirmed Sub-V cases to Close
    if (PUSH_TO_CLOSE && !dryRun && newCasesForClose.length > 0) {
      logger.info("Pushing " + newCasesForClose.length + " Sub-V cases to Close");

      for (const item of newCasesForClose) {
        await new Promise(r => setTimeout(r, 500));

        const contacts = await getContactsForCase(item.caseDbId, query);
        const h = item.hydrated;

        const caseRow = {
          case_name:                  cleanName(h.caseName   || ""),
          debtor_name:                cleanName(h.debtorName || ""),
          case_number:                h.docketNumber   || "",
          court_id:                   h.courtId        || "",
          state:                      null,
          petition_date:              h.dateFiled      || null,
          is_subchapter_v:            true,
          subchapterv_confidence:     h.subchapterV?.confidence || null,
          courtlistener_absolute_url: h.absoluteUrl    || null,
          assigned_judge:             h.assignedTo     || null,
          website:                    item.enrichedData?.website || item.enrichedData?.aiData?.website || null,
          address:                    h.debtor?.address || null,
        };

        const enrichmentForClose = item.enrichedData?.aiData || item.enrichedData || null;
        const closeResult = await pushCaseToClose(caseRow, contacts, enrichmentForClose);

        if (closeResult.success) {
          stats.close_pushed++;
          // ── KEY FIX: save Close lead ID to DB to prevent future duplicates ──
          await saveCloseLeadId(item.caseDbId, closeResult.leadId);
        } else if (closeResult.skipped) {
          stats.close_skipped++;
        } else {
          stats.close_errors++;
        }

        logger.info("Close: "
          + (closeResult.success ? "✓ " + closeResult.leadId
           : closeResult.skipped ? "skip(" + closeResult.reason + ")"
           : "✗ " + closeResult.message)
          + " — " + (caseRow.case_name || caseRow.case_number));
      }

      logger.info("Close complete — pushed:" + stats.close_pushed
        + " skipped:" + stats.close_skipped
        + " not_subv:" + stats.close_not_subv
        + " errors:" + stats.close_errors);
    }

    const completedRun = await releaseLock(run.id, stats);
    logger.info("Pipeline complete — "
      + stats.new_cases_created + " new, "
      + stats.existing_cases_updated + " updated, "
      + stats.cases_failed + " failed, "
      + stats.enrichments_succeeded + "/" + stats.enrichments_attempted + " enriched, "
      + stats.close_pushed + " → Close, "
      + stats.close_not_subv + " filtered (not Sub-V)");

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
      closeNotSubV:         stats.close_not_subv,
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

// ── BACKFILL: push DB cases not yet in Close ───────────────────────────────
// Called from /admin/close-backfill endpoint
// Uses close_lead_id to guarantee no duplicates
async function runCloseBackfill(opts) {
  opts = opts || {};
  const limit  = parseInt(opts.limit  || "20", 10);
  const offset = parseInt(opts.offset || "0",  10);

  logger.info("Close backfill starting — limit:" + limit + " offset:" + offset);

  // Only pull cases that:
  // 1. Are confirmed Sub-V (is_subchapter_v = true)
  // 2. Don't already have a Close lead ID
  const casesResult = await query(
    `SELECT id, courtlistener_docket_id, case_name, debtor_name, case_number,
            court_id, petition_date, is_subchapter_v, courtlistener_absolute_url,
            close_lead_id, subchapterv_confidence
     FROM cases
     WHERE (close_lead_id IS NULL OR close_lead_id = '')
     AND is_subchapter_v = true
     ORDER BY petition_date DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const cases = casesResult.rows;
  logger.info("Backfill: " + cases.length + " cases to push (offset " + offset + ")");

  const stats = { pushed: 0, skipped: 0, errors: 0, details: [] };

  for (const c of cases) {
    await new Promise(r => setTimeout(r, 600));

    try {
      const contacts = await getContactsForCase(c.id, query);

      const caseRow = {
        case_name:                  cleanName(c.case_name   || c.debtor_name || ""),
        debtor_name:                cleanName(c.debtor_name || c.case_name   || ""),
        case_number:                c.case_number || "",
        court_id:                   c.court_id    || "",
        state:                      null,
        petition_date:              c.petition_date || null,
        is_subchapter_v:            true,
        subchapterv_confidence:     c.subchapterv_confidence || "MEDIUM",
        courtlistener_absolute_url: c.courtlistener_absolute_url || null,
        assigned_judge:             null,
        website:                    null,
        address:                    null,
      };

      const closeResult = await pushCaseToClose(caseRow, contacts, null);

      if (closeResult.success) {
        await saveCloseLeadId(c.id, closeResult.leadId);
        stats.pushed++;
        logger.info("Backfill ✓ " + caseRow.case_name + " → " + closeResult.leadId);
      } else if (closeResult.skipped) {
        // Duplicate found in Close — save the existing lead ID
        if (closeResult.leadId) await saveCloseLeadId(c.id, closeResult.leadId);
        stats.skipped++;
        logger.info("Backfill skip: " + caseRow.case_name + " — " + closeResult.reason);
      } else {
        stats.errors++;
        logger.warn("Backfill ✗ " + caseRow.case_name + ": " + closeResult.message);
      }

      stats.details.push({ caseId: c.id, caseName: caseRow.case_name, result: closeResult });
    } catch(e) {
      stats.errors++;
      logger.warn("Backfill error on case " + c.id + ": " + e.message);
    }
  }

  logger.info("Backfill complete — pushed:" + stats.pushed
    + " skipped:" + stats.skipped + " errors:" + stats.errors);

  return {
    pushed:  stats.pushed,
    skipped: stats.skipped,
    errors:  stats.errors,
    total:   cases.length,
    offset,
    limit,
    nextOffset: offset + limit,
    hasMore: cases.length === limit,
  };
}

module.exports = { runDailyPipeline, runCloseBackfill };
