"use strict";
const https  = require("https");
const logger = require("../logger");

const CLOSE_API_KEY = process.env.CLOSE_API_KEY || "";
const CLOSE_BASE    = "api.close.com";

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
            logger.warn(`Close API ${resp.statusCode} ${method} ${path}: ${data.slice(0, 200)}`);
            resolve({ _error: true, _status: resp.statusCode, _body: parsed });
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error("Close API non-JSON response: " + data.slice(0, 200)));
        }
      });
    });

    req.setTimeout(15000, function() {
      req.destroy();
      reject(new Error("Close API timeout: " + path));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── LEAD STATUS IDs — from your Close account ──
const LEAD_STATUS = {
  newNeedsReview:      "stat_KnhQmcVJLP0nSs8wdYqGxcW7hpe0Ey4h5ecIzfarMcK",
  approvedForOutreach: "stat_PA2y1jrWBTLFO5TTuw0hcG5kyVn1kElTmrsR0QiRlW5",
};

// ── PIPELINE STATUS IDs ──
const OPPORTUNITY_STATUS = {
  discoveryCallScheduled: "stat_H0XAr39brZTeiJoTKfQ1AHV7F0YX1NsljApuLdEq1V4",
};

// ── STATE MAP ──
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

// ── HELPERS ──
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

function formatPetitionDate(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr).toISOString().slice(0, 10); }
  catch(e) { return null; }
}

function buildLeadDescription(c) {
  const lines = [];
  const filed  = formatPetitionDate(c.petition_date);
  const days   = filed ? daysSince(filed) : null;

  lines.push(`Sub-V Chapter 11 — Case ${c.case_number || "unknown"}`);
  if (filed)        lines.push(`Filed: ${filed}${days !== null ? ` (Day ${days})` : ""}`);
  if (c.court_id)   lines.push(`Court: ${c.court_id.toUpperCase()}${c.district ? " — " + c.district : ""}`);
  if (c.state || STATE_MAP[c.court_id]) lines.push(`State: ${c.state || STATE_MAP[c.court_id] || ""}`);
  if (c.courtlistener_absolute_url) lines.push(`CourtListener: ${c.courtlistener_absolute_url}`);
  if (c.assigned_judge) lines.push(`Judge: ${c.assigned_judge}`);

  return lines.join("\n");
}

function buildNoteHtml(c, contacts) {
  const filed = formatPetitionDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;

  const principals = contacts.filter(x => x.contact_type === "principal");
  const attorneys  = contacts.filter(x => x.contact_type === "debtor_attorney");
  const trustees   = contacts.filter(x => x.contact_type === "subchapter_v_trustee");

  let html = "<body>";
  html += `<h2>${c.case_name || c.debtor_name || "Unknown Debtor"}</h2>`;
  html += `<p><strong>Case No:</strong> ${c.case_number || "—"}</p>`;
  html += `<p><strong>Filed:</strong> ${filed || "—"}${days !== null ? ` — Day ${days} since filing` : ""}</p>`;
  html += `<p><strong>Court:</strong> ${(c.court_id || "").toUpperCase()}${c.district ? " — " + c.district : ""}</p>`;
  if (c.state || STATE_MAP[c.court_id]) {
    html += `<p><strong>State:</strong> ${c.state || STATE_MAP[c.court_id] || ""}</p>`;
  }
  if (c.courtlistener_absolute_url) {
    html += `<p><strong>CourtListener:</strong> <a href="${c.courtlistener_absolute_url}">${c.courtlistener_absolute_url}</a></p>`;
  }
  if (c.subchapterv_confidence) {
    html += `<p><strong>Sub-V Confidence:</strong> ${c.subchapterv_confidence}</p>`;
  }

  if (principals.length) {
    html += "<hr/><h3>Principal / Owner</h3>";
    principals.forEach(function(p) {
      html += `<p><strong>${p.full_name || "Unknown"}</strong>`;
      if (p.title) html += ` — ${p.title}`;
      html += "</p>";
      if (p.email)   html += `<p>Email: ${p.email}</p>`;
      if (p.phone)   html += `<p>Phone: ${p.phone}</p>`;
      if (p.source)  html += `<p><em>Source: ${p.source} — verify before outreach</em></p>`;
    });
  }

  if (attorneys.length) {
    html += "<hr/><h3>Debtor Attorney</h3>";
    attorneys.forEach(function(a) {
      html += `<p><strong>${a.full_name || "Unknown"}</strong>`;
      if (a.organization_name) html += ` — ${a.organization_name}`;
      html += "</p>";
      if (a.email) html += `<p>Email: ${a.email}</p>`;
      if (a.phone) html += `<p>Phone: ${a.phone}</p>`;
    });
  }

  if (trustees.length) {
    html += "<hr/><h3>Sub-V Trustee</h3>";
    trustees.forEach(function(t) {
      html += `<p><strong>${t.full_name || "Unknown"}</strong></p>`;
      if (t.email) html += `<p>Email: ${t.email}</p>`;
      if (t.phone) html += `<p>Phone: ${t.phone}</p>`;
    });
  }

  html += "</body>";
  return html;
}

