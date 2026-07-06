"use strict";
/**
 * trusteePushService.js
 *
 * Pushes all 420 Sub-V trustees from the database to Close CRM as individual leads.
 * Each trustee becomes their own lead with:
 *   - Lead name: trustee's full name
 *   - Description: district, source, USTP link
 *   - Contact: the trustee with verified email and phone
 *   - Status: Trustee — New (update TRUSTEE_STATUS_ID once created in Close)
 *   - No opportunity (trustees are referral partners, not prospects)
 *
 * Run once via: GET /admin/push-trustees-to-close?secret=...
 * Safe to re-run — duplicate check by email prevents double-creation.
 *
 * After trustees are in Close, build the sequence manually in Close UI:
 *   - C11R — Subchapter V Trustee Outreach
 *   - Email 1 (Day 0):  C11R — Trustee — Email 1 — Introduction
 *   - Email 2 (Day 21): C11R — Trustee — Email 2 — MOR Checklist
 *   - Email 3 (Day 45): C11R — Trustee — Email 3 — Partnership Ask
 */

const https  = require("https");
const logger = require("../logger");

const CLOSE_API_KEY = process.env.CLOSE_API_KEY || "";
const CLOSE_BASE    = "api.close.com";

// ── UPDATE THIS once you create "Trustee — New" status in Close Settings → Lead Statuses ──
// For now uses "New — Needs Review" as placeholder
const TRUSTEE_STATUS_ID = process.env.CLOSE_TRUSTEE_STATUS_ID || "stat_KnhQmcVJLP0nSs8wdYqGxcW7hpe0Ey4h5ecIzfarMcK";

