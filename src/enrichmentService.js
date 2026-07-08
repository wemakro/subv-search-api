"use strict";
const https  = require("https");
const http   = require("http");
const logger = require("./logger");

const GOOGLE_KEY     = process.env.GOOGLE_API_KEY   || "";
const GEMINI_KEY     = process.env.GEMINI_API_KEY   || "";
const OPENAI_KEY     = process.env.OPENAI_API_KEY   || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_MODEL   = process.env.GEMINI_MODEL     || "gemini-2.5-flash";

// ── FETCH ──────────────────────────────────────────────────────────────────
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

function getDebtorName(caseData) {
  var name = "";
  if (caseData.debtor && typeof caseData.debtor === "object") {
    name = caseData.debtor.name || "";
  } else if (typeof caseData.debtor === "string") {
    name = caseData.debtor;
  }
  return (name || caseData.debtorName || caseData.caseName || caseData.name || "").trim();
}

// ── HELPERS ────────────────────────────────────────────────────────────────
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
  if (!name || !domain || domain.length > 40) return [];
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

// ── FIX: Brace-counting JSON parser ───────────────────────────────────────
// Replaces greedy regex that overshot past Gemini citation text containing {}
function parseJsonFromText(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch(e) {}

  var clean = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try { return JSON.parse(clean); } catch(e) {}

  var start = clean.indexOf("{");
  if (start === -1) return null;

  var depth = 0;
  for (var i = start; i < clean.length; i++) {
    if (clean[i] === "{") {
      depth++;
    } else if (clean[i] === "}") {
      depth--;
      if (depth === 0) {
        var candidate = clean.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch(e) { return null; }
      }
    }
  }
  return null;
}

// ── GEMINI PROMPT ──────────────────────────────────────────────────────────
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
    + "3. Website URL (primary website only — one clean URL)\n"
    + "4. The ACTUAL OWNER, operator, managing member, or president — not the attorney\n"
    + "5. The petition signer / authorized representative from court documents\n"
    + "6. Other key contacts who are employees or owners only\n"
    + "7. What the business does\n"
    + "8. Why they filed for bankruptcy\n"
    + "9. Include source URLs for every important claim\n\n"
    + "CRITICAL: Never include attorneys, law firms, trustees, or US Trustee in otherContacts.\n\n"
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

