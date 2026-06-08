const https  = require("https");
const http   = require("http");
const logger = require("./logger");

const GOOGLE_KEY  = process.env.GOOGLE_API_KEY   || "";
const GEMINI_KEY  = process.env.GEMINI_API_KEY   || "";
const OPENAI_KEY  = process.env.OPENAI_API_KEY   || "";

// Log which AI services are available on startup
setTimeout(function() {
  var logger = require("./logger");
  logger.info("Enrichment services: Gemini=" + (GEMINI_KEY?"YES":"NO") + " OpenAI=" + (OPENAI_KEY?"YES":"NO") + " Google Places=" + (GOOGLE_KEY?"YES":"NO"));
}, 100);

// ── HTTP FETCH ──
function fetchUrl(url, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var lib = url.startsWith("https") ? https : http;
    var req = lib.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SubVCRM/1.0)", "Accept": "text/html,application/json" }
    }, function(resp) {
      if ([301,302,303,307,308].indexOf(resp.statusCode) > -1 && resp.headers.location) {
        return fetchUrl(resp.headers.location, options).then(resolve).catch(reject);
      }
      var data = "";
      resp.setEncoding("utf8");
      resp.on("data", function(c) { data += c; });
      resp.on("end",  function()  { resolve({ status: resp.statusCode, body: data }); });
    });
    req.setTimeout(options.timeout || 12000, function() { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

function fetchJson(url, options) {
  return fetchUrl(url, options).then(function(r) { return JSON.parse(r.body); });
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"")
             .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

function extractEmails(text) {
  var matches = text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || [];
  var bad = /noreply|no-reply|donotreply|example|\.png|\.jpg|privacy@|abuse@|sentry|wix|wordpress|squarespace/i;
  var seen = {};
  return matches.filter(function(e) { if (bad.test(e)||seen[e]) return false; seen[e]=true; return true; }).slice(0,5);
}

function extractPhones(text) {
  var matches = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g) || [];
  var seen = {};
  return matches.map(function(p){return p.trim();}).filter(function(p){ if(seen[p]) return false; seen[p]=true; return true; }).slice(0,5);
}

function guessEmails(personName, domain) {
  if (!personName || !domain) return [];
  var parts = personName.toLowerCase().replace(/[^a-z\s]/g,"").trim().split(/\s+/);
  var first = parts[0]||"", last = parts[parts.length-1]||"";
  if (!first||!last||first===last) return [];
  return [
    {email:first+"."+last+"@"+domain, pattern:"first.last"},
    {email:first+"@"+domain,          pattern:"first"},
    {email:first[0]+last+"@"+domain,  pattern:"flast"},
    {email:first+last[0]+"@"+domain,  pattern:"firstl"},
    {email:last+"@"+domain,           pattern:"last"}
  ];
}

// ── GEMINI AI SEARCH (primary) ──
async function geminiSearch(prompt) {
  if (!GEMINI_KEY) return null;
  try {
    var body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: "text/plain" }
    });
    var result = await new Promise(function(resolve, reject) {
      var data = "";
      var req  = https.request({
        hostname: "generativelanguage.googleapis.com",
        path:     "/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY,
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, function(resp) {
        resp.setEncoding("utf8");
        resp.on("data", function(c) { data += c; });
        resp.on("end",  function()  { resolve(data); });
      });
      req.setTimeout(45000, function() { req.destroy(); reject(new Error("Gemini timeout")); });
      req.on("error", reject);
      req.write(body); req.end();
    });
    var parsed = JSON.parse(result);
    return (parsed.candidates||[])[0]?.content?.parts?.map(function(p){return p.text||"";}).join("") || null;
  } catch(e) {
    logger.warn("Gemini search failed: " + e.message);
    return null;
  }
}

// ── OPENAI SEARCH (fallback) ──
async function openaiSearch(prompt) {
  if (!OPENAI_KEY) return null;
  try {
    var body = JSON.stringify({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      messages: [{ role: "user", content: prompt }]
    });
    var result = await new Promise(function(resolve, reject) {
      var data = "";
      var req  = https.request({
        hostname: "api.openai.com",
        path:     "/v1/responses",
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY, "Content-Length": Buffer.byteLength(body) }
      }, function(resp) {
        resp.setEncoding("utf8");
        resp.on("data", function(c) { data += c; });
        resp.on("end",  function()  { resolve(data); });
      });
      req.setTimeout(45000, function() { req.destroy(); reject(new Error("OpenAI timeout")); });
      req.on("error", reject);
      req.write(body); req.end();
    });
    var parsed = JSON.parse(result);
    return (parsed.output||[]).filter(function(o){return o.type==="message";})
      .map(function(o){ return (o.content||[]).map(function(c){return c.text||"";}).join(""); }).join("") || null;
  } catch(e) {
    logger.warn("OpenAI search failed: " + e.message);
    return null;
  }
}

