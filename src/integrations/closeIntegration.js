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
            logger.warn("Close API " + resp.statusCode + " " + method + " " + path + ": " + data.slice(0, 200));
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

// ── FILTER PATTERNS ──

const BAD_NAME_PATTERNS = [
  /^unknown debtor/i,
  /^and the case number/i,
  /official form/i,
  /pursuant to/i,
  /of the united states/i,
  /bankruptcy code/i,
  /subchapter v election/i,
  /voluntary petition/i,
  /^in re:/i,
  /^case number/i,
  /^docket number/i,
];

const US_TRUSTEE_PATTERNS = [
  /u\.?s\.?\s*trustee/i,
  /united states trustee/i,
  /office of the.*trustee/i,
  /department of justice/i,
  /u\.s\. department/i,
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

function isValidLeadName(name) {
  if (!name || name.trim().length < 3) return false;
  for (const pattern of BAD_NAME_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
}

function isUSTrusteeContact(contact) {
  const name = (contact.full_name || "").toLowerCase();
  const org  = (contact.organization_name || "").toLowerCase();
  for (const pattern of US_TRUSTEE_PATTERNS) {
    if (pattern.test(name) || pattern.test(org)) return true;
  }
  return false;
}

function isValidTitle(title) {
  if (!title) return true;
  for (const pattern of BAD_TITLE_PATTERNS) {
    if (pattern.test(title)) return false;
  }
  return true;
}

function isPrincipalActuallyAttorney(principal, attorneys) {
  const principalName = (principal.full_name || "").toLowerCase().trim();
  if (!principalName) return false;
  for (const a of attorneys) {
    const attorneyName = (a.full_name || "").toLowerCase().trim();
    if (attorneyName && (
      attorneyName === principalName ||
      attorneyName.includes(principalName) ||
      principalName.includes(attorneyName)
    )) return true;
  }
  return false;
}

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
  const filed = formatPetitionDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;

  lines.push("Sub-V Chapter 11 — Case " + (c.case_number || "unknown"));
  if (filed)        lines.push("Filed: " + filed + (days !== null ? " (Day " + days + ")" : ""));
  if (c.court_id)   lines.push("Court: " + c.court_id.toUpperCase() + (c.district ? " — " + c.district : ""));
  if (c.state || STATE_MAP[c.court_id]) lines.push("State: " + (c.state || STATE_MAP[c.court_id] || ""));
  if (c.courtlistener_absolute_url) lines.push("CourtListener: " + c.courtlistener_absolute_url);
  if (c.assigned_judge) lines.push("Judge: " + c.assigned_judge);

  return lines.join("\n");
}

function buildNoteHtml(c, contacts) {
  const filed = formatPetitionDate(c.petition_date);
  const days  = filed ? daysSince(filed) : null;

  const attorneys = (contacts || []).filter(function(x) {
    return x.contact_type === "debtor_attorney" && !isUSTrusteeContact(x);
  });
  const principals = (contacts || []).filter(function(x) {
    return x.contact_type === "principal" &&
           !isPrincipalActuallyAttorney(x, attorneys) &&
           isValidTitle(x.title);
  });
  const trustees = (contacts || []).filter(function(x) {
    return x.contact_type === "subchapter_v_trustee";
  });

  let html = "<body>";
  html += "<h2>" + (c.case_name || c.debtor_name || "Unknown Debtor") + "</h2>";
  html += "<p><strong>Case No:</strong> " + (c.case_number || "—") + "</p>";
  html += "<p><strong>Filed:</strong> " + (filed || "—") + (days !== null ? " — Day " + days + " since filing" : "") + "</p>";
  html += "<p><strong>Court:</strong> " + (c.court_id || "").toUpperCase() + (c.district ? " — " + c.district : "") + "</p>";

  const stateStr = c.state || STATE_MAP[c.court_id] || "";
  if (stateStr) html += "<p><strong>State:</strong> " + stateStr + "</p>";

  if (c.courtlistener_absolute_url) {
    html += "<p><strong>CourtListener:</strong> <a href=\"" + c.courtlistener_absolute_url + "\">" + c.courtlistener_absolute_url + "</a></p>";
  }
  if (c.subchapterv_confidence) {
    html += "<p><strong>Sub-V Confidence:</strong> " + c.subchapterv_confidence + "</p>";
  }

  if (principals.length) {
    html += "<hr/><h3>Principal / Owner</h3>";
    principals.forEach(function(p) {
      html += "<p><strong>" + (p.full_name || "Unknown") + "</strong>";
      if (p.title && isValidTitle(p.title)) html += " — " + p.title;
      html += "</p>";
      if (p.primary_email) html += "<p>Email: " + p.primary_email + "</p>";
      if (p.primary_phone) html += "<p>Phone: " + p.primary_phone + "</p>";
    });
  } else {
    html += "<hr/><h3>Principal / Owner</h3><p><em>Not identified — manual review recommended.</em></p>";
  }

  if (attorneys.length) {
    html += "<hr/><h3>Debtor Attorney</h3>";
    attorneys.forEach(function(a) {
      html += "<p><strong>" + (a.full_name || "Unknown") + "</strong>";
      if (a.organization_name) html += " — " + a.organization_name;
      html += "</p>";
      if (a.primary_email) html += "<p>Email: " + a.primary_email + "</p>";
      if (a.primary_phone) html += "<p>Phone: " + a.primary_phone + "</p>";
    });
  }

  if (trustees.length) {
    html += "<hr/><h3>Sub-V Trustee</h3>";
    trustees.forEach(function(t) {
      html += "<p><strong>" + (t.full_name || "Unknown") + "</strong></p>";
      if (t.primary_email) html += "<p>Email: " + t.primary_email + "</p>";
      if (t.primary_phone) html += "<p>Phone: " + t.primary_phone + "</p>";
    });
  }

  html += "</body>";
  return html;
}

// ── CHECK IF LEAD ALREADY EXISTS ──
async function findExistingLead(caseNumber) {
  if (!caseNumber) return null;
  try {
    const result = await closeRequest("GET", "/lead/?query=" + encodeURIComponent(caseNumber) + "&_fields=id,display_name");
    if (result._error) return null;
    const leads = result.data || [];
    return leads.length > 0 ? leads[0] : null;
  } catch(e) {
    logger.warn("Close lead search failed for " + caseNumber + ": " + e.message);
    return null;
  }
}

// ── CREATE LEAD ──
async function createLead(c) {
  const name = c.case_name || c.debtor_name || "Unknown Debtor";
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
  const name = contact.full_name || "";
  if (!name) return null;

  const phones = [];
  if (contact.primary_phone) phones.push({ phone: contact.primary_phone, type: "office" });

  const emails = [];
  if (contact.primary_email) emails.push({ email: contact.primary_email, type: "office" });

  const title = isValidTitle(contact.title)
    ? (contact.title || contact.contact_type || null)
    : (contact.contact_type || null);

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
    logger.warn("Failed to create note for lead " + leadId);
    return null;
  }
  return result;
}