// ── CLAUDE REVIEW PROMPT (Layer 2) ─────────────────────────────────────────
function buildClaudeReviewPrompt(caseData, debtorName, geminiResult) {
  var g = geminiResult || {};
  var tradeName = g.tradeName || debtorName;
  var daysOld = caseData.dateFiled
    ? Math.floor((Date.now() - new Date(caseData.dateFiled)) / 86400000)
    : null;

  return "You are the second enrichment layer for a bankruptcy CRM. Gemini already researched this case.\n\n"
    + "Case: " + debtorName + " | Court: " + (caseData.courtId||"") + "\n"
    + "Filed: " + (caseData.dateFiled||"") + (daysOld ? " (" + daysOld + " days ago)" : "") + "\n\n"
    + "GEMINI FOUND:\n" + JSON.stringify(g, null, 2) + "\n\n"
    + "Your job: REVIEW and FILL GAPS only. Do not repeat what Gemini confirmed.\n\n"

    + "TASK 1 — VALIDATE THE OWNER:\n"
    + "Gemini returned ownerName: '" + (g.ownerName||"null") + "'\n"
    + "REJECT if: contains Esq., Attorney, Counsel, Law Firm, Trustee, or matches any attorney in the case.\n"
    + "If rejected or null: search '" + debtorName + " owner' or '" + tradeName + " founder'\n"
    + "Set ownerValidated:true only if confirmed as actual business operator.\n\n"

    + "TASK 2 — FIND ALL EMAILS (return as array):\n"
    + "- info@ from the website domain (always include, confidence: guessed)\n"
    + "- Any email found explicitly on website (confidence: confirmed)\n"
    + "- Pattern-derived: first.last@domain, firstname@domain (confidence: guessed)\n\n"

    + "TASK 3 — FIND ALL PHONES (return as array):\n"
    + "- Main business line from Google Maps or website\n"
    + "- Owner direct/mobile if findable\n\n"

    + "TASK 4 — DIGITAL FOOTPRINT for trade name '" + tradeName + "':\n"
    + "- Contact page URL (search '" + tradeName + " contact us')\n"
    + "- Instagram profile URL\n"
    + "- Facebook page URL\n"
    + "- LinkedIn company URL\n"
    + "- Owner's LinkedIn profile URL\n"
    + "- Google Maps listing URL\n"
    + "- Yelp listing URL\n\n"

    + "TASK 5 — BUSINESS INTEL:\n"
    + "- One sentence: what this business does (specific)\n"
    + "- One sentence: why they filed bankruptcy\n"
    + "- Is the business still operating? (true/false)\n"
    + "- Any red flags (closed, shell company, uncontactable, etc.)\n\n"

    + "TASK 6 — BEST OUTREACH CHANNEL:\n"
    + "Pick one: email | phone | instagram_dm | facebook | contact_form | linkedin | manual\n\n"

    + "Return ONLY this JSON:\n"
    + "{\n"
    + '  "ownerName": null,\n'
    + '  "ownerTitle": null,\n'
    + '  "ownerEmails": [],\n'
    + '  "ownerPhones": [],\n'
    + '  "ownerLinkedIn": null,\n'
    + '  "ownerValidated": false,\n'
    + '  "ownerValidationNote": null,\n'
    + '  "tradeName": null,\n'
    + '  "website": null,\n'
    + '  "contactFormUrl": null,\n'
    + '  "instagram": null,\n'
    + '  "facebook": null,\n'
    + '  "linkedInCompany": null,\n'
    + '  "googleMapsUrl": null,\n'
    + '  "yelpUrl": null,\n'
    + '  "businessDescription": null,\n'
    + '  "bankruptcyReason": null,\n'
    + '  "stillOperating": true,\n'
    + '  "bestOutreachChannel": "manual",\n'
    + '  "redFlags": [],\n'
    + '  "confidence": "LOW"\n'
    + "}\n\n"
    + "ownerEmails format: [{\"email\":\"info@domain.com\",\"confidence\":\"guessed\",\"type\":\"office\"}]\n"
    + "ownerPhones format: [{\"phone\":\"+17275551234\",\"label\":\"Main business line\",\"type\":\"office\"}]\n"
    + "confidence values: 'confirmed' (found explicitly) | 'guessed' (derived)";
}

// ── MERGE Gemini + Claude results ──────────────────────────────────────────
function mergeEnrichmentResults(gemini, claude) {
  if (!gemini && !claude) return null;
  if (!claude)  return gemini;
  if (!gemini)  return claude;

  var g = gemini, c = claude;

  // Owner: Claude validates and overrides Gemini.
  // If Claude explicitly set ownerValidated:false and cleared the name, trust that.
  var ownerName = c.ownerName || g.ownerName || null;
  if (c.ownerValidated === false && c.ownerName === null && g.ownerName) {
    ownerName = null; // Claude rejected Gemini's finding
  }

  return {
    // Company identity
    companyLegalName:    g.companyLegalName || null,
    tradeName:           c.tradeName       || g.tradeName      || null,
    address:             g.address         || null,
    phone:               g.phone           || c.ownerPhones && c.ownerPhones[0] && c.ownerPhones[0].phone || null,
    website:             g.website         || c.website        || null,
    altWebsite:          g.altWebsite      || null,
    businessType:        c.businessDescription || g.businessType || null,
    bankruptcyReason:    c.bankruptcyReason || g.bankruptcyReason || null,
    stillOperating:      c.stillOperating !== undefined ? c.stillOperating : true,

    // Owner — Claude layer takes priority
    ownerName:           ownerName,
    ownerTitle:          c.ownerTitle      || g.ownerTitle     || null,
    ownerEmail:          (c.ownerEmails&&c.ownerEmails[0]) ? c.ownerEmails[0].email : g.ownerEmail || null,
    ownerEmails:         c.ownerEmails     || [],
    ownerPhone:          (c.ownerPhones&&c.ownerPhones[0]) ? c.ownerPhones[0].phone : g.ownerPhone || null,
    ownerPhones:         c.ownerPhones     || [],
    ownerLinkedIn:       c.ownerLinkedIn   || null,
    ownerValidated:      c.ownerValidated  || false,
    ownerValidationNote: c.ownerValidationNote || null,

    // Petition data from Gemini
    petitionSigner:      g.petitionSigner      || null,
    petitionSignerTitle: g.petitionSignerTitle || null,
    otherContacts:       g.otherContacts       || [],

    // Digital footprint — Claude specialty
    contactFormUrl:  c.contactFormUrl  || null,
    instagram:       c.instagram       || null,
    facebook:        c.facebook        || null,
    linkedInCompany: c.linkedInCompany || null,
    googleMapsUrl:   c.googleMapsUrl   || null,
    yelpUrl:         c.yelpUrl         || null,

    // Outreach intelligence
    bestOutreachChannel: c.bestOutreachChannel || "manual",
    redFlags:            c.redFlags            || [],

    // Meta
    sources:    (g.sources||[]).concat(c.sources||[]),
    confidence: (ownerName && c.ownerValidated && c.ownerEmail) ? "HIGH"
              : (ownerName && c.ownerValidated)                  ? "MEDIUM"
              : (g.confidence || "LOW"),
    warnings: [...(g.warnings||[]), ...(c.warnings||[])]
  };
}