// ── PARSE AI TEXT RESPONSE INTO JSON ──
function parseAiResponse(text) {
  if (!text) return null;
  var clean = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  var match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch(e) { return null; }
}

// ── AI WEB SEARCH ENRICHMENT — uses Gemini first, OpenAI as fallback ──
async function aiSearchEnrich(companyName, caseNo, courtId, state) {
  if (!GEMINI_KEY && !OPENAI_KEY) {
    logger.warn("No GEMINI_API_KEY or OPENAI_API_KEY set — AI enrichment skipped");
    return null;
  }

  var prompt = `You are a legal and business research assistant. Search the web thoroughly for information about this company that recently filed for Chapter 11 Subchapter V bankruptcy.

Company legal name: ${companyName}
Case Number: ${caseNo || "unknown"}
Court: ${state || courtId || "unknown"}

IMPORTANT: Many small businesses file under a holding company name (e.g. "TrayJockey Enterprises Inc") but operate under a different trade name (e.g. "Maine Diner"). Search for BOTH the legal name AND any DBA/trade name you find.

Search for ALL of the following:
1. The company's operating/trade name (DBA) if different from legal name
2. Business address and phone number
3. Business website and email
4. The ACTUAL OWNER or operator — search for "owner", "founder", "proprietor", "managing member", and also the person who signed the bankruptcy petition (may be listed as "authorized representative")
5. Any managers or key staff who might be the real contact
6. Owner's direct email and phone if findable publicly
7. What the business does and why they filed

SEARCH STRATEGY — run multiple searches:
- "${companyName} owner"
- "${companyName} bankruptcy owner"  
- "${companyName} managing member"
- "${companyName} operator president CEO"
- The DBA name + "owner" once you find it
- Look at bkalerts.com, bankruptcyobserver.com, pacermonitor.com, local news, LinkedIn, Facebook

Return ONLY a valid JSON object with no markdown:
{
  "companyLegalName": "${companyName}",
  "tradeName": "DBA/operating name if different, or null",
  "address": "full street address or null",
  "phone": "main business phone or null",
  "website": "primary website URL or null",
  "altWebsite": "secondary website if found (e.g. DBA site) or null",
  "ownerName": "actual owner/operator full name or null",
  "ownerTitle": "their title/role or null",
  "ownerEmail": "owner email if found publicly or null",
  "ownerPhone": "owner direct phone if found publicly or null",
  "petitionSigner": "name of person who signed the bankruptcy petition or null",
  "petitionSignerTitle": "their title or null",
  "otherContacts": [
    {"name": "...", "role": "...", "email": "...", "phone": "..."}
  ],
  "businessType": "what the company does or null",
  "bankruptcyReason": "why they filed if mentioned or null",
  "sources": ["url1", "url2", "url3"],
  "confidence": "HIGH|MEDIUM|LOW"
}`;

  try {
    // Try Gemini first (has built-in Google Search grounding)
    var text = null;
    if (GEMINI_KEY) {
      logger.info("Using Gemini for enrichment: " + companyName);
      text = await geminiSearch(prompt);
    }
    // Fall back to OpenAI if Gemini fails or not configured
    if (!text && OPENAI_KEY) {
      logger.info("Using OpenAI for enrichment: " + companyName);
      text = await openaiSearch(prompt);
    }
    var aiData = parseAiResponse(text);
    if (!aiData) throw new Error("Could not parse AI response");
    return aiData;
  } catch(e) {
    logger.warn("AI enrichment failed: " + e.message);
    return null;
  }
}