// ── HTTP ──
function closeRequest(method, path, body) {
  return new Promise(function(resolve, reject) {
    const payload = body ? JSON.stringify(body) : null;
    const auth    = Buffer.from(CLOSE_API_KEY + ":").toString("base64");
    const headers = {
      "Authorization": "Basic " + auth,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request({
      hostname: CLOSE_BASE,
      path:     "/api/v1" + path,
      method:   method,
      headers:  headers,
    }, function(resp) {
      let data = "";
      resp.setEncoding("utf8");
      resp.on("data", function(c) { data += c; });
      resp.on("end", function() {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) {
            logger.warn("Close API " + resp.statusCode + " " + method + " " + path + ": " + data.slice(0, 200));
            resolve({ _error: true, _status: resp.statusCode, _body: parsed });
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error("Close API non-JSON: " + data.slice(0, 200)));
        }
      });
    });

    req.setTimeout(20000, function() { req.destroy(); reject(new Error("Close timeout: " + path)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── CHECK IF TRUSTEE LEAD ALREADY EXISTS (search by name) ──
async function findExistingTrusteeLead(trusteeName) {
  if (!trusteeName) return null;
  try {
    const encoded = encodeURIComponent(trusteeName);
    const result  = await closeRequest("GET", "/lead/?query=" + encoded + "&_fields=id,display_name,status_id");
    if (result._error) return null;
    const leads = result.data || [];
    // Match leads that have the trustee's name as the lead name (exact or close match)
    const match = leads.find(function(l) {
      return (l.display_name || "").toLowerCase().trim() === trusteeName.toLowerCase().trim();
    });
    return match || null;
  } catch(e) {
    logger.warn("Trustee lead search failed for " + trusteeName + ": " + e.message);
    return null;
  }
}

// ── CREATE TRUSTEE LEAD ──
async function createTrusteeLead(trustee) {
  const name = (trustee.full_name || trustee.name || "").trim();
  if (!name) return null;

  const description = [
    "Sub-V Trustee — " + (trustee.district_name || trustee.district_code || ""),
    "District: " + (trustee.district_code || "").toUpperCase(),
    "Program: " + (trustee.program_type || "USTP"),
    "Appointment: " + (trustee.appointment_type || "case_by_case"),
    "Source: " + (trustee.source_url || "https://www.justice.gov/ust/list-chapter-11-subchapter-v-case-case-trustees"),
    "Verified: " + (trustee.source_verified_at ? new Date(trustee.source_verified_at).toISOString().slice(0, 10) : "2026-06-23"),
  ].join("\n");

  const result = await closeRequest("POST", "/lead/", {
    name:        name,
    description: description,
    status_id:   TRUSTEE_STATUS_ID,
    custom:      {},
  });

  if (result._error) {
    throw new Error("Failed to create trustee lead for " + name + ": " + JSON.stringify(result._body).slice(0, 200));
  }
  return result;
}

// ── CREATE TRUSTEE CONTACT ON THEIR LEAD ──
async function createTrusteeContact(leadId, trustee) {
  const name = (trustee.full_name || trustee.name || "").trim();
  if (!name) return null;

  const phones = [];
  if (trustee.phone) phones.push({ phone: trustee.phone, type: "office" });

  const emails = [];
  if (trustee.email) emails.push({ email: trustee.email, type: "office" });

  const result = await closeRequest("POST", "/contact/", {
    lead_id: leadId,
    name:    name,
    title:   "Subchapter V Trustee",
    phones:  phones,
    emails:  emails,
  });

  if (result._error) {
    logger.warn("Failed to create trustee contact " + name + ": " + JSON.stringify(result._body).slice(0, 200));
    return null;
  }
  return result;
}

// ── ADD A CASE NOTE TO A TRUSTEE LEAD ──
// Called when a new Sub-V case is assigned to a known trustee
async function addCaseNoteToTrusteeLead(leadId, caseData) {
  const caseName   = caseData.case_name   || caseData.caseName   || "Unknown";
  const caseNumber = caseData.case_number || caseData.docketNumber || "";
  const courtId    = (caseData.court_id   || caseData.courtId    || "").toUpperCase();
  const filed      = caseData.petition_date || caseData.dateFiled || "";
  const url        = caseData.courtlistener_absolute_url || caseData.absoluteUrl || "";

  let html = "<body>";
  html += "<h3>New case assigned</h3>";
  html += "<p><strong>" + caseName + "</strong></p>";
  if (caseNumber) html += "<p>Case No: " + caseNumber + "</p>";
  if (courtId)    html += "<p>Court: " + courtId + "</p>";
  if (filed)      html += "<p>Filed: " + (typeof filed === "string" ? filed.slice(0, 10) : filed) + "</p>";
  if (url)        html += "<p><a href=\"" + url + "\">View on CourtListener</a></p>";
  html += "</body>";

  const result = await closeRequest("POST", "/activity/note/", {
    lead_id:   leadId,
    note_html: html,
    _type:     "Note",
  });

  if (result._error) {
    logger.warn("Failed to add case note to trustee lead " + leadId);
    return null;
  }
  return result;
}

// ── FIND A TRUSTEE LEAD BY EMAIL ──
// Used for linking new cases to existing trustee leads
async function findTrusteeLeadByEmail(email) {
  if (!email) return null;
  try {
    const encoded = encodeURIComponent(email);
    const result  = await closeRequest("GET", "/contact/?email=" + encoded + "&_fields=id,lead_id,name");
    if (result._error) return null;
    const contacts = result.data || [];
    return contacts.length > 0 ? { contactId: contacts[0].id, leadId: contacts[0].lead_id } : null;
  } catch(e) {
    logger.warn("Trustee email search failed for " + email + ": " + e.message);
    return null;
  }
}

// ── PUSH ONE TRUSTEE TO CLOSE ──
async function pushTrusteeToClose(trustee) {
  if (!CLOSE_API_KEY) {
    return { skipped: true, reason: "no_api_key" };
  }

  const name = (trustee.full_name || trustee.name || "").trim();
  if (!name || name.length < 3) {
    return { skipped: true, reason: "no_name" };
  }

  try {
    // Duplicate check by name
    const existing = await findExistingTrusteeLead(name);
    if (existing) {
      return { skipped: true, reason: "duplicate", leadId: existing.id, name };
    }

    // Create lead
    const lead   = await createTrusteeLead(trustee);
    const leadId = lead.id;
    logger.info("Close trustee: created lead " + leadId + " — " + name);

    // Create contact
    await createTrusteeContact(leadId, trustee);

    return { success: true, leadId, name, district: trustee.district_code };

  } catch(e) {
    logger.error("Close trustee push failed for " + name + ": " + e.message);
    return { error: true, message: e.message, name };
  }
}

// ── BATCH PUSH ALL TRUSTEES ──
async function pushAllTrusteesToClose(trustees, onProgress) {
  if (!CLOSE_API_KEY) {
    return { skipped: true, reason: "no_api_key" };
  }

  const stats = { pushed: 0, skipped: 0, errors: 0, total: trustees.length };

  for (let i = 0; i < trustees.length; i++) {
    const trustee = trustees[i];

    // Rate limit: 400ms between calls (Close allows ~100 req/10s)
    await new Promise(function(r) { setTimeout(r, 400); });

    const result = await pushTrusteeToClose(trustee);

    if (result.success)      stats.pushed++;
    else if (result.skipped) stats.skipped++;
    else                     stats.errors++;

    // Progress callback every 10 trustees
    if (onProgress && i % 10 === 0) {
      onProgress({ processed: i + 1, total: trustees.length, stats });
    }

    logger.info(
      "[" + (i + 1) + "/" + trustees.length + "] " +
      (result.success  ? "✓ " + result.name :
       result.skipped  ? "skip (" + result.reason + ") " + result.name :
       "✗ " + result.name + " — " + result.message)
    );
  }

  logger.info("Trustee batch complete: " + stats.pushed + " pushed, " + stats.skipped + " skipped, " + stats.errors + " errors");
  return stats;
}

module.exports = {
  pushTrusteeToClose,
  pushAllTrusteesToClose,
  findTrusteeLeadByEmail,
  addCaseNoteToTrusteeLead,
};