// ── GEMINI ─────────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  try {
    var res = await postJson(
      "generativelanguage.googleapis.com",
      "/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + GEMINI_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      }
    );
    if (res.status < 200 || res.status >= 300) {
      logger.warn("Gemini HTTP " + res.status + ": " + res.body.slice(0,500));
      return null;
    }
    var parsed = JSON.parse(res.body);
    var parts  = [];
    var cand   = (parsed.candidates||[])[0];
    if (cand && cand.content && cand.content.parts) {
      cand.content.parts.forEach(function(p) { if (p.text) parts.push(p.text); });
    }
    var text = parts.join("");
    if (!text) { logger.warn("Gemini returned no text"); return null; }
    logger.debug("Gemini raw preview: " + text.slice(0,300));
    return text;
  } catch(e) {
    logger.warn("Gemini error: " + e.message);
    return null;
  }
}

// ── CLAUDE (Layer 2 review) ────────────────────────────────────────────────
async function callClaude(prompt) {
  if (!ANTHROPIC_KEY) return null;
  try {
    var res = await postJson(
      "api.anthropic.com",
      "/v1/messages",
      {
        model:      "claude-sonnet-4-6",
        max_tokens: 1000,
        messages:   [{ role: "user", content: prompt }],
        tools:      [{ type: "web_search_20250305", name: "web_search" }]
      },
      {
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      }
    );
    if (res.status < 200 || res.status >= 300) {
      logger.warn("Claude HTTP " + res.status + ": " + res.body.slice(0,300));
      return null;
    }
    var parsed = JSON.parse(res.body);
    var text = (parsed.content||[])
      .filter(function(b) { return b.type === "text"; })
      .map(function(b) { return b.text; })
      .join("");
    if (!text) { logger.warn("Claude review returned no text"); return null; }
    logger.debug("Claude review preview: " + text.slice(0,300));
    return text;
  } catch(e) {
    logger.warn("Claude error: " + e.message);
    return null;
  }
}

// ── OPENAI FALLBACK ────────────────────────────────────────────────────────
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
      logger.warn("OpenAI HTTP " + res.status);
      return null;
    }
    var parsed = JSON.parse(res.body);
    return ((parsed.choices||[])[0]||{}).message ? parsed.choices[0].message.content : null;
  } catch(e) {
    logger.warn("OpenAI error: " + e.message);
    return null;
  }
}