// ── GOOGLE PLACES ──
async function googlePlaces(companyName, state) {
  if (!GOOGLE_KEY) return null;
  try {
    var q   = encodeURIComponent(companyName + (state?" "+state:""));
    var url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input="+q+"&inputtype=textquery&fields=place_id,name,formatted_address,formatted_phone_number,website&key="+GOOGLE_KEY;
    var d   = await fetchJson(url);
    if (d.status!=="OK"||!d.candidates||!d.candidates.length) return null;
    var pl  = d.candidates[0];
    if (pl.place_id) {
      var du = "https://maps.googleapis.com/maps/api/place/details/json?place_id="+pl.place_id+"&fields=name,formatted_address,formatted_phone_number,website,url&key="+GOOGLE_KEY;
      var dd = await fetchJson(du);
      if (dd.status==="OK"&&dd.result) {
        return { name:dd.result.name, address:dd.result.formatted_address||"", phone:dd.result.formatted_phone_number||"",
                 website:dd.result.website||"", mapsUrl:dd.result.url||"", source:"Google Maps" };
      }
    }
    return { name:pl.name, address:pl.formatted_address||"", phone:pl.formatted_phone_number||"",
             website:pl.website||"", mapsUrl:"", source:"Google Maps" };
  } catch(e) { logger.warn("Google Places error: "+e.message); return null; }
}

// ── WEBSITE SCRAPE ──
async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  var result = { emails:[], phones:[], contactPageUrl:null };
  try {
    var home = await fetchUrl(websiteUrl, { timeout:8000 });
    result.emails = extractEmails(home.body);
    result.phones = extractPhones(stripHtml(home.body));
    var cm = home.body.match(/href=["']([^"']*contact[^"']*)/i);
    if (cm) {
      var cu = cm[1];
      if (cu.startsWith("/")) { try { var b=new URL(websiteUrl); cu=b.origin+cu; } catch(e){} }
      if (!cu.startsWith("http")) cu = websiteUrl+"/"+cu;
      result.contactPageUrl = cu;
      try {
        var cp  = await fetchUrl(cu, {timeout:8000});
        var cpe = extractEmails(cp.body);
        var cpp = extractPhones(stripHtml(cp.body));
        var seen={}, seenp={};
        result.emails.concat(cpe).forEach(function(e){if(!seen[e]){seen[e]=true;}});
        result.phones.concat(cpp).forEach(function(p){if(!seenp[p]){seenp[p]=true;}});
        result.emails = Object.keys(seen).slice(0,5);
        result.phones = Object.keys(seenp).slice(0,5);
      } catch(e) {}
    }
  } catch(e) { logger.warn("Website scrape failed: "+e.message); }
  return result;
}

// ── TRUSTEE LOOKUP ──
async function lookupTrustee(trusteeName) {
  if (!trusteeName) return null;
  try {
    var res  = await fetchUrl("https://www.justice.gov/ust/subchapter-v-trustees", {timeout:10000});
    var text = stripHtml(res.body);
    var last = trusteeName.split(" ").slice(-1)[0];
    var idx  = text.indexOf(last);
    if (idx > -1) {
      var snip   = text.slice(Math.max(0,idx-100), idx+300);
      var emails = extractEmails(snip);
      var phones = extractPhones(snip);
      if (emails.length||phones.length) {
        return { name:trusteeName, email:emails[0]||null, phone:phones[0]||null,
                 source:"USTP Subchapter V Trustee Directory",
                 url:"https://www.justice.gov/ust/subchapter-v-trustees", confidence:"HIGH" };
      }
    }
  } catch(e) { logger.warn("Trustee lookup failed: "+e.message); }
  return { name:trusteeName, email:null, phone:null,
           source:"USTP Directory", url:"https://www.justice.gov/ust/subchapter-v-trustees", confidence:"MEDIUM" };
}

var STATE_BAR = {
  txsb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txnb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txeb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txwb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  nysb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  nyeb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  flsb:"https://www.floridabar.org/directories/find-mbr/",
  flmb:"https://www.floridabar.org/directories/find-mbr/",
  flnb:"https://www.floridabar.org/directories/find-mbr/",
  caeb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  canb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  cacb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  casb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  ilnb:"https://www.iardc.org/lawyer-search",
  njb:"https://www.njcourts.gov/attorneys/attySearch.html",
  deb:"https://www.dsba.org/find-a-lawyer/",
  vaeb:"https://www.vsb.org/site/members/search",
  vawb:"https://www.vsb.org/site/members/search",
  ganb:"https://www.gabar.org/membersearchapp/",
  gamb:"https://www.gabar.org/membersearchapp/",
  paeb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
  ohsb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
  ohnb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
  nceb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  ncmb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  mab:"https://www.massbbo.org/bbolookup.php",
  mdb:"https://www.courts.state.md.us/attyregistry",
  wawb:"https://www.mywsba.org/LawyerDirectory/",
  waeb:"https://www.mywsba.org/LawyerDirectory/",
  mnb:"https://lprb.mncourts.gov/attorney/Pages/AttorneySearch.aspx",
  orb:"https://www.osbar.org/public/ris/rissearch.asp",
  meb:"https://www.mainebar.org/page/FindanAttorney",
  ndb:"https://www.sband.org/page/find_a_lawyer_"
};

