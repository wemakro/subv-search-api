"use strict";
const https  = require("https");
const http   = require("http");
const logger = require("./logger");

const GOOGLE_KEY  = process.env.GOOGLE_API_KEY  || "";
const GEMINI_KEY  = process.env.GEMINI_API_KEY  || "";
const OPENAI_KEY  = process.env.OPENAI_API_KEY  || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL   || "gemini-2.0-flash";

// ── FETCH ──
function fetchUrl(url, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    try {
      var lib = url.startsWith("https") ? https : http;
      var req = lib.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,application/json" }
      }, function(resp) {
        if ([301,302,303,307,308].indexOf(resp.statusCode) > -1 && resp.headers.location) {
          return fetchUrl(resp.headers.location, opts).then(resolve).catch(reject);
        }
        var data = "";
        resp.setEncoding("utf8");
        resp.on("data", function(c) { data += c; });
        resp.on("end",  function() { resolve({ status: resp.statusCode, body: data }); });
      });
      req.setTimeout(opts.timeout || 12000, function() { req.destroy(); reject(new Error("Timeout: " + url)); });
      req.on("error", reject);
    } catch(e) { reject(e); }
  });
}

function postJson(hostname, path, body, extraHeaders) {
  return new Promise(function(resolve, reject) {
    try {
      var bodyStr = JSON.stringify(body);
      var hdrs    = Object.assign({
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr)
      }, extraHeaders || {});
      var data = "";
      var req  = https.request({ hostname: hostname, path: path, method: "POST", headers: hdrs }, function(resp) {
        resp.setEncoding("utf8");
        resp.on("data", function(c) { data += c; });
        resp.on("end",  function() { resolve({ status: resp.statusCode, body: data }); });
      });
      req.setTimeout(50000, function() { req.destroy(); reject(new Error("Timeout posting to " + hostname)); });
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    } catch(e) { reject(e); }
  });
}

// ── FIX 1: get debtor name safely whether debtor is string or object ──
function getDebtorName(caseData) {
  var name = "";
  if (caseData.debtor && typeof caseData.debtor === "object") {
    name = caseData.debtor.name || "";
  } else if (typeof caseData.debtor === "string") {
    name = caseData.debtor;
  }
  return (name || caseData.debtorName || caseData.caseName || caseData.name || "").trim();
}

// ── HELPERS ──
function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,"")
             .replace(/<style[\s\S]*?<\/style>/gi,"")
             .replace(/<[^>]+>/g," ")
             .replace(/\s+/g," ").trim();
}

function extractEmails(text) {
  var matches = text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || [];
  var bad = /noreply|no-reply|donotreply|example|\.png|\.jpg|privacy|abuse|sentry|wix|wordpress|squarespace/i;
  var seen = {}, out = [];
  matches.forEach(function(e) { if (!bad.test(e) && !seen[e]) { seen[e]=true; out.push(e); } });
  return out.slice(0,5);
}

function extractPhones(text) {
  var matches = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g) || [];
  var seen = {}, out = [];
  matches.forEach(function(p) { p=p.trim(); if (!seen[p]) { seen[p]=true; out.push(p); } });
  return out.slice(0,5);
}

function guessEmails(name, domain) {
  if (!name || !domain) return [];
  var parts = name.toLowerCase().replace(/[^a-z\s]/g,"").trim().split(/\s+/);
  var first = parts[0]||"", last = parts[parts.length-1]||"";
  if (!first || !last || first === last) return [];
  return [
    { email: first+"."+last+"@"+domain, pattern:"first.last" },
    { email: first+"@"+domain,           pattern:"first" },
    { email: first[0]+last+"@"+domain,   pattern:"flast" },
    { email: first+last[0]+"@"+domain,   pattern:"firstl" },
    { email: last+"@"+domain,            pattern:"last" }
  ];
}

function parseJsonFromText(text) {
  if (!text) return null;
  // Try direct parse first (if responseMimeType=application/json worked)
  try { return JSON.parse(text.trim()); } catch(e) {}
  // Fall back to regex extraction
  var clean = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  var match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch(e) { return null; }
}