// ── TWO-LAYER AI ENRICHMENT ────────────────────────────────────────────────
// Layer 1: Gemini — broad web research (finds owner, website, DBA)
// Layer 2: Claude — validates owner, finds all emails/phones, social links
async function aiSearchEnrich(caseData, debtorName) {
  if (!GEMINI_KEY && !OPENAI_KEY && !ANTHROPIC_KEY) {
    logger.warn("No AI key configured");
    return null;
  }

  // Layer 1: Gemini broad research
  var geminiData = null;
  if (GEMINI_KEY) {
    logger.info("Gemini enrichment (layer 1): " + debtorName);
    var geminiText = await callGemini(buildGeminiPrompt(caseData, debtorName));
    geminiData = parseJsonFromText(geminiText);
    if (!geminiData) logger.warn("Gemini parse failed for: " + debtorName);
  }

  // OpenAI fallback if Gemini completely fails
  if (!geminiData && OPENAI_KEY) {
    logger.info("OpenAI fallback: " + debtorName);
    var openaiText = await callOpenAI(buildGeminiPrompt(caseData, debtorName));
    geminiData = parseJsonFromText(openaiText);
  }

  // Layer 2: Claude review and gap-fill
  var claudeData = null;
  if (ANTHROPIC_KEY) {
    logger.info("Claude review (layer 2): " + debtorName);
    var claudeText = await callClaude(buildClaudeReviewPrompt(caseData, debtorName, geminiData));
    claudeData = parseJsonFromText(claudeText);
    if (!claudeData) logger.warn("Claude review parse failed for: " + debtorName);
  }

  // Merge both layers
  var result = mergeEnrichmentResults(geminiData, claudeData);
  if (!result) logger.warn("Both AI layers returned nothing for: " + debtorName);
  return result;
}

// ── GOOGLE PLACES ──────────────────────────────────────────────────────────
async function googlePlaces(name, state) {
  if (!GOOGLE_KEY) return null;
  try {
    var q   = encodeURIComponent(name + (state ? " " + state : ""));
    var res = await fetchUrl("https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input="+q+"&inputtype=textquery&fields=place_id,name,formatted_address,formatted_phone_number,website&key="+GOOGLE_KEY);
    var d   = JSON.parse(res.body);
    if (d.status !== "OK" || !d.candidates || !d.candidates.length) return null;
    var pl  = d.candidates[0];
    if (pl.place_id) {
      var r2 = await fetchUrl("https://maps.googleapis.com/maps/api/place/details/json?place_id="+pl.place_id+"&fields=name,formatted_address,formatted_phone_number,website,url&key="+GOOGLE_KEY);
      var d2 = JSON.parse(r2.body);
      if (d2.status === "OK" && d2.result) {
        return { address:d2.result.formatted_address||"", phone:d2.result.formatted_phone_number||"", website:d2.result.website||"", mapsUrl:d2.result.url||"" };
      }
    }
    return { address:pl.formatted_address||"", phone:pl.formatted_phone_number||"", website:pl.website||"", mapsUrl:"" };
  } catch(e) { logger.warn("Google Places error: "+e.message); return null; }
}