var STATE_MAP = {
  txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",
  nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
  flsb:"Florida",flmb:"Florida",flnb:"Florida",
  caeb:"California",canb:"California",cacb:"California",casb:"California",
  ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",
  njb:"New Jersey",deb:"Delaware",dcb:"Washington DC",
  vaeb:"Virginia",vawb:"Virginia",ganb:"Georgia",gamb:"Georgia",gasb:"Georgia",
  paeb:"Pennsylvania",pamb:"Pennsylvania",pawb:"Pennsylvania",
  ohsb:"Ohio",ohnb:"Ohio",nceb:"North Carolina",ncmb:"North Carolina",ncwb:"North Carolina",
  mab:"Massachusetts",mdb:"Maryland",wawb:"Washington",waeb:"Washington",
  azb:"Arizona",cob:"Colorado",mnb:"Minnesota",orb:"Oregon",
  meb:"Maine",ndb:"North Dakota",ksb:"Kansas",kyeb:"Kentucky",kywb:"Kentucky",
  laeb:"Louisiana",lamb:"Louisiana",lawb:"Louisiana",mieb:"Michigan",miwb:"Michigan",
  msnb:"Mississippi",mssb:"Mississippi",moeb:"Missouri",mowb:"Missouri",
  mtb:"Montana",nebraskab:"Nebraska",nvb:"Nevada",nhb:"New Hampshire",
  nmb:"New Mexico",prb:"Puerto Rico",rib:"Rhode Island",scb:"South Carolina",
  sdb:"South Dakota",tneb:"Tennessee",tnmb:"Tennessee",tnwb:"Tennessee",
  utb:"Utah",vtb:"Vermont",wvnb:"West Virginia",wvsb:"West Virginia",
  wieb:"Wisconsin",wiwb:"Wisconsin",wyb:"Wyoming",
  areb:"Arkansas",arwb:"Arkansas",akb:"Alaska",arb:"Arizona",
  idb:"Idaho",ianb:"Iowa",iasb:"Iowa",innb:"Indiana",insb:"Indiana",
  okeb:"Oklahoma",oknb:"Oklahoma",okwb:"Oklahoma"
};