// ── FIX 2: build prompt with full case context so Gemini isn't guessing blind ──
function buildGeminiPrompt(caseData, debtorName) {
  var knownData = {
    docketId:     caseData.docketId,
    caseName:     caseData.caseName,
    debtorName:   debtorName,
    docketNumber: caseData.docketNumber,
    courtId:      caseData.courtId,
    courtName:    caseData.courtName,
    dateFiled:    caseData.dateFiled,
    trustee:      caseData.trustee,
    attorneys:    caseData.attorneys,
    principals:   caseData.principals
  };

  return "You are enriching a Chapter 11 Subchapter V bankruptcy CRM record.\n\n"
    + "Use public web research. Do not invent facts. Return only valid JSON.\n\n"
    + "Known case data:\n"
    + JSON.stringify(knownData, null, 2) + "\n\n"
    + "IMPORTANT: Many companies file under a holding company name but operate under a trade/DBA name.\n"
    + "Search for BOTH the legal name AND any DBA/trade name.\n\n"
    + "Research goals:\n"
    + "1. Operating/trade name (DBA) if different from legal name\n"
    + "2. Business address and main phone\n"
    + "3. Website URL (primary and alternate if DBA has different site)\n"
    + "4. The ACTUAL OWNER, operator, managing member, or president\n"
    + "5. The petition signer / authorized representative from court documents\n"
    + "6. Any other key contacts\n"
    + "7. What the business does\n"
    + "8. Why they filed for bankruptcy\n"
    + "9. Include source URLs for every important claim\n\n"
    + "Return ONLY this JSON shape:\n"
    + "{\n"
    + '  "companyLegalName": null,\n'
    + '  "tradeName": null,\n'
    + '  "address": null,\n'
    + '  "phone": null,\n'
    + '  "website": null,\n'
    + '  "altWebsite": null,\n'
    + '  "ownerName": null,\n'
    + '  "ownerTitle": null,\n'
    + '  "ownerEmail": null,\n'
    + '  "ownerPhone": null,\n'
    + '  "petitionSigner": null,\n'
    + '  "petitionSignerTitle": null,\n'
    + '  "otherContacts": [],\n'
    + '  "businessType": null,\n'
    + '  "bankruptcyReason": null,\n'
    + '  "sources": [],\n'
    + '  "confidence": "LOW",\n'
    + '  "warnings": []\n'
    + "}";
}

// ── FIX 3: Gemini with application/json mime type + better error logging ──
async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  try {
    var res = await postJson(
      "generativelanguage.googleapis.com",
      "/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + GEMINI_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 4096
        }
      }
    );

    if (res.status < 200 || res.status >= 300) {
      logger.warn("Gemini HTTP " + res.status + ": " + res.body.slice(0, 500));
      return null;
    }

    var parsed = JSON.parse(res.body);
    var parts  = [];
    var cand   = (parsed.candidates || [])[0];
    if (cand && cand.content && cand.content.parts) {
      cand.content.parts.forEach(function(p) { if (p.text) parts.push(p.text); });
    }
    var text = parts.join("");
    if (!text) {
      logger.warn("Gemini returned no text. Full response: " + res.body.slice(0, 1000));
      return null;
    }
    logger.debug("Gemini raw preview: " + text.slice(0, 300));
    return text;
  } catch(e) {
    logger.warn("Gemini error: " + e.message);
    return null;
  }
}

// ── FIX 4: OpenAI using chat completions (not Responses API) ──
async function callOpenAI(prompt) {
  if (!OPENAI_KEY) return null;
  try {
    var res = await postJson(
      "api.openai.com",
      "/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a business research assistant. Always return valid JSON only." },
          { role: "user",   content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.1,
        response_format: { type: "json_object" }
      },
      { "Authorization": "Bearer " + OPENAI_KEY }
    );

    if (res.status < 200 || res.status >= 300) {
      logger.warn("OpenAI HTTP " + res.status + ": " + res.body.slice(0, 300));
      return null;
    }
    var parsed = JSON.parse(res.body);
    return ((parsed.choices || [])[0] || {}).message
      ? parsed.choices[0].message.content
      : null;
  } catch(e) {
    logger.warn("OpenAI error: " + e.message);
    return null;
  }
}

// ── AI ENRICHMENT ──
async function aiSearchEnrich(caseData, debtorName) {
  if (!GEMINI_KEY && !OPENAI_KEY) { logger.warn("No AI key configured"); return null; }
  var prompt = buildGeminiPrompt(caseData, debtorName);
  var text   = null;
  if (GEMINI_KEY) {
    logger.info("Gemini enrichment: " + debtorName);
    text = await callGemini(prompt);
  }
  if (!text && OPENAI_KEY) {
    logger.info("OpenAI fallback: " + debtorName);
    text = await callOpenAI(prompt);
  }
  var result = parseJsonFromText(text);
  if (!result) logger.warn("AI parse failed for: " + debtorName + " | raw: " + String(text||"").slice(0, 500));
  return result;
}