// ── WEBSITE SCRAPER (with social links + info@ + contact form) ─────────────
async function scrapeWebsite(url) {
  if (!url) return { emails:[], phones:[], ownerHints:[], socialLinks:{}, contactFormUrl:null };
  var result = { emails:[], phones:[], contactPageUrl:null, ownerHints:[], socialLinks:{}, contactFormUrl:null };

  // Always derive info@ from domain as a fallback email
  try {
    var domain = new URL(url.startsWith("http") ? url : "https://"+url).hostname.replace(/^www\./,"");
    if (domain && domain.length <= 40) result.emails.push("info@"+domain);
  } catch(e) {}

  try {
    var home = await fetchUrl(url, { timeout: 8000 });
    var homeText = stripHtml(home.body);

    // Emails and phones from homepage
    extractEmails(home.body).forEach(function(e) { if (result.emails.indexOf(e)<0) result.emails.push(e); });
    result.phones = extractPhones(homeText);

    // Social media links
    var socialPatterns = {
      instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{2,30})/i,
      facebook:  /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?!sharer|share|dialog)([a-zA-Z0-9._\-]{2,50})/i,
      twitter:   /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9._]{2,30})/i,
      linkedin:  /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:company|in)\/([a-zA-Z0-9._\-]{2,50})/i
    };
    Object.keys(socialPatterns).forEach(function(platform) {
      var match = home.body.match(socialPatterns[platform]);
      if (match && match[0]) {
        var link = match[0];
        if (!link.startsWith("http")) link = "https://" + link.replace(/^\/\//,"");
        result.socialLinks[platform] = link;
      }
    });

    // Contact page
    var cfMatch = home.body.match(/href=["']([^"']*(?:contact|reach-us|get-in-touch)[^"']*)/i);
    if (cfMatch) {
      var cfUrl = cfMatch[1];
      if (cfUrl.startsWith("/")) { try { var b=new URL(url); cfUrl=b.origin+cfUrl; } catch(e) {} }
      if (!cfUrl.startsWith("http")) cfUrl = url+"/"+cfUrl;
      result.contactFormUrl = cfUrl;
      result.contactPageUrl = cfUrl;
    } else {
      try {
        var tryContact = new URL("/contact", url.startsWith("http")?url:"https://"+url).href;
        var cp = await fetchUrl(tryContact, { timeout: 5000 });
        if (cp.status === 200) {
          result.contactFormUrl = tryContact;
          result.contactPageUrl = tryContact;
          extractEmails(cp.body).forEach(function(e) { if (result.emails.indexOf(e)<0) result.emails.push(e); });
          extractPhones(stripHtml(cp.body)).forEach(function(p) { if (result.phones.indexOf(p)<0) result.phones.push(p); });
        }
      } catch(e) {}
    }

    // Scrape contact page if found via href
    if (result.contactPageUrl && result.contactPageUrl !== url) {
      try {
        var cpPage = await fetchUrl(result.contactPageUrl, { timeout: 8000 });
        extractEmails(cpPage.body).forEach(function(e) { if (result.emails.indexOf(e)<0) result.emails.push(e); });
        extractPhones(stripHtml(cpPage.body)).forEach(function(p) { if (result.phones.indexOf(p)<0) result.phones.push(p); });
      } catch(e) {}
    }

    // About page for owner hints
    var ownerPatterns = [
      /(?:owner|founder|director|president|ceo|managing member)[^<]{0,60}/gi,
      /(?:meet\s+(?:our\s+)?(?:owner|team|founder))[^<]{0,120}/gi
    ];
    ownerPatterns.forEach(function(p) {
      var m = home.body.match(p);
      if (m) result.ownerHints = result.ownerHints.concat(m.slice(0,3));
    });

    try {
      var aboutUrl = new URL("/about", url.startsWith("http")?url:"https://"+url).href;
      var ap = await fetchUrl(aboutUrl, { timeout: 6000 });
      if (ap.status === 200) {
        extractEmails(ap.body).forEach(function(e) { if (result.emails.indexOf(e)<0) result.emails.push(e); });
        ownerPatterns.forEach(function(p) {
          var m = ap.body.match(p);
          if (m) result.ownerHints = result.ownerHints.concat(m.slice(0,3));
        });
      }
    } catch(e) {}

    result.emails = result.emails.slice(0,8);
    result.phones = result.phones.slice(0,5);

  } catch(e) { logger.warn("Scrape error: "+e.message); }
  return result;
}

// ── ATTORNEY / TRUSTEE DETECTION ───────────────────────────────────────────
var NAME_SUFFIX_PATTERN    = /,?\s*(esq\.?|j\.d\.?|attorney at law|p\.c\.|pllc|llp)$/i;
var ATTORNEY_TITLE_PATTERN = /\b(attorney|counsel|esquire|esq|solicitor|lawyer|legal counsel|debtor.s attorney|attorney for debtor|attorney at law)\b/i;
var LAW_FIRM_PATTERN       = /\b(law|llp|pllc|p\.c\.|attorneys|legal|counsel|esq|firm|solicitor)\b/i;
var TRUSTEE_NAME_PATTERN   = /\b(trustee|us trustee|u\.s\. trustee|united states trustee)\b/i;