// ── CREATE OPPORTUNITY ──
async function createOpportunity(leadId, c) {
  const filed = formatPetitionDate(c.petition_date);
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
              o.organization_name
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
    logger.warn("CLOSE_API_KEY not set — skipping Close integration");
    return { skipped: true, reason: "no_api_key" };
  }

  const caseNumber = caseRow.case_number || "";
  const caseName   = caseRow.case_name   || caseRow.debtor_name || "";

  // Skip non-Sub-V
  if (!caseRow.is_subchapter_v) {
    logger.info("Close: skipping non-Sub-V case " + caseName);
    return { skipped: true, reason: "not_subchapter_v" };
  }

  // Skip bad names
  if (!isValidLeadName(caseName)) {
    logger.warn("Close: skipping lead with invalid name: '" + caseName + "'");
    return { skipped: true, reason: "invalid_name", caseName };
  }

  // Skip duplicates
  const existing = await findExistingLead(caseNumber);
  if (existing) {
    logger.info("Close: lead already exists for " + caseNumber + " — skipping");
    return { skipped: true, reason: "duplicate", leadId: existing.id };
  }

  try {
    const lead   = await createLead(caseRow);
    const leadId = lead.id;
    logger.info("Close: created lead " + leadId + " for " + caseName);

    // Filter contacts
    const attorneys = (contacts || []).filter(function(c) {
      return c.contact_type === "debtor_attorney" && !isUSTrusteeContact(c);
    });
    const principals = (contacts || []).filter(function(c) {
      return c.contact_type === "principal" &&
             !isPrincipalActuallyAttorney(c, attorneys) &&
             isValidTitle(c.title);
    });
    const trustees = (contacts || []).filter(function(c) {
      return c.contact_type === "subchapter_v_trustee";
    });

    const allContacts = principals.concat(attorneys).concat(trustees);

    for (const contact of allContacts.slice(0, 5)) {
      await new Promise(function(r) { setTimeout(r, 150); });
      await createContact(leadId, contact);
    }

    const noteHtml = buildNoteHtml(caseRow, contacts || []);
    await createNote(leadId, noteHtml);
    await createOpportunity(leadId, caseRow);

    logger.info("Close: fully created lead for " + caseName + " (" + caseNumber + ")");
    return { success: true, leadId, caseName, caseNumber };

  } catch(e) {
    logger.error("Close push failed for " + caseName + ": " + e.message);
    return { error: true, message: e.message, caseName, caseNumber };
  }
}

// ── BATCH PUSH ──
async function pushCasesToClose(cases) {
  if (!CLOSE_API_KEY) {
    logger.warn("CLOSE_API_KEY not set — skipping Close batch push");
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

  logger.info("Close batch complete: " + results.pushed + " pushed, " + results.skipped + " skipped, " + results.errors + " errors");
  return results;
}

module.exports = { pushCaseToClose, pushCasesToClose, getContactsForCase };