// ── GOOGLE PLACES ──
async function googlePlaces(name, state) {
  if (!GOOGLE_KEY) return null;
  try {
    var q   = encodeURIComponent(name + (state ? " "+state : ""));
    var res = await fetchUrl("https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input="+q+"&inputtype=textquery&fields=place_id,name,formatted_address,formatted_phone_number,website&key="+GOOGLE_KEY);
    var d   = JSON.parse(res.body);
    if (d.status !== "OK" || !d.candidates || !d.candidates.length) return null;
    var pl  = d.candidates[0];
    if (pl.place_id) {
      var r2 = await fetchUrl("https://maps.googleapis.com/maps/api/place/details/json?place_id="+pl.place_id+"&fields=name,formatted_address,formatted_phone_number,website,url&key="+GOOGLE_KEY);
      var d2 = JSON.parse(r2.body);
      if (d2.status === "OK" && d2.result) {
        return { address: d2.result.formatted_address||"", phone: d2.result.formatted_phone_number||"", website: d2.result.website||"", mapsUrl: d2.result.url||"" };
      }
    }
    return { address: pl.formatted_address||"", phone: pl.formatted_phone_number||"", website: pl.website||"", mapsUrl: "" };
  } catch(e) { logger.warn("Google Places error: "+e.message); return null; }
}

// ── WEBSITE SCRAPE ──
async function scrapeWebsite(url) {
  if (!url) return { emails:[], phones:[] };
  var result = { emails:[], phones:[], contactPageUrl: null };
  try {
    var home = await fetchUrl(url, { timeout: 8000 });
    result.emails = extractEmails(home.body);
    result.phones = extractPhones(stripHtml(home.body));
    var cm = home.body.match(/href=["']([^"']*contact[^"']*)/i);
    if (cm) {
      var cu = cm[1];
      if (cu.startsWith("/")) { try { var b = new URL(url); cu = b.origin+cu; } catch(e) {} }
      if (!cu.startsWith("http")) cu = url+"/"+cu;
      result.contactPageUrl = cu;
      try {
        var cp  = await fetchUrl(cu, { timeout: 8000 });
        var cpe = extractEmails(cp.body);
        var cpp = extractPhones(stripHtml(cp.body));
        var seen={};
        result.emails.concat(cpe).forEach(function(e) { if (!seen[e]) seen[e]=true; });
        result.emails = Object.keys(seen).slice(0,5);
        var seenp={};
        result.phones.concat(cpp).forEach(function(p) { if (!seenp[p]) seenp[p]=true; });
        result.phones = Object.keys(seenp).slice(0,5);
      } catch(e) {}
    }
  } catch(e) { logger.warn("Scrape error: "+e.message); }
  return result;
}

// ── TRUSTEE LOOKUP ──
async function lookupTrustee(name) {
  if (!name) return { name:null, email:null, phone:null, source:"No trustee assigned", url:"https://www.justice.gov/ust/subchapter-v-trustees" };
  try {
    var res  = await fetchUrl("https://www.justice.gov/ust/subchapter-v-trustees", { timeout:10000 });
    var text = stripHtml(res.body);
    var last = name.split(" ").slice(-1)[0];
    var idx  = text.indexOf(last);
    if (idx > -1) {
      var snip   = text.slice(Math.max(0,idx-100), idx+300);
      var emails = extractEmails(snip);
      var phones = extractPhones(snip);
      if (emails.length || phones.length) {
        return { name:name, email:emails[0]||null, phone:phones[0]||null, source:"USTP Directory", url:"https://www.justice.gov/ust/subchapter-v-trustees", confidence:"HIGH" };
      }
    }
  } catch(e) { logger.warn("Trustee lookup error: "+e.message); }
  return { name:name, email:null, phone:null, source:"USTP Directory — manual lookup", url:"https://www.justice.gov/ust/subchapter-v-trustees", confidence:"MEDIUM" };
}