function isAttorneyOrTrustee(name, title, org, knownAttorneyNames) {
  var s = [(name||""), (title||""), (org||"")].join(" ");
  if (TRUSTEE_NAME_PATTERN.test(s))    return true;
  if (NAME_SUFFIX_PATTERN.test(name))  return true;
  if (ATTORNEY_TITLE_PATTERN.test(s))  return true;
  if (LAW_FIRM_PATTERN.test(org||""))  return true;
  var nameClean = (name||"").toLowerCase().replace(NAME_SUFFIX_PATTERN,"").trim();
  return (knownAttorneyNames||[]).some(function(k) {
    return k.length>3 && (k.includes(nameClean)||nameClean.includes(k));
  });
}

// ── TRUSTEE LOOKUP — database-backed ───────────────────────────────────────
async function lookupTrusteeFromDirectory(trusteeName, courtId) {
  const { query: dbQuery } = require("./db/connection");
  if (trusteeName) {
    var nl = trusteeName.toLowerCase().trim();
    if (nl==="us trustee"||nl==="u.s. trustee"||nl==="united states trustee") trusteeName=null;
  }
  try {
    if (trusteeName) {
      var lastName = trusteeName.split(" ").slice(-1)[0].toLowerCase();
      if (lastName.length>2) {
        var nr = await dbQuery("SELECT * FROM trustees WHERE active=TRUE AND LOWER(full_name) LIKE $1 ORDER BY full_name LIMIT 1", ["%"+lastName+"%"]);
        if (nr.rows.length>0) {
          var t=nr.rows[0];
          return { name:t.full_name, email:t.email||null, phone:t.phone||null, district:t.district_code, source:"USTP Sub-V Trustee Directory (justice.gov)", url:t.source_url||"https://www.justice.gov/ust/list-chapter-11-subchapter-v-case-case-trustees", confidence:"HIGH" };
        }
      }
    }
    if (courtId) {
      var dr = await dbQuery("SELECT * FROM trustees WHERE active=TRUE AND district_code=$1 ORDER BY full_name", [courtId.toLowerCase()]);
      if (dr.rows.length>0) {
        var list=dr.rows, first=list[0];
        return { name:trusteeName||"Not yet assigned — see district directory", email:first.email||null, phone:first.phone||null, district:courtId, allTrustees:list.map(function(t){return{name:t.full_name,email:t.email,phone:t.phone};}), source:"USTP Sub-V Trustee Directory (justice.gov)", url:"https://www.justice.gov/ust/list-chapter-11-subchapter-v-case-case-trustees", confidence:trusteeName?"MEDIUM":"LOW" };
      }
    }
  } catch(e) { logger.warn("Trustee DB lookup failed: "+e.message); }
  return { name:trusteeName||null, email:null, phone:null, source:"USTP Directory — trustee not yet matched", url:"https://www.justice.gov/ust/list-chapter-11-subchapter-v-case-case-trustees", confidence:"LOW" };
}

