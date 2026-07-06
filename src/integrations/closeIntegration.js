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
            logger.warn("Close API " + resp.statusCode + " " + method + " " + path + ": " + data.slice(0, 300));
            resolve({ _error: true, _status: resp.statusCode, _body: parsed });
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error("Close API non-JSON: " + data.slice(0, 200)));
        }
      });
    });

    req.setTimeout(20000, function() {
      req.destroy();
      reject(new Error("Close API timeout: " + path));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── LEAD STATUS IDs ──
const LEAD_STATUS = {
  newNeedsReview: "stat_KnhQmcVJLP0nSs8wdYqGxcW7hpe0Ey4h5ecIzfarMcK",
};

// ── OPPORTUNITY STATUS IDs ──
const OPPORTUNITY_STATUS = {
  discoveryCallScheduled: "stat_H0XAr39brZTeiJoTKfQ1AHV7F0YX1NsljApuLdEq1V4",
};

// ── STATE MAP ──
const STATE_MAP = {
  txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",
  nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
  flsb:"Florida",flmb:"Florida",flnb:"Florida",
  caeb:"California",canb:"California",cacb:"California",casb:"California",
  ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",ilsb:"Illinois",
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

// ── FILTER PATTERNS ──
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

// Comprehensive US Trustee filter — applies to ALL contact types
const US_TRUSTEE_NAMES = [
  /u\.?s\.?\s*trustee/i,
  /united states trustee/i,
  /office of the.*trustee/i,
  /u\.s\.\s*department/i,
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
  // Remove trailing ", Debtor" or "(Debtor)"
  name = name.replace(/,?\s*\(?\s*debtor\s*\)?\s*$/i, "").trim();
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

function isValidLeadName(name) {
  if (!name || name.trim().length < 3) return false;
  for (const p of BAD_LEAD_NAMES) { if (p.test(name)) return false; }
  return true;
}

function isUSTrustee(contact) {
  const name = (contact.full_name || "").toLowerCase();
  const org  = (contact.organization_name || "").toLowerCase();
  for (const p of US_TRUSTEE_NAMES) {
    if (p.test(name) || p.test(org)) return true;
  }
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
    if (aName && aName.length > 3 && (aName === pName || aName.includes(pName) || pName.includes(aName))) {
      return true;
    }
  }
  return false;
}

// ── CONTACT PRIORITY SORT ──
// Order: enriched principal (ai_enrichment) > petition principal > attorney > trustee
function sortContacts(contacts) {
  const priority = {
    "principal": 0,
    "debtor_attorney": 1,
    "subchapter_v_trustee": 2,
  };
  return contacts.slice().sort(function(a, b) {
    const pa = priority[a.contact_type] !== undefined ? priority[a.contact_type] : 3;
    const pb = priority[b.contact_type] !== undefined ? priority[b.contact_type] : 3;
    if (pa !== pb) return pa - pb;
    // Within principals: AI-enriched first (source_type = ai_enrichment)
    if (pa === 0) {
      const aIsAI = (a.source_type || "").includes("ai");
      const bIsAI = (b.source_type || "").includes("ai");
      if (aIsAI && !bIsAI) return -1;
      if (!aIsAI && bIsAI) return  1;
    }
    return 0;
  });
}

// ── HELPERS ──
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr).toISOString().slice(0, 10); } catch(e) { return null; }
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

function buildNoteHtml(c, contacts) {
  const filed = formatDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;

  // Apply all filters
  const attorneys  = contacts.filter(function(x) { return x.contact_type === "debtor_attorney" && !isUSTrustee(x); });
  const principals = contacts.filter(function(x) {
    return x.contact_type === "principal" &&
           !isUSTrustee(x) &&
           !isPrincipalActuallyAttorney(x, attorneys) &&
           isValidTitle(x.title);
  });
  const trustees = contacts.filter(function(x) { return x.contact_type === "subchapter_v_trustee" && !isUSTrustee(x); });

  let html = "<body>";
  html += "<h2>" + cleanName(c.case_name || c.debtor_name || "Unknown") + "</h2>";
  html += "<p><strong>Case No:</strong> " + (c.case_number || "—") + "</p>";
  html += "<p><strong>Filed:</strong> " + (filed || "—") + (days !== null ? " — Day " + days + " since filing" : "") + "</p>";
  html += "<p><strong>Court:</strong> " + (c.court_id || "").toUpperCase() + "</p>";
  const state = c.state || STATE_MAP[c.court_id] || "";
  if (state) html += "<p><strong>State:</strong> " + state + "</p>";
  if (c.courtlistener_absolute_url) {
    html += "<p><strong>CourtListener:</strong> <a href=\"" + c.courtlistener_absolute_url + "\">" + c.courtlistener_absolute_url + "</a></p>";
  }
  if (c.subchapterv_confidence) {
    html += "<p><strong>Sub-V Confidence:</strong> " + c.subchapterv_confidence + "</p>";
  }

  if (principals.length) {
    html += "<hr/><h3>Principal / Owner</h3>";
    principals.forEach(function(p) {
      const name = cleanName(p.full_name || "Unknown");
      const title = isValidTitle(p.title) ? p.title : null;
      html += "<p><strong>" + name + "</strong>" + (title ? " — " + title : "") + "</p>";
      if (p.primary_email) html += "<p>Email: " + p.primary_email + "</p>";
      if (p.primary_phone) html += "<p>Phone: " + p.primary_phone + "</p>";
    });
  } else {
    html += "<hr/><h3>Principal / Owner</h3><p><em>Not yet identified — manual review recommended.</em></p>";
  }

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

  if (trustees.length) {
    html += "<hr/><h3>Sub-V Trustee</h3>";
    trustees.forEach(function(t) {
      html += "<p><strong>" + cleanName(t.full_name || "Unknown") + "</strong></p>";
      if (t.primary_email) html += "<p>Email: " + t.primary_email + "</p>";
      if (t.primary_phone) html += "<p>Phone: " + t.primary_phone + "</p>";
    });
  }

  html += "</body>";
  return html;
}

// ── CHECK FOR DUPLICATE LEAD ──
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

// ── CREATE LEAD ──
async function createLead(c) {
  const name = cleanName(c.case_name || c.debtor_name || "Unknown Debtor");
  const result = await closeRequest("POST", "/lead/", {
    name:        name,
    description: buildLeadDescription(c),
    status_id:   LEAD_STATUS.newNeedsReview,
    url:         c.website || null,
    custom:      {},
  });
  if (result._error) {
    throw new Error("Failed to create lead for " + name + ": " + JSON.stringify(result._body).slice(0, 200));
  }
  return result;
}

// ── CREATE CONTACT ──
async function createContact(leadId, contact) {
  const name = cleanName(contact.full_name || "");
  if (!name || name.length < 2) return null;
  if (isUSTrustee(contact)) return null;

  const phones = [];
  if (contact.primary_phone) phones.push({ phone: contact.primary_phone, type: "office" });

  const emails = [];
  if (contact.primary_email) emails.push({ email: contact.primary_email, type: "office" });

  const title = isValidTitle(contact.title)
    ? (contact.title || null)
    : (contact.contact_type === "principal" ? "Owner" :
       contact.contact_type === "debtor_attorney" ? "Attorney" :
       contact.contact_type === "subchapter_v_trustee" ? "Trustee" : null);

  const result = await closeRequest("POST", "/contact/", {
    lead_id: leadId,
    name:    name,
    title:   title,
    phones:  phones,
    emails:  emails,
  });

  if (result._error) {
    logger.warn("Failed to create contact " + name + ": " + JSON.stringify(result._body).slice(0, 200));
    return null;
  }
  return result;
}

// ── CREATE NOTE ──
async function createNote(leadId, noteHtml) {
  const result = await closeRequest("POST", "/activity/note/", {
    lead_id:   leadId,
    note_html: noteHtml,
    _type:     "Note",
  });
  if (result._error) {
    logger.warn("Close note failed for lead " + leadId + " (status " + result._status + "): " + JSON.stringify(result._body).slice(0, 200));
    return null;
  }
  return result;
}

// ── CREATE OPPORTUNITY ──
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

// ── FETCH CONTACTS FOR A CASE FROM DB ──
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

// ── MAIN — push one case to Close ──
async function pushCaseToClose(caseRow, contacts) {
  if (!CLOSE_API_KEY) {
    logger.warn("CLOSE_API_KEY not set — skipping");
    return { skipped: true, reason: "no_api_key" };
  }

  const caseNumber = caseRow.case_number || "";
  const caseName   = cleanName(caseRow.case_name || caseRow.debtor_name || "");

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
    // ── Create lead ──
    const lead   = await createLead(caseRow);
    const leadId = lead.id;
    logger.info("Close: created lead " + leadId + " — " + caseName);

    // ── Filter and sort contacts ──
    const attorneys  = (contacts || []).filter(function(c) { return c.contact_type === "debtor_attorney" && !isUSTrustee(c); });
    const principals = (contacts || []).filter(function(c) {
      return c.contact_type === "principal" &&
             !isUSTrustee(c) &&
             !isPrincipalActuallyAttorney(c, attorneys) &&
             isValidTitle(c.title);
    });
    const trustees = (contacts || []).filter(function(c) { return c.contact_type === "subchapter_v_trustee" && !isUSTrustee(c); });

    // Principal first (preferring AI-enriched), then attorney, then trustee
    const allContacts = sortContacts(principals).concat(attorneys).concat(trustees);

    for (const contact of allContacts.slice(0, 5)) {
      await new Promise(function(r) { setTimeout(r, 200); });
      await createContact(leadId, contact);
    }

    // ── Note ──
    const noteHtml = buildNoteHtml(caseRow, contacts || []);
    await createNote(leadId, noteHtml);

    // ── Opportunity ──
    await createOpportunity(leadId, caseRow);

    logger.info("Close: fully created — " + caseName + " (" + caseNumber + ") — " + principals.length + " principals, " + attorneys.length + " attorneys");
    return { success: true, leadId, caseName, caseNumber, principalCount: principals.length };

  } catch(e) {
    logger.error("Close push failed for " + caseName + ": " + e.message);
    return { error: true, message: e.message, caseName, caseNumber };
  }
}

// ── BATCH PUSH ──
async function pushCasesToClose(cases) {
  if (!CLOSE_API_KEY) {
    return { skipped: true };
  }
  const results = { pushed: 0, skipped: 0, errors: 0, details: [] };
  for (const item of cases) {
    await new Promise(function(r) { setTimeout(r, 400); });
    const result = await pushCaseToClose(item.case, item.contacts || []);
    results.details.push(result);
    if (result.success)      results.pushed++;
    else if (result.skipped) results.skipped++;
    else                     results.errors++;
  }
  logger.info("Close batch: " + results.pushed + " pushed, " + results.skipped + " skipped, " + results.errors + " errors");
  return results;
}

module.exports = { pushCaseToClose, pushCasesToClose, getContactsForCase };