var STATE_BAR = {
  txsb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txnb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txeb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txwb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  nysb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nyeb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nynb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nywb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  flsb:"https://www.floridabar.org/directories/find-mbr/",flmb:"https://www.floridabar.org/directories/find-mbr/",flnb:"https://www.floridabar.org/directories/find-mbr/",
  caeb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",canb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",cacb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",casb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  ilnb:"https://www.iardc.org/lawyer-search",ilcb:"https://www.iardc.org/lawyer-search",njb:"https://www.njcourts.gov/attorneys/attySearch.html",
  deb:"https://www.dsba.org/find-a-lawyer/",vaeb:"https://www.vsb.org/site/members/search",vawb:"https://www.vsb.org/site/members/search",
  ganb:"https://www.gabar.org/membersearchapp/",gamb:"https://www.gabar.org/membersearchapp/",
  paeb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",pamb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
  ohsb:"https://www.supremecourt.ohio.gov/AttorneySearch/",ohnb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
  nceb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",ncmb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  mab:"https://www.massbbo.org/bbolookup.php",mdb:"https://www.courts.state.md.us/attyregistry",
  wawb:"https://www.mywsba.org/LawyerDirectory/",waeb:"https://www.mywsba.org/LawyerDirectory/",
  mnb:"https://lprb.mncourts.gov/attorney/Pages/AttorneySearch.aspx",orb:"https://www.osbar.org/public/ris/rissearch.asp",
  meb:"https://www.mainebar.org/page/FindanAttorney",ndb:"https://www.sband.org/page/find_a_lawyer_"
};

var STATE_MAP = {
  txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
  flsb:"Florida",flmb:"Florida",flnb:"Florida",caeb:"California",canb:"California",cacb:"California",casb:"California",
  ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",njb:"New Jersey",deb:"Delaware",dcb:"Washington DC",
  vaeb:"Virginia",vawb:"Virginia",ganb:"Georgia",gamb:"Georgia",gasb:"Georgia",
  paeb:"Pennsylvania",pamb:"Pennsylvania",pawb:"Pennsylvania",ohsb:"Ohio",ohnb:"Ohio",
  nceb:"North Carolina",ncmb:"North Carolina",ncwb:"North Carolina",mab:"Massachusetts",mdb:"Maryland",
  wawb:"Washington",waeb:"Washington",azb:"Arizona",cob:"Colorado",mnb:"Minnesota",orb:"Oregon",
  meb:"Maine",ndb:"North Dakota",ksb:"Kansas",kyeb:"Kentucky",kywb:"Kentucky",
  laeb:"Louisiana",lamb:"Louisiana",lawb:"Louisiana",mieb:"Michigan",miwb:"Michigan",
  msnb:"Mississippi",mssb:"Mississippi",moeb:"Missouri",mowb:"Missouri",mtb:"Montana",
  nebraskab:"Nebraska",nvb:"Nevada",nhb:"New Hampshire",nmb:"New Mexico",prb:"Puerto Rico",
  rib:"Rhode Island",scb:"South Carolina",sdb:"South Dakota",tneb:"Tennessee",tnmb:"Tennessee",tnwb:"Tennessee",
  utb:"Utah",vtb:"Vermont",wvnb:"West Virginia",wvsb:"West Virginia",wieb:"Wisconsin",wiwb:"Wisconsin",
  wyb:"Wyoming",areb:"Arkansas",arwb:"Arkansas",akb:"Alaska",arb:"Arizona",idb:"Idaho",
  ianb:"Iowa",iasb:"Iowa",innb:"Indiana",insb:"Indiana",okeb:"Oklahoma",oknb:"Oklahoma",okwb:"Oklahoma"
};