// ── CHECK IF LEAD ALREADY EXISTS ──
async function findExistingLead(caseNumber) {
  if (!caseNumber) return null;
  try {
    const result = await closeRequest("GET", `/lead/?query=${encodeURIComponent(caseNumber)}&_fields=id,display_name`);
    if (result._error) return null;
    const leads = result.data || [];
    return leads.length > 0 ? leads[0] : null;
  } catch(e) {
    logger.warn(`Close lead search failed for ${caseNumber}: ${e.message}`);
    return null;
  }
}

// ── CREATE LEAD ──
async function createLead(c) {
  const name = c.case_name || c.debtor_name || "Unknown Debtor";
  const payload = {
    name:        name,
    description: buildLeadDescription(c),
    status_id:   LEAD_STATUS.newNeedsReview,
    url:         c.website || null,
    addresses: c.address ? [{
      label:   "business",
      address: c.address,
    }] : [],
    custom: {},
  };

  const result = await closeRequest("POST", "/lead/", payload);
  if (result._error) {
    throw new Error(`Failed to create lead for ${name}: ${JSON.stringify(result._body).slice(0, 200)}`);
  }
  return result;
}

// ── CREATE CONTACT ──
async function createContact(leadId, contact) {
  const name = contact.full_name || "";
  if (!name) return null;

  const phones = [];
  if (contact.phone) {
    phones.push({ phone: contact.phone, type: "office" });
  }

  const emails = [];
  if (contact.email) {
    emails.push({ email: contact.email, type: "office" });
  }

  const payload = {
    lead_id: leadId,
    name:    name,
    title:   contact.title || contact.contact_type || null,
    phones:  phones,
    emails:  emails,
  };

  const result = await closeRequest("POST", "/contact/", payload);
  if (result._error) {
    logger.warn(`Failed to create contact ${name}: ${JSON.stringify(result._body).slice(0, 200)}`);
    return null;
  }
  return result;
}

// ── CREATE NOTE ──
async function createNote(leadId, noteHtml) {
  const result = await closeRequest("POST", "/activity/note/", {
    lead_id:    leadId,
    note_html:  noteHtml,
    _type:      "Note",
  });
  if (result._error) {
    logger.warn(`Failed to create note for lead ${leadId}`);
    return null;
  }
  return result;
}

// ── CREATE OPPORTUNITY ──
async function createOpportunity(leadId, c) {
  const filed = formatPetitionDate(c.petition_date);
  const note  = [
    `Sub-V MOR automation — $200/month`,
    filed ? `Filed: ${filed}` : null,
    c.case_number ? `Case: ${c.case_number}` : null,
    `Court: ${(c.court_id || "").toUpperCase()}`,
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
    logger.warn(`Failed to create opportunity for lead ${leadId}`);
    return null;
  }
  return result;
}

// ── MAIN EXPORT — push one case to Close ──
async function pushCaseToClose(caseRow, contacts) {
  if (!CLOSE_API_KEY) {
    logger.warn("CLOSE_API_KEY not set — skipping Close integration");
    return { skipped: true, reason: "no_api_key" };
  }

  const caseNumber = caseRow.case_number || "";
  const caseName   = caseRow.case_name || caseRow.debtor_name || "Unknown";

  try {
    // 1. Check for duplicate
    const existing = await findExistingLead(caseNumber);
    if (existing) {
      logger.info(`Close: lead already exists for ${caseNumber} — skipping`);
      return { skipped: true, reason: "duplicate", leadId: existing.id };
    }

    // 2. Create lead
    const lead = await createLead(caseRow);
    const leadId = lead.id;
    logger.info(`Close: created lead ${leadId} for ${caseName}`);

    // 3. Create contacts — principals first, then attorneys
    const principals = (contacts || []).filter(c => c.contact_type === "principal");
    const attorneys  = (contacts || []).filter(c => c.contact_type === "debtor_attorney");
    const trustees   = (contacts || []).filter(c => c.contact_type === "subchapter_v_trustee");

    const allContacts = [...principals, ...attorneys, ...trustees];
    for (const contact of allContacts.slice(0, 5)) {
      await createContact(leadId, contact);
    }

    // 4. Create pinned note with full case summary
    const noteHtml = buildNoteHtml(caseRow, contacts || []);
    await createNote(leadId, noteHtml);

    // 5. Create opportunity
    await createOpportunity(leadId, caseRow);

    logger.info(`Close: fully created lead for ${caseName} (${caseNumber})`);
    return { success: true, leadId, caseName, caseNumber };

  } catch(e) {
    logger.error(`Close push failed for ${caseName}: ${e.message}`);
    return { error: true, message: e.message, caseName, caseNumber };
  }
}

// ── BATCH PUSH — push multiple cases ──
async function pushCasesToClose(cases) {
  if (!CLOSE_API_KEY) {
    logger.warn("CLOSE_API_KEY not set — skipping Close batch push");
    return { skipped: true };
  }

  const results = { pushed: 0, skipped: 0, errors: 0, details: [] };

  for (const item of cases) {
    // Respect Close API rate limits — 100 req/10s
    await new Promise(r => setTimeout(r, 300));

    const result = await pushCaseToClose(item.case, item.contacts || []);
    results.details.push(result);

    if (result.success)  results.pushed++;
    else if (result.skipped) results.skipped++;
    else                 results.errors++;
  }

  logger.info(`Close batch push complete: ${results.pushed} pushed, ${results.skipped} skipped, ${results.errors} errors`);
  return results;
}

module.exports = { pushCaseToClose, pushCasesToClose };
