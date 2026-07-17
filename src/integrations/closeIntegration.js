"use strict";
const https  = require("https");
const logger = require("../logger");

const CLOSE_API_KEY = process.env.CLOSE_API_KEY || "";
const CLOSE_BASE    = "api.close.com";

// ── FEATURE FLAGS ──────────────────────────────────────────────────────────
// AUTO_CREATE_OPPORTUNITY: when "true", every pushed lead gets an Opportunity
//   in "Discovery Call Scheduled". Default OFF — a discovered court case is
//   not a scheduled discovery call, and auto-opportunities corrupt pipeline
//   reporting in Close. Set AUTO_CREATE_OPPORTUNITY=true in Render to restore
//   the old behavior.
// GUESSED_EMAILS_ON_CONTACTS: when "true", guessed addresses (info@domain,
//   AI pattern guesses) are attached to the Close contact record itself.
//   Default OFF — guessed addresses stay visible in the lead note (badged
//   "⚠️ guessed") but are NOT saved as contact emails, so a Close sequence
//   can never send to an unverified guess. Set to "true" to restore the old
//   behavior.
const AUTO_CREATE_OPPORTUNITY    = process.env.AUTO_CREATE_OPPORTUNITY === "true";
const GUESSED_EMAILS_ON_CONTACTS = process.env.GUESSED_EMAILS_ON_CONTACTS === "true";