// ── MAIN ENRICHMENT ──
async function enrichCase(caseData) {
  // FIX: safely extract debtor name whether it's a string or object
  var debtor  = getDebtorName(caseData);
  var courtId = caseData.courtId || "";
  var state   = STATE_MAP[courtId] || "";

  if (!debtor) {
    return {
      company: null, aiData: null,
      trustee:   caseData.trustee   || null,
      attorneys: caseData.attorneys || [],
      principals:caseData.principals|| [],
      warnings:  ["No debtor name available for enrichment."]
    };
  }

  var result = { company:null, aiData:null, trustee:null, attorneys:[], principals:[], warnings:[] };

  // 1. AI search — pass full case context
  var aiData = await aiSearchEnrich(caseData, debtor);
  result.aiData = aiData;

  // 2. Google Places
  logger.info("Google Places: " + debtor);
  var places = await googlePlaces(debtor, state);

  // 3. Merge company data — AI + Google Places
  var website  = (aiData && aiData.website)    || (places && places.website)  || null;
  var website2 = (aiData && aiData.altWebsite) || null;
  result.company = {
    name:             debtor,
    tradeName:        (aiData && aiData.tradeName)        || null,
    address:          (aiData && aiData.address)          || (places && places.address) || null,
    phone:            (places && places.phone)            || (aiData && aiData.phone)   || null,
    website:          website,
    altWebsite:       website2,
    mapsUrl:          (places && places.mapsUrl)          || null,
    businessType:     (aiData && aiData.businessType)     || null,
    bankruptcyReason: (aiData && aiData.bankruptcyReason) || null,
    emails:           [],
    scrapedPhones:    [],
    sources:          (aiData && aiData.sources) || [],
    confidence:       (aiData && aiData.confidence) || "LOW"
  };

  // 4. Scrape websites
  if (website) {
    var w1 = await scrapeWebsite(website);
    result.company.emails        = w1.emails  || [];
    result.company.scrapedPhones = w1.phones  || [];
    result.company.contactPageUrl= w1.contactPageUrl;
  }
  if (website2) {
    var w2 = await scrapeWebsite(website2);
    (w2.emails||[]).forEach(function(e) { if (result.company.emails.indexOf(e)<0) result.company.emails.push(e); });
    (w2.phones||[]).forEach(function(p) { if (result.company.scrapedPhones.indexOf(p)<0) result.company.scrapedPhones.push(p); });
  }

  // 5. Build domains for email guessing
  var domains = [];
  [website, website2].forEach(function(w) {
    if (!w) return;
    try { var d=new URL(w).hostname.replace(/^www\./,""); if (domains.indexOf(d)<0) domains.push(d); } catch(e) {}
  });
  if (aiData && aiData.tradeName) {
    var derived = aiData.tradeName.toLowerCase().replace(/[^a-z0-9]/g,"");
    [derived+".com",derived+".net"].forEach(function(d) { if (domains.indexOf(d)<0) domains.push(d); });
  }

  function makePrincipal(name, title, email, phone, isPrimary, source, confidence) {
    var guesses = [];
    domains.forEach(function(d) { guessEmails(name,d).forEach(function(g) { guesses.push(g); }); });
    return { name:name, role:title||"Contact", title:title||null, email:email||null, phone:phone||null,
             emailGuesses:guesses, domains:domains, isPrimary:isPrimary||false,
             source:source||"Public web search", confidence:confidence||"MEDIUM", note:"Verify before outreach" };
  }

  // 6. Principals — owner first, then petition signer, then other contacts
  result.principals = [];
  if (aiData && aiData.ownerName) {
    result.principals.push(makePrincipal(aiData.ownerName, aiData.ownerTitle||"Owner / Operator", aiData.ownerEmail, aiData.ownerPhone||result.company.phone, true, "Public web search", aiData.confidence));
  }
  if (aiData && aiData.petitionSigner && aiData.petitionSigner !== (aiData.ownerName||"")) {
    result.principals.push(makePrincipal(aiData.petitionSigner, aiData.petitionSignerTitle||"Authorized Representative", null, null, false, "Bankruptcy petition (public record)", "HIGH"));
  }
  if (aiData && aiData.otherContacts) {
    aiData.otherContacts.forEach(function(oc) {
      if (oc && oc.name) result.principals.push(makePrincipal(oc.name, oc.role, oc.email, oc.phone, false, "Public web search", "MEDIUM"));
    });
  }
  if (!result.principals.length) result.warnings.push("No owner or principal found in public search — manual review needed.");

  // 7. Trustee — from CourtListener first, then USTP lookup
  var trusteeName = (caseData.trustee && caseData.trustee.name) ? caseData.trustee.name : null;
  var td = await lookupTrustee(trusteeName);
  result.trustee = Object.assign({}, caseData.trustee||{}, td);

  // 8. Attorneys — add state bar links
  result.attorneys = (caseData.attorneys||[]).map(function(a) {
    return Object.assign({}, a, {
      barUrl: STATE_BAR[courtId]||"https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-locator/",
      note:   "Search state bar directory for verified email and phone"
    });
  });

  return result;
}

module.exports = { enrichCase };