// ── MAIN ENRICHMENT ──
async function enrichCase(caseData) {
  var debtor    = (typeof caseData.debtor === "string" ? caseData.debtor : "") 
               || (typeof caseData.caseName === "string" ? caseData.caseName : "")
               || (typeof caseData.debtorName === "string" ? caseData.debtorName : "") 
               || "";
  var courtId   = caseData.courtId || "";
  var caseNo    = caseData.docketNumber || caseData.caseNo || "";
  var trustee   = caseData.trustee || {};
  var attorneys = caseData.attorneys || [];
  var state     = STATE_MAP[courtId] || "";
  var result    = { company:null, aiData:null, trustee:null, attorneys:[], principals:[], warnings:[] };

  // 1. AI web search — finds owner, address, phone, website, context
  logger.info("AI web search enrichment for: " + debtor);
  var aiData = await aiSearchEnrich(debtor, caseNo, courtId, state);
  result.aiData = aiData;

  // 2. Google Places for business phone + Maps link
  logger.info("Google Places lookup for: " + debtor);
  var places = await googlePlaces(debtor, state);

  // 3. Merge company data — AI + Google Places
  var website = (aiData&&aiData.website) || (places&&places.website) || null;
  result.company = {
    name:       debtor,
    address:    (aiData&&aiData.address) || (places&&places.address) || null,
    phone:      (places&&places.phone)   || (aiData&&aiData.phone)   || null,
    website:    website,
    mapsUrl:    (places&&places.mapsUrl) || null,
    businessType: (aiData&&aiData.businessType) || null,
    bankruptcyReason: (aiData&&aiData.bankruptcyReason) || null,
    emails:     [],
    scrapedPhones: [],
    sources:    (aiData&&aiData.sources) || [],
    sourceNote: "Phone from Google Maps · Business info from public web search"
  };

  // 4. Scrape website for email/phone
  if (website) {
    var webData = await scrapeWebsite(website);
    if (webData) {
      result.company.emails        = webData.emails || [];
      result.company.scrapedPhones = webData.phones || [];
      result.company.contactPageUrl= webData.contactPageUrl;
    }
  }

  // 5. Build principals — owner + petition signer + other contacts
  var website2 = (aiData && aiData.altWebsite) || null;
  var domains  = [];
  if (website)  { try { domains.push(new URL(website).hostname.replace(/^www\./,"")); } catch(e){} }
  if (website2) { try { var d2=new URL(website2).hostname.replace(/^www\./,""); if(!domains.includes(d2)) domains.push(d2); } catch(e){} }

  // Also derive domain from trade name if found (e.g. "Maine Diner" → mainediner.com)
  if (aiData && aiData.tradeName) {
    var derived = aiData.tradeName.toLowerCase().replace(/[^a-z0-9]/g,"");
    domains.push(derived+".com");
    domains.push(derived+".net");
  }

  result.principals = [];

  // Primary: actual owner
  if (aiData && aiData.ownerName) {
    var ownerGuesses = [];
    domains.forEach(function(d) {
      guessEmails(aiData.ownerName, d).forEach(function(g) { ownerGuesses.push(g); });
    });
    result.principals.push({
      name:         aiData.ownerName,
      role:         aiData.ownerTitle || "Owner / Operator",
      title:        aiData.ownerTitle || null,
      email:        aiData.ownerEmail || null,
      phone:        aiData.ownerPhone || result.company.phone || null,
      emailGuesses: ownerGuesses,
      domains:      domains,
      isPrimary:    true,
      source:       "Public web search",
      confidence:   aiData.confidence || "MEDIUM",
      note:         "Verify identity before outreach"
    });
  }

  // Secondary: petition signer if different from owner
  if (aiData && aiData.petitionSigner && aiData.petitionSigner !== (aiData&&aiData.ownerName)) {
    var signerGuesses = [];
    domains.forEach(function(d) {
      guessEmails(aiData.petitionSigner, d).forEach(function(g) { signerGuesses.push(g); });
    });
    result.principals.push({
      name:         aiData.petitionSigner,
      role:         aiData.petitionSignerTitle || "Authorized Representative (Petition Signer)",
      title:        aiData.petitionSignerTitle || null,
      email:        null,
      phone:        null,
      emailGuesses: signerGuesses,
      domains:      domains,
      isPrimary:    false,
      source:       "Bankruptcy petition (public record)",
      confidence:   "HIGH",
      note:         "This person signed the bankruptcy petition — may be attorney or officer"
    });
  }

  // Additional contacts found
  if (aiData && aiData.otherContacts && aiData.otherContacts.length) {
    aiData.otherContacts.forEach(function(oc) {
      if (!oc.name) return;
      var ocGuesses = [];
      domains.forEach(function(d) {
        guessEmails(oc.name, d).forEach(function(g) { ocGuesses.push(g); });
      });
      result.principals.push({
        name:         oc.name,
        role:         oc.role || "Contact",
        title:        oc.role || null,
        email:        oc.email || null,
        phone:        oc.phone || null,
        emailGuesses: ocGuesses,
        domains:      domains,
        isPrimary:    false,
        source:       "Public web search",
        confidence:   "MEDIUM",
        note:         "Additional contact found in public records"
      });
    });
  }

  if (!result.principals.length) {
    result.warnings.push("No owner or principal found in public web search — manual review needed.");
  }

  // 6. Trustee
  if (trustee && trustee.name) {
    var td = await lookupTrustee(trustee.name);
    result.trustee = Object.assign({}, trustee, td);
  } else {
    result.trustee = { name:null, email:null, phone:null, source:"Not yet assigned", confidence:"NONE" };
    result.warnings.push("Trustee not yet assigned or not found in USTP directory.");
  }

  // 7. Attorneys — add state bar lookup link
  result.attorneys = attorneys.map(function(a) {
    return Object.assign({}, a, {
      barUrl: STATE_BAR[courtId] || "https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-locator/",
      note:   'Search "' + (a.name||"") + '" at the state bar directory for verified email and phone'
    });
  });

  return result;
}

module.exports = { enrichCase };