// ── HTTP ───────────────────────────────────────────────────────────────────
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
            logger.warn("Close API " + resp.statusCode + " " + method + " " + path + ": " + data.slice(0,300));
            resolve({ _error: true, _status: resp.statusCode, _body: parsed });
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error("Close API non-JSON: " + data.slice(0,200)));
        }
      });
    });

    req.setTimeout(20000, function() { req.destroy(); reject(new Error("Close API timeout: " + path)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── STATUS IDs ─────────────────────────────────────────────────────────────
const LEAD_STATUS = {
  newNeedsReview: "stat_KnhQmcVJLP0nSs8wdYqGxcW7hpe0Ey4h5ecIzfarMcK",
  // Optional: create these two statuses in Close, then set the env vars in Render.
  // Falls back to New - Needs Review when unset.
  sendReady:      process.env.CLOSE_SEND_READY_STATUS_ID      || null,
  needsResearch:  process.env.CLOSE_NEEDS_RESEARCH_STATUS_ID  || null,
};

// ── List routing: Send Ready vs Needs Research ──────────────────────────────
// Send Ready  = confirmed Sub-V + owner identified + at least one confirmed email
// Needs Research = confirmed Sub-V but missing owner or confirmed contact channel
function chooseLeadStatus(enrichmentData) {
  const e = enrichmentData || {};
  const hasOwner = !!e.ownerName;
  const hasConfirmedEmail = (e.ownerEmails || []).some(function(x) { return x.confidence === "confirmed"; });
  if (hasOwner && hasConfirmedEmail && LEAD_STATUS.sendReady) return LEAD_STATUS.sendReady;
  if (LEAD_STATUS.needsResearch) return LEAD_STATUS.needsResearch;
  return LEAD_STATUS.newNeedsReview;
}

const OPPORTUNITY_STATUS = {
  discoveryCallScheduled: "stat_H0XAr39brZTeiJoTKfQ1AHV7F0YX1NsljApuLdEq1V4",
};

// ── STATE MAP ──────────────────────────────────────────────────────────────
const STATE_MAP = {
  txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",
  nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
  flsb:"Florida",flmb:"Florida",flnb:"Florida",
  caeb:"California",canb:"California",cacb:"California",casb:"California",
  ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",
  njb:"New Jersey",deb:"Delaware",dcb:"Washington DC",
  vaeb:"Virginia",vawb:"Virginia",ganb:"Georgia",gamb:"Georgia",gasb:"Georgia",
  paeb:"Pennsylvania",pamb:"Pennsylvania",pawb:"Pennsylvania",
  ohsb:"Ohio",ohnb:"Ohio",
  nceb:"North Carolina",ncmb:"North Carolina",ncwb:"North Carolina",
  mab:"Massachusetts",mdb:"Maryland",
  wawb:"Washington",waeb:"Washington",
  azb:"Arizona",cob:"Colorado",mnb:"Minnesota",orb:"Oregon",
  meb:"Maine",ndb:"North Dakota",ksb:"Kansas",
  kyeb:"Kentucky",kywb:"Kentucky",
  laeb:"Louisiana",lamb:"Louisiana",lawb:"Louisiana",
  mieb:"Michigan",miwb:"Michigan",
  msnb:"Mississippi",mssb:"Mississippi",
  moeb:"Missouri",mowb:"Missouri",mtb:"Montana",
  nebraskab:"Nebraska",nvb:"Nevada",nhb:"New Hampshire",
  nmb:"New Mexico",prb:"Puerto Rico",rib:"Rhode Island",
  scb:"South Carolina",sdb:"South Dakota",
  tneb:"Tennessee",tnmb:"Tennessee",tnwb:"Tennessee",
  utb:"Utah",vtb:"Vermont",
  wvnb:"West Virginia",wvsb:"West Virginia",
  wieb:"Wisconsin",wiwb:"Wisconsin",wyb:"Wyoming",
  areb:"Arkansas",arwb:"Arkansas",akb:"Alaska",
  arb:"Arizona",idb:"Idaho",ianb:"Iowa",iasb:"Iowa",
  innb:"Indiana",insb:"Indiana",
  okeb:"Oklahoma",oknb:"Oklahoma",okwb:"Oklahoma",
};

// ── FILTER PATTERNS ────────────────────────────────────────────────────────
const BAD_LEAD_NAMES = [
  /^unknown\s*debtor/i,
  /^and the case number/i,
  /official form/i,
  /pursuant to/i,
  /of the united states code/i,
  /bankruptcy code/i,
  /voluntary petition/i,
  /^in re:/i,
  /^case number/i,
  /^docket number/i,
];

// Applies to ALL contact types — principals, attorneys, trustees
const US_TRUSTEE_PATTERNS = [
  /u\.?s\.?\s*trustee/i,
  /united states trustee/i,
  /office of the.*trustee/i,
  /u\.s\. department/i,
  /department of justice/i,
];

const BAD_TITLE_PATTERNS = [
  /of the united states code/i,
  /bankruptcy code/i,
  /pursuant to/i,
  /official form/i,
  /in accordance with/i,
  /11 u\.s\.c/i,
  /section \d+/i,
  /title 11/i,
];

function cleanName(name) {
  if (!name) return "";
  name = name.replace(/,?\s*\(?\s*debtor\s*\)?\s*$/i, "").trim();
  name = name.replace(/\s+Signature\s*$/i, "").trim();
  const words = name.split(/\s+/);
  if (words.length >= 4) {
    const half = Math.floor(words.length / 2);
    if (words.slice(0,half).join(" ").toLowerCase() === words.slice(half).join(" ").toLowerCase()) {
      name = words.slice(0,half).join(" ");
    }
  }
  return name.trim();
}

function isValidLeadName(name) {
  if (!name || name.trim().length < 3) return false;
  for (const p of BAD_LEAD_NAMES) { if (p.test(name)) return false; }
  return true;
}

function isUSTrustee(contact) {
  const name = (contact.full_name || "").toLowerCase();
  const org  = (contact.organization_name || "").toLowerCase();
  for (const p of US_TRUSTEE_PATTERNS) { if (p.test(name) || p.test(org)) return true; }
  return false;
}

function isValidTitle(title) {
  if (!title) return true;
  for (const p of BAD_TITLE_PATTERNS) { if (p.test(title)) return false; }
  return true;
}

function isPrincipalActuallyAttorney(principal, attorneys) {
  const pName = (principal.full_name || "").toLowerCase().trim();
  if (!pName) return false;
  for (const a of attorneys) {
    const aName = (a.full_name || "").toLowerCase().trim();
    if (aName && aName.length > 3 && (aName === pName || aName.includes(pName) || pName.includes(aName))) return true;
  }
  return false;
}

// ── PHONE AND EMAIL BUILDERS ───────────────────────────────────────────────
// Collects ALL phones from DB contact + enrichmentData, deduplicated
function buildAllPhones(contact, enrichmentData) {
  const seen = new Set();
  const phones = [];

  function add(phone, type) {
    if (!phone) return;
    const n = String(phone).trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    phones.push({ phone: n, type: type || "office" });
  }

  // 1. Phone from DB contact record (Google Maps / Gemini business phone)
  if (contact && contact.primary_phone) add(contact.primary_phone, "office");

  // 2. Phones from Claude layer (ownerPhones array)
  if (enrichmentData && Array.isArray(enrichmentData.ownerPhones)) {
    enrichmentData.ownerPhones.forEach(function(p) { add(p.phone, p.type || "direct"); });
  }

  // 3. Company scraped phones from website
  if (enrichmentData && Array.isArray(enrichmentData.scrapedPhones)) {
    enrichmentData.scrapedPhones.forEach(function(p) { add(p, "other"); });
  }

  return phones;
}

// Collects ALL emails: info@ guess + scraped + Claude-found, labeled by confidence
function buildAllEmails(contact, enrichmentData) {
  const seen = new Set();
  const emails = [];

  function add(email, type, confidence) {
    const e = (email || "").toLowerCase().trim();
    if (!e || seen.has(e)) return;
    if (!e.match(/^[\w.+\-]+@[\w\-]+\.[a-z]{2,}$/i)) return;
    if (/noreply|no-reply|donotreply|sentry|wix|wordpress/i.test(e)) return;
    seen.add(e);
    emails.push({ email: e, type: type || "office", _confidence: confidence || "guessed" });
  }

  // 1. info@ from website domain (always include as fallback)
  const website = enrichmentData && (enrichmentData.website || (enrichmentData.company && enrichmentData.company.website));
  if (website) {
    try {
      const domain = new URL(website.startsWith("http") ? website : "https://" + website).hostname.replace(/^www\./,"");
      if (domain && domain.length <= 40) add("info@" + domain, "office", "guessed");
    } catch(e) {}
  }

  // 2. Emails scraped from website
  if (enrichmentData && Array.isArray(enrichmentData.emails)) {
    enrichmentData.emails.forEach(function(em) { add(em, "office", "confirmed"); });
  }
  if (enrichmentData && enrichmentData.company && Array.isArray(enrichmentData.company.emails)) {
    enrichmentData.company.emails.forEach(function(em) { add(em, "office", "confirmed"); });
  }

  // 3. Claude-found owner emails (most targeted)
  if (enrichmentData && Array.isArray(enrichmentData.ownerEmails)) {
    enrichmentData.ownerEmails.forEach(function(em) { add(em.email, em.type || "direct", em.confidence || "guessed"); });
  }

  // 4. Single owner email from DB contact
  if (contact && contact.primary_email) add(contact.primary_email, "direct", "confirmed");

  return emails;
}

// ── EMAIL FILTER FOR CONTACT RECORDS ───────────────────────────────────────
// The note shows every email with a confidence badge; the contact record is
// what sequences actually send to, so only confirmed addresses belong there
// unless GUESSED_EMAILS_ON_CONTACTS is explicitly enabled.
function filterEmailsForContact(emails, allowGuessed) {
  const allow = allowGuessed === undefined ? GUESSED_EMAILS_ON_CONTACTS : allowGuessed;
  if (allow) return emails || [];
  return (emails || []).filter(function(em) { return em._confidence === "confirmed"; });
}

// ── CONTACT PRIORITY SORT ──────────────────────────────────────────────────
// AI-enriched principals first, then petition principals, then attorneys, then trustees
function sortContacts(contacts) {
  const priority = { "principal": 0, "debtor_attorney": 1, "subchapter_v_trustee": 2 };
  return contacts.slice().sort(function(a, b) {
    const pa = priority[a.contact_type] !== undefined ? priority[a.contact_type] : 3;
    const pb = priority[b.contact_type] !== undefined ? priority[b.contact_type] : 3;
    if (pa !== pb) return pa - pb;
    if (pa === 0) {
      const aIsAI = (a.source_type || "").includes("ai");
      const bIsAI = (b.source_type || "").includes("ai");
      if (aIsAI && !bIsAI) return -1;
      if (!aIsAI && bIsAI) return  1;
    }
    return 0;
  });
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr).toISOString().slice(0,10); } catch(e) { return null; }
}

function buildLeadDescription(c) {
  const lines = [];
  const filed = formatDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;
  lines.push("Sub-V Chapter 11 — Case " + (c.case_number || "unknown"));
  if (filed)  lines.push("Filed: " + filed + (days !== null ? " (Day " + days + ")" : ""));
  if (c.court_id) lines.push("Court: " + c.court_id.toUpperCase());
  const state = c.state || STATE_MAP[c.court_id] || "";
  if (state) lines.push("State: " + state);
  if (c.courtlistener_absolute_url) lines.push("CourtListener: " + c.courtlistener_absolute_url);
  if (c.assigned_judge) lines.push("Judge: " + c.assigned_judge);
  return lines.join("\n");
}

// ── NOTE BUILDER ───────────────────────────────────────────────────────────
// enrichmentData is the merged result from aiSearchEnrich (optional, for enhanced notes)
function buildNoteHtml(c, contacts, enrichmentData) {
  const filed = formatDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;
  const e     = enrichmentData || {};

  const attorneys  = (contacts||[]).filter(function(x) { return x.contact_type === "debtor_attorney" && !isUSTrustee(x); });
  const principals = (contacts||[]).filter(function(x) {
    return x.contact_type === "principal" && !isUSTrustee(x) && !isPrincipalActuallyAttorney(x, attorneys) && isValidTitle(x.title);
  });
  const trustees   = (contacts||[]).filter(function(x) { return x.contact_type === "subchapter_v_trustee" && !isUSTrustee(x); });

  let html = "<body>";
  html += "<h2>" + cleanName(c.case_name || c.debtor_name || "Unknown") + "</h2>";
  if (e.tradeName && e.tradeName !== c.case_name) html += "<p><strong>DBA:</strong> " + e.tradeName + "</p>";
  html += "<p><strong>Case No:</strong> " + (c.case_number || "—") + "</p>";
  html += "<p><strong>Filed:</strong> " + (filed || "—") + (days !== null ? " — Day " + days + " since filing" : "") + "</p>";
  html += "<p><strong>Court:</strong> " + (c.court_id || "").toUpperCase() + "</p>";
  const state = c.state || STATE_MAP[c.court_id] || "";
  if (state) html += "<p><strong>State:</strong> " + state + "</p>";
  if (c.courtlistener_absolute_url) html += "<p><strong>CourtListener:</strong> <a href=\"" + c.courtlistener_absolute_url + "\">" + c.courtlistener_absolute_url + "</a></p>";
  if (c.subchapterv_confidence) html += "<p><strong>Sub-V Confidence:</strong> " + c.subchapterv_confidence + "</p>";

  // Lead score badge — no inline styles, Close API rejects style attributes
  const ls = (e && e.leadScore) || (c && c.lead_score) || null;
  if (ls && ls.tier) {
    const tierEmoji = ls.tier === "HOT" ? "🔥" : ls.tier === "WARM" ? "⚡" : "❄️";
    html += "<p><strong>Lead Score: " + tierEmoji + " " + ls.tier + " (" + ls.score + ")</strong></p>";
    if (ls.reasons && ls.reasons.length) {
      html += "<ul>";
      ls.reasons.slice(0, 6).forEach(function(r) { html += "<li>" + r + "</li>"; });
      html += "</ul>";
    }
  }

  // Owner / Principal
  if (sortContacts(principals).length) {
    html += "<hr/><h3>Principal / Owner</h3>";
    sortContacts(principals).forEach(function(p) {
      const name  = cleanName(p.full_name || "Unknown");
      const title = isValidTitle(p.title) ? p.title : null;
      html += "<p><strong>" + name + "</strong>" + (title ? " — " + title : "") + "</p>";

      if (e.ownerValidated) html += "<p>✅ Validated as business operator" + (e.ownerValidationNote ? " — " + e.ownerValidationNote : "") + "</p>";

      // All emails with confidence labels
      const allEmails = buildAllEmails(p, e);
      if (allEmails.length) {
        html += "<p><strong>Emails:</strong></p><ul>";
        allEmails.forEach(function(em) {
          const badge = em._confidence === "confirmed" ? "✅" : "⚠️ guessed";
          html += "<li>📧 " + em.email + " (" + em.type + ") " + badge + "</li>";
        });
        html += "</ul>";
      } else if (p.primary_email) {
        html += "<p>Email: " + p.primary_email + "</p>";
      }

      // All phones with labels
      const allPhones = buildAllPhones(p, e);
      if (allPhones.length) {
        html += "<p><strong>Phones:</strong></p><ul>";
        allPhones.forEach(function(ph) { html += "<li>📞 " + ph.phone + " (" + ph.type + ")</li>"; });
        html += "</ul>";
      } else if (p.primary_phone) {
        html += "<p>Phone: " + p.primary_phone + "</p>";
      }

      if (e.ownerLinkedIn) html += "<p>💼 <a href=\"" + e.ownerLinkedIn + "\">LinkedIn</a></p>";
    });
  } else {
    html += "<hr/><h3>Principal / Owner</h3><p><em>Not yet identified — manual review recommended.</em></p>";
  }

  // Business info
  if (e.website || e.contactFormUrl || e.businessType || e.businessDescription || e.bankruptcyReason || e.stillOperating === false) {
    html += "<hr/><h3>Business</h3>";
    if (e.website)       html += "<p>🌐 <a href=\"" + e.website + "\">" + e.website + "</a></p>";
    if (e.contactFormUrl) html += "<p>📝 Contact form: <a href=\"" + e.contactFormUrl + "\">" + e.contactFormUrl + "</a></p>";
    if (e.businessDescription || e.businessType) html += "<p>" + (e.businessDescription||e.businessType) + "</p>";
    if (e.bankruptcyReason) html += "<p>📋 Filing reason: " + e.bankruptcyReason + "</p>";
    if (e.stillOperating === false) html += "<p>⛔ <strong>WARNING: Business may no longer be operating</strong></p>";
  }

  // Social / digital footprint
  const socialLinks = e.socialLinks || {};
  const hasSocial   = socialLinks.instagram || socialLinks.facebook || socialLinks.linkedin || e.linkedInCompany || e.yelpUrl || e.googleMapsUrl;
  if (hasSocial) {
    html += "<hr/><h3>Digital Footprint</h3><ul>";
    if (socialLinks.instagram)  html += "<li>📱 <a href=\"" + socialLinks.instagram + "\">Instagram</a></li>";
    if (socialLinks.facebook)   html += "<li>📘 <a href=\"" + socialLinks.facebook + "\">Facebook</a></li>";
    if (socialLinks.linkedin || e.linkedInCompany) html += "<li>💼 <a href=\"" + (socialLinks.linkedin||e.linkedInCompany) + "\">LinkedIn Company</a></li>";
    if (e.yelpUrl)              html += "<li>⭐ <a href=\"" + e.yelpUrl + "\">Yelp</a></li>";
    if (e.googleMapsUrl)        html += "<li>📍 <a href=\"" + e.googleMapsUrl + "\">Google Maps</a></li>";
    html += "</ul>";
  }

  // Outreach recommendation
  if (e.bestOutreachChannel && e.bestOutreachChannel !== "manual") {
    const channelMap = {
      email:        "✉️ Email — send to confirmed address above",
      phone:        "📞 Call — use direct/mobile line",
      instagram_dm: "📱 Instagram DM — active account found",
      facebook:     "📘 Facebook message — active page found",
      contact_form: "📝 Contact form — " + (e.contactFormUrl || "use URL above"),
      linkedin:     "💼 LinkedIn — profile found above"
    };
    html += "<hr/><p><strong>Best first channel:</strong> " + (channelMap[e.bestOutreachChannel]||e.bestOutreachChannel) + "</p>";
  }

  if (e.redFlags && e.redFlags.length) {
    html += "<p>⚠️ <strong>Red Flags:</strong></p><ul>";
    e.redFlags.forEach(function(f) { html += "<li>" + f + "</li>"; });
    html += "</ul>";
  }

  // Attorney
  if (attorneys.length) {
    html += "<hr/><h3>Debtor Attorney</h3>";
    attorneys.forEach(function(a) {
      html += "<p><strong>" + cleanName(a.full_name || "Unknown") + "</strong>";
      if (a.organization_name) html += " — " + a.organization_name;
      html += "</p>";
      if (a.primary_email) html += "<p>Email: " + a.primary_email + "</p>";
      if (a.primary_phone) html += "<p>Phone: " + a.primary_phone + "</p>";
    });
  }

  // Trustee
  if (trustees.length) {
    html += "<hr/><h3>Sub-V Trustee</h3>";
    trustees.forEach(function(t) {
      html += "<p><strong>" + cleanName(t.full_name || "Unknown") + "</strong></p>";
      if (t.primary_email) html += "<p>Email: " + t.primary_email + "</p>";
      if (t.primary_phone) html += "<p>Phone: " + t.primary_phone + "</p>";
    });
  }

  html += "<p><em>Enriched: " + new Date().toISOString().slice(0,10) + " | Confidence: " + (e.confidence||"LOW") + "</em></p>";
  html += "</body>";
  return html;
}

// ── DUPLICATE CHECK ────────────────────────────────────────────────────────
async function findExistingLead(caseNumber) {
  if (!caseNumber) return null;
  try {
    const result = await closeRequest("GET", "/lead/?query=" + encodeURIComponent(caseNumber) + "&_fields=id,display_name");
    if (result._error) return null;
    const leads = result.data || [];
    return leads.length > 0 ? leads[0] : null;
  } catch(e) {
    logger.warn("Close lead search failed: " + e.message);
    return null;
  }
}

// ── CREATE LEAD ────────────────────────────────────────────────────────────
async function createLead(c, enrichmentData) {
  const name = cleanName(c.case_name || c.debtor_name || "Unknown Debtor");
  const e    = enrichmentData || {};
  const result = await closeRequest("POST", "/lead/", {
    name:        name,
    description: buildLeadDescription(c),
    status_id:   chooseLeadStatus(e),
    url:         e.website || c.website || null,
    custom:      {},
  });
  if (result._error) {
    throw new Error("Failed to create lead for " + name + ": " + JSON.stringify(result._body).slice(0,200));
  }
  return result;
}

// ── CREATE CONTACT (with multiple phones + emails) ─────────────────────────
async function createContact(leadId, contact, enrichmentData) {
  const name = cleanName(contact.full_name || "");
  if (!name || name.length < 2) return null;
  if (isUSTrustee(contact)) return null;

  const allPhones = buildAllPhones(contact, enrichmentData);
  // Note keeps ALL emails with badges; the contact record gets confirmed only
  // (unless GUESSED_EMAILS_ON_CONTACTS=true).
  const allEmails = filterEmailsForContact(buildAllEmails(contact, enrichmentData));

  const title = isValidTitle(contact.title)
    ? (contact.title || null)
    : (contact.contact_type === "principal"           ? "Owner" :
       contact.contact_type === "debtor_attorney"     ? "Attorney" :
       contact.contact_type === "subchapter_v_trustee"? "Trustee" : null);

  // URLs: LinkedIn + social links for owner contacts
  const urls = [];
  if (enrichmentData && contact.contact_type === "principal") {
    if (enrichmentData.ownerLinkedIn) urls.push({ type: "url", url: enrichmentData.ownerLinkedIn });
    if (enrichmentData.socialLinks && enrichmentData.socialLinks.instagram) urls.push({ type: "url", url: enrichmentData.socialLinks.instagram });
  }

  const result = await closeRequest("POST", "/contact/", {
    lead_id: leadId,
    name:    name,
    title:   title,
    phones:  allPhones.map(function(p) { return { phone: p.phone, type: p.type }; }),
    emails:  allEmails.map(function(em) { return { email: em.email, type: em.type }; }),
    urls:    urls.length ? urls : undefined,
  });

  if (result._error) {
    logger.warn("Failed to create contact " + name + ": " + JSON.stringify(result._body).slice(0,200));
    return null;
  }
  return result;
}

// ── CREATE NOTE ────────────────────────────────────────────────────────────
async function createNote(leadId, noteHtml) {
  const result = await closeRequest("POST", "/activity/note/", {
    lead_id:   leadId,
    note_html: noteHtml,
    _type:     "Note",
  });
  if (result._error) {
    logger.warn("Close note failed for lead " + leadId + " (status " + result._status + "): " + JSON.stringify(result._body).slice(0,200));
    return null;
  }
  return result;
}

// ── CREATE OPPORTUNITY ─────────────────────────────────────────────────────
async function createOpportunity(leadId, c) {
  const filed = formatDate(c.petition_date);
  const note  = [
    "Sub-V MOR automation — $200/month",
    filed ? "Filed: " + filed : null,
    c.case_number ? "Case: " + c.case_number : null,
    "Court: " + (c.court_id || "").toUpperCase(),
  ].filter(Boolean).join(" · ");

  const result = await closeRequest("POST", "/opportunity/", {
    lead_id:      leadId,
    status_id:    OPPORTUNITY_STATUS.discoveryCallScheduled,
    note:         note,
    value:        20000,
    value_period: "monthly",
    confidence:   20,
  });

  if (result._error) {
    logger.warn("Failed to create opportunity for lead " + leadId);
    return null;
  }
  return result;
}

// ── FETCH CONTACTS FOR A CASE FROM DB ─────────────────────────────────────
async function getContactsForCase(caseDbId, dbQuery) {
  if (!caseDbId || !dbQuery) return [];
  try {
    const result = await dbQuery(
      `SELECT ct.full_name, ct.title, ct.contact_type,
              ct.primary_email, ct.primary_phone,
              o.organization_name,
              cc.source_type, cc.is_primary
       FROM case_contacts cc
       JOIN contacts ct ON ct.id = cc.contact_id
       LEFT JOIN organizations o ON o.id = ct.organization_id
       WHERE cc.case_id = $1
       ORDER BY cc.is_primary DESC, ct.contact_type`,
      [caseDbId]
    );
    return result.rows;
  } catch(e) {
    logger.warn("Could not fetch contacts for case " + caseDbId + ": " + e.message);
    return [];
  }
}

// ── MAIN: push one case to Close ───────────────────────────────────────────
// enrichmentData is optional — pass the merged Gemini+Claude result for enhanced notes
async function pushCaseToClose(caseRow, contacts, enrichmentData) {
  if (!CLOSE_API_KEY) {
    logger.warn("CLOSE_API_KEY not set — skipping");
    return { skipped: true, reason: "no_api_key" };
  }

  const caseNumber = caseRow.case_number || "";
  const caseName   = cleanName(caseRow.case_name || caseRow.debtor_name || "");
  const e          = enrichmentData || {};

  // Skip non-Sub-V
  if (!caseRow.is_subchapter_v) {
    return { skipped: true, reason: "not_subchapter_v" };
  }

  // Skip bad names
  if (!isValidLeadName(caseName)) {
    logger.warn("Close: skipping bad name: '" + caseName + "'");
    return { skipped: true, reason: "invalid_name", caseName };
  }

  // Skip duplicates
  const existing = await findExistingLead(caseNumber);
  if (existing) {
    logger.info("Close: duplicate for " + caseNumber + " — skipping");
    return { skipped: true, reason: "duplicate", leadId: existing.id };
  }

  try {
    // Create lead
    const lead   = await createLead(caseRow, e);
    const leadId = lead.id;
    logger.info("Close: created lead " + leadId + " — " + caseName);

    // Filter and sort contacts
    const attorneys  = (contacts||[]).filter(function(c) { return c.contact_type === "debtor_attorney" && !isUSTrustee(c); });
    const principals = (contacts||[]).filter(function(c) {
      return c.contact_type === "principal" && !isUSTrustee(c) && !isPrincipalActuallyAttorney(c, attorneys) && isValidTitle(c.title);
    });
    const trustees   = (contacts||[]).filter(function(c) { return c.contact_type === "subchapter_v_trustee" && !isUSTrustee(c); });

    // AI-enriched principals first, then others
    const allContacts = sortContacts(principals).concat(attorneys).concat(trustees);

    for (const contact of allContacts.slice(0,5)) {
      await new Promise(function(r) { setTimeout(r, 200); });
      // Pass enrichmentData to owner contacts for full email/phone/social population
      const contactEnrich = (contact.contact_type === "principal") ? e : null;
      await createContact(leadId, contact, contactEnrich);
    }

    // Note — include enrichment data if available
    const noteHtml = buildNoteHtml(caseRow, contacts||[], e);
    await createNote(leadId, noteHtml);

    // Opportunity — only when explicitly enabled. A discovered case is not a
    // scheduled discovery call; default is no auto-opportunity.
    if (AUTO_CREATE_OPPORTUNITY) {
      await createOpportunity(leadId, caseRow);
    } else {
      logger.info("Close: opportunity skipped (AUTO_CREATE_OPPORTUNITY off) — " + caseName);
    }

    logger.info("Close: fully created — " + caseName + " (" + caseNumber + ") — " + principals.length + " principals, " + attorneys.length + " attorneys");
    return { success: true, leadId, caseName, caseNumber, principalCount: principals.length };

  } catch(err) {
    logger.error("Close push failed for " + caseName + ": " + err.message);
    return { error: true, message: err.message, caseName, caseNumber };
  }
}

// ── BATCH PUSH ─────────────────────────────────────────────────────────────
async function pushCasesToClose(cases) {
  if (!CLOSE_API_KEY) return { skipped: true };
  const results = { pushed: 0, skipped: 0, errors: 0, details: [] };
  for (const item of cases) {
    await new Promise(function(r) { setTimeout(r, 400); });
    const result = await pushCaseToClose(item.case, item.contacts||[], item.enrichmentData||null);
    results.details.push(result);
    if (result.success)      results.pushed++;
    else if (result.skipped) results.skipped++;
    else                     results.errors++;
  }
  logger.info("Close batch: " + results.pushed + " pushed, " + results.skipped + " skipped, " + results.errors + " errors");
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════
// UPDATE EXISTING LEAD IN PLACE
// Adds owner contact if missing, updates website, adds fresh enrichment note.
// Never deletes or duplicates existing data.
// ═══════════════════════════════════════════════════════════════════════════
async function getCloseContactNames(leadId) {
  try {
    const result = await closeRequest("GET", "/contact/?lead_id=" + leadId + "&_fields=id,name,title");
    if (result._error) return [];
    return (result.data || []).map(c => (c.name || "").toLowerCase().trim());
  } catch(e) { return []; }
}

async function updateLeadInClose(leadId, caseRow, contacts, enrichmentData) {
  if (!CLOSE_API_KEY || !leadId) return { success: false, reason: "no_key_or_id" };

  const e = enrichmentData || {};

  try {
    // 1. Update website URL and status on the lead
    const leadUpdate = {};
    if (e.website || caseRow.website) leadUpdate.url = e.website || caseRow.website;
    // Promote to Send Ready when a confirmed owner email now exists
    const newStatus = chooseLeadStatus(e);
    if (newStatus !== LEAD_STATUS.newNeedsReview) leadUpdate.status_id = newStatus;
    if (Object.keys(leadUpdate).length) {
      await closeRequest("PUT", "/lead/" + leadId + "/", leadUpdate);
      await new Promise(r => setTimeout(r, 250));
    }

    // 2. Add owner contact if not already on the lead
    const existingNames = await getCloseContactNames(leadId);

    const attorneys  = (contacts||[]).filter(x => x.contact_type === "debtor_attorney" && !isUSTrustee(x));
    const principals = (contacts||[]).filter(x =>
      x.contact_type === "principal" && !isUSTrustee(x)
      && !isPrincipalActuallyAttorney(x, attorneys) && isValidTitle(x.title)
    );

    let contactsAdded = 0;
    for (const p of sortContacts(principals).slice(0, 2)) {
      const pName = cleanName(p.full_name || "").toLowerCase().trim();
      if (!pName || pName.length < 2) continue;
      if (existingNames.includes(pName)) continue; // already there

      await new Promise(r => setTimeout(r, 250));
      const created = await createContact(leadId, p, e);
      if (created) contactsAdded++;
    }

    // 3. Add updated enrichment note
    const noteHtml = buildNoteHtml(caseRow, contacts || [], e);
    await createNote(leadId, noteHtml);

    logger.info("Close lead updated in place: " + leadId + " — " + contactsAdded + " contacts added");
    return { success: true, leadId, contactsAdded };
  } catch(err) {
    logger.warn("updateLeadInClose failed for " + leadId + ": " + err.message);
    return { success: false, message: err.message };
  }
}

module.exports = { pushCaseToClose, pushCasesToClose, getContactsForCase, buildNoteHtml, buildAllEmails, buildAllPhones, filterEmailsForContact, updateLeadInClose };
