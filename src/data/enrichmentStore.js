"use strict";
// src/data/enrichmentStore.js
// Persists enrichment results so they are never lost and can be reused
// by the backfill, re-enrichment jobs, and lead scoring.

const { query } = require("../db/connection");
const logger    = require("../logger");

// ── Save a full enrichment result ──────────────────────────────────────────
async function saveEnrichment(caseDbId, enrichedData, source) {
  if (!caseDbId || !enrichedData) return null;
  try {
    const result = await query(
      `INSERT INTO enrichment_attempts (case_id, status, source, enrichment_json, created_at)
       VALUES ($1, 'success', $2, $3, NOW())
       RETURNING id`,
      [caseDbId, source || "gemini_claude_v2", JSON.stringify(enrichedData)]
    );
    logger.info("Enrichment saved for case " + caseDbId + " (attempt " + result.rows[0].id + ")");
    return result.rows[0].id;
  } catch(e) {
    // Table might not have these columns yet — try to add them
    if (e.message.includes("column") || e.message.includes("does not exist")) {
      try {
        await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS enrichment_json JSONB`);
        await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS source TEXT`);
        await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS status TEXT`);
        await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS case_id INTEGER`);
        // Retry
        const retry = await query(
          `INSERT INTO enrichment_attempts (case_id, status, source, enrichment_json, created_at)
           VALUES ($1, 'success', $2, $3, NOW())
           RETURNING id`,
          [caseDbId, source || "gemini_claude_v2", JSON.stringify(enrichedData)]
        );
        return retry.rows[0].id;
      } catch(e2) {
        logger.warn("Could not save enrichment: " + e2.message);
        return null;
      }
    }
    logger.warn("Could not save enrichment for case " + caseDbId + ": " + e.message);
    return null;
  }
}

// ── Load the most recent enrichment for a case ─────────────────────────────
async function loadEnrichment(caseDbId) {
  if (!caseDbId) return null;
  try {
    const result = await query(
      `SELECT enrichment_json FROM enrichment_attempts
       WHERE case_id = $1 AND status = 'success' AND enrichment_json IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [caseDbId]
    );
    if (!result.rows.length) return null;
    const raw = result.rows[0].enrichment_json;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch(e) {
    logger.warn("Could not load enrichment for case " + caseDbId + ": " + e.message);
    return null;
  }
}

// ── Lead scoring based on enrichment quality ───────────────────────────────
// HOT:  validated owner + direct contact channel + still operating
// WARM: owner found with some contact method
// COLD: no owner or business appears closed
function scoreLeadFromEnrichment(enrichedData, contacts) {
  const e  = enrichedData?.aiData || enrichedData || {};
  const co = enrichedData?.company || {};

  let score = 0;
  const reasons = [];

  // Owner identity
  const ownerName = e.ownerName || null;
  if (ownerName) { score += 30; reasons.push("Owner identified: " + ownerName); }
  if (e.ownerValidated) { score += 15; reasons.push("Owner validated"); }

  // Contact channels
  const hasConfirmedEmail = (e.ownerEmails || []).some(x => x.confidence === "confirmed");
  const hasAnyEmail       = (e.ownerEmails || []).length > 0 || (co.emails || []).length > 0;
  const hasDirectPhone    = (e.ownerPhones || []).some(x => x.type === "mobile" || x.type === "direct");
  const hasAnyPhone       = (e.ownerPhones || []).length > 0 || co.phone;

  if (hasConfirmedEmail) { score += 20; reasons.push("Confirmed email"); }
  else if (hasAnyEmail)  { score += 10; reasons.push("Email available (guessed)"); }
  if (hasDirectPhone)    { score += 15; reasons.push("Direct/mobile phone"); }
  else if (hasAnyPhone)  { score += 8;  reasons.push("Business phone"); }

  // Digital presence — reachability
  if (e.instagram || co.socialLinks?.instagram) { score += 5; reasons.push("Instagram active"); }
  if (e.facebook  || co.socialLinks?.facebook)  { score += 3; reasons.push("Facebook active"); }
  if (e.website   || co.website)                { score += 5; reasons.push("Website live"); }

  // Business viability
  if (e.stillOperating === false || co.stillOperating === false) {
    score -= 40;
    reasons.push("⛔ Business may not be operating");
  }
  if ((e.redFlags || []).length > 0) {
    score -= 10 * e.redFlags.length;
    reasons.push("Red flags: " + e.redFlags.join("; "));
  }

  // Fallback: petition principal exists in contacts even without AI enrichment
  if (!ownerName && contacts) {
    const hasPrincipal = contacts.some(c => c.contact_type === "principal");
    if (hasPrincipal) { score += 15; reasons.push("Petition principal on file"); }
  }

  let tier;
  if (score >= 60)      tier = "HOT";
  else if (score >= 30) tier = "WARM";
  else                  tier = "COLD";

  return { score, tier, reasons };
}

module.exports = { saveEnrichment, loadEnrichment, scoreLeadFromEnrichment };