var STATE_BAR = {
  txsb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txnb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txeb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",txwb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  nysb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nyeb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nynb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",nywb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  flsb:"https://www.floridabar.org/directories/find-mbr/",flmb:"https://www.floridabar.org/directories/find-mbr/",flnb:"https://www.floridabar.org/directories/find-mbr/",
  caeb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",canb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",cacb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",casb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  ilnb:"https://www.iardc.org/lawyer-search",ilcb:"https://www.iardc.org/lawyer-search",njb:"https://www.njcourts.gov/attorneys/attySearch.html",deb:"https://www.dsba.org/find-a-lawyer/",
  vaeb:"https://www.vsb.org/site/members/search",vawb:"https://www.vsb.org/site/members/search",ganb:"https://www.gabar.org/membersearchapp/",gamb:"https://www.gabar.org/membersearchapp/",
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

// ── MAIN ENRICHMENT ────────────────────────────────────────────────────────
async function enrichCase(caseData) {
  var debtor  = getDebtorName(caseData);
  var courtId = caseData.courtId || caseData.court_id || "";
  var state   = STATE_MAP[courtId] || "";

  if (!debtor) {
    return { company:null, aiData:null, trustee:caseData.trustee||null, attorneys:caseData.attorneys||[], principals:caseData.principals||[], warnings:["No debtor name available for enrichment."] };
  }

  var result = { company:null, aiData:null, trustee:null, attorneys:[], principals:[], warnings:[] };

  var knownAttorneyNames = (caseData.attorneys||[]).map(function(a) {
    return (a.name||"").toLowerCase().replace(NAME_SUFFIX_PATTERN,"").trim();
  }).filter(function(n) { return n.length>3; });

  // Layer 1 + 2: AI enrichment
  var aiData = await aiSearchEnrich(caseData, debtor);
  result.aiData = aiData;

  // FIX: Google Places searches trade name first — far better Maps coverage
  var tradeName = (aiData && aiData.tradeName) || null;
  var placesSearchName = tradeName || debtor;
  logger.info("Google Places: " + placesSearchName + (tradeName ? " (trade name)" : ""));
  var places = await googlePlaces(placesSearchName, state);
  if (!places && tradeName) {
    logger.info("Google Places retry with legal name: " + debtor);
    places = await googlePlaces(debtor, state);
  }

  // Merge company data
  var website  = (aiData && aiData.website)    || (places && places.website)  || null;
  var website2 = (aiData && aiData.altWebsite) || null;

  result.company = {
    name:             debtor,
    tradeName:        tradeName,
    address:          (aiData && aiData.address) || (places && places.address) || null,
    phone:            (places && places.phone)   || (aiData && aiData.phone)   || null,
    website:          website,
    altWebsite:       website2,
    mapsUrl:          (aiData && aiData.googleMapsUrl) || (places && places.mapsUrl) || null,
    businessType:     (aiData && (aiData.businessType||aiData.businessDescription)) || null,
    bankruptcyReason: (aiData && aiData.bankruptcyReason) || null,
    stillOperating:   (aiData && aiData.stillOperating !== undefined) ? aiData.stillOperating : true,
    emails:           [],
    scrapedPhones:    [],
    ownerHints:       [],
    socialLinks:      {},
    contactFormUrl:   (aiData && aiData.contactFormUrl) || null,
    bestOutreachChannel: (aiData && aiData.bestOutreachChannel) || "manual",
    redFlags:         (aiData && aiData.redFlags) || [],
    sources:          (aiData && aiData.sources) || [],
    confidence:       (aiData && aiData.confidence) || "LOW"
  };

  // Scrape trade name website first (better contact info)
  var tradeWebsite = (places && places.website) || null;
  if (tradeWebsite && tradeWebsite !== website) {
    var wt = await scrapeWebsite(tradeWebsite);
    result.company.emails        = wt.emails        || [];
    result.company.scrapedPhones = wt.phones        || [];
    result.company.contactPageUrl= wt.contactPageUrl;
    result.company.ownerHints    = wt.ownerHints    || [];
    result.company.socialLinks   = wt.socialLinks   || {};
    if (!result.company.contactFormUrl && wt.contactFormUrl) result.company.contactFormUrl = wt.contactFormUrl;
  }
  if (website) {
    var w1 = await scrapeWebsite(website);
    w1.emails.forEach(function(e) { if (result.company.emails.indexOf(e)<0) result.company.emails.push(e); });
    w1.phones.forEach(function(p) { if (result.company.scrapedPhones.indexOf(p)<0) result.company.scrapedPhones.push(p); });
    w1.ownerHints.forEach(function(h) { if (result.company.ownerHints.indexOf(h)<0) result.company.ownerHints.push(h); });
    if (!result.company.contactFormUrl && w1.contactFormUrl) result.company.contactFormUrl = w1.contactFormUrl;
    if (!result.company.contactPageUrl && w1.contactPageUrl) result.company.contactPageUrl = w1.contactPageUrl;
    Object.keys(w1.socialLinks||{}).forEach(function(pl) { if (!result.company.socialLinks[pl]) result.company.socialLinks[pl]=w1.socialLinks[pl]; });
  }
  if (website2) {
    var w2 = await scrapeWebsite(website2);
    w2.emails.forEach(function(e) { if (result.company.emails.indexOf(e)<0) result.company.emails.push(e); });
    w2.phones.forEach(function(p) { if (result.company.scrapedPhones.indexOf(p)<0) result.company.scrapedPhones.push(p); });
    Object.keys(w2.socialLinks||{}).forEach(function(pl) { if (!result.company.socialLinks[pl]) result.company.socialLinks[pl]=w2.socialLinks[pl]; });
  }

  // Merge social links from Claude layer into company
  if (aiData) {
    if (aiData.instagram && !result.company.socialLinks.instagram) result.company.socialLinks.instagram = aiData.instagram;
    if (aiData.facebook  && !result.company.socialLinks.facebook)  result.company.socialLinks.facebook  = aiData.facebook;
    if (aiData.linkedInCompany && !result.company.socialLinks.linkedin) result.company.socialLinks.linkedin = aiData.linkedInCompany;
    if (aiData.contactFormUrl && !result.company.contactFormUrl) result.company.contactFormUrl = aiData.contactFormUrl;
  }

  // Build domains for email guessing
  var domains = [];
  [website, website2, tradeWebsite].forEach(function(w) {
    if (!w) return;
    try { var d=new URL(w.startsWith("http")?w:"https://"+w).hostname.replace(/^www\./,""); if(d&&d.length<=40&&domains.indexOf(d)<0)domains.push(d); } catch(e){}
  });
  result.company.emails.forEach(function(e) {
    var parts=e.split("@"); if(parts.length===2&&parts[1].length<=40&&domains.indexOf(parts[1])<0)domains.push(parts[1]);
  });

  function makePrincipal(name, title, email, phone, isPrimary, source, confidence) {
    var guesses=[];
    domains.forEach(function(d) { guessEmails(name,d).forEach(function(g){guesses.push(g);}); });
    return { name:name, role:title||"Contact", title:title||null, email:email||null, phone:phone||null, emailGuesses:guesses, domains:domains, isPrimary:isPrimary||false, source:source||"Public web search", confidence:confidence||"MEDIUM", note:"Verify before outreach" };
  }

  // Build principals — filter attorneys and trustees
  result.principals = [];
  if (aiData && aiData.ownerName) {
    if (!isAttorneyOrTrustee(aiData.ownerName, aiData.ownerTitle, null, knownAttorneyNames)) {
      var ownerPhone = aiData.ownerPhone || (aiData.ownerPhones&&aiData.ownerPhones[0]&&aiData.ownerPhones[0].phone) || result.company.phone;
      var ownerEmail = aiData.ownerEmail || (aiData.ownerEmails&&aiData.ownerEmails[0]&&aiData.ownerEmails[0].email);
      result.principals.push(makePrincipal(aiData.ownerName, aiData.ownerTitle||"Owner / Operator", ownerEmail, ownerPhone, true, "Public web search", aiData.confidence));
    }
  }
  if (aiData && aiData.petitionSigner && aiData.petitionSigner !== (aiData.ownerName||"")) {
    if (!isAttorneyOrTrustee(aiData.petitionSigner, aiData.petitionSignerTitle, null, knownAttorneyNames)) {
      result.principals.push(makePrincipal(aiData.petitionSigner, aiData.petitionSignerTitle||"Authorized Representative", null, null, false, "Bankruptcy petition (public record)", "HIGH"));
    }
  }
  if (aiData && aiData.otherContacts) {
    aiData.otherContacts.forEach(function(oc) {
      if (!oc||!oc.name) return;
      if (isAttorneyOrTrustee(oc.name, oc.title||oc.role, oc.organization||oc.firm, knownAttorneyNames)) return;
      result.principals.push(makePrincipal(oc.name, oc.role, oc.email, oc.phone, false, "Public web search", "MEDIUM"));
    });
  }
  if (!result.principals.length) result.warnings.push("No owner or principal found in public search — manual review needed.");

  // Trustee lookup
  var trusteeName = (caseData.trustee && caseData.trustee.name) ? caseData.trustee.name : null;
  var td = await lookupTrusteeFromDirectory(trusteeName, courtId);
  result.trustee = Object.assign({}, caseData.trustee||{}, td);

  // Attorneys with state bar links
  result.attorneys = (caseData.attorneys||[]).map(function(a) {
    return Object.assign({}, a, { barUrl:STATE_BAR[courtId]||"https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-locator/", note:"Search state bar directory for verified email and phone" });
  });

  return result;
}

module.exports = { enrichCase };
