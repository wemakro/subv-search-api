const https  = require("https");
const http   = require("http");
const logger = require("./logger");

const GOOGLE_KEY = process.env.GOOGLE_API_KEY || "";

function fetchUrl(url, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var lib     = url.startsWith("https") ? https : http;
    var timeout = options.timeout || 10000;
    var req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SubVCRM/1.0)",
        "Accept": "text/html,application/json"
      }
    }, function(resp) {
      if ([301,302,303,307,308].indexOf(resp.statusCode) > -1 && resp.headers.location) {
        return fetchUrl(resp.headers.location, options).then(resolve).catch(reject);
      }
      var data = "";
      resp.setEncoding("utf8");
      resp.on("data", function(c) { data += c; });
      resp.on("end",  function()  { resolve({ status: resp.statusCode, body: data }); });
    });
    req.setTimeout(timeout, function() { req.destroy(); reject(new Error("Timeout: " + url)); });
    req.on("error", reject);
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function extractEmails(text) {
  var matches = text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || [];
  var blacklist = /noreply|no-reply|donotreply|example|test@|\.png|\.jpg|privacy@|abuse@|sentry|wix|wordpress/i;
  var seen = {};
  return matches.filter(function(e) {
    if (blacklist.test(e) || seen[e]) return false;
    seen[e] = true; return true;
  }).slice(0, 5);
}

function extractPhones(text) {
  var matches = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g) || [];
  var seen = {};
  return matches.map(function(p) { return p.trim(); }).filter(function(p) {
    if (seen[p]) return false; seen[p] = true; return true;
  }).slice(0, 5);
}

function guessEmails(personName, domain) {
  if (!personName || !domain) return [];
  var parts = personName.toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/);
  var first = parts[0] || "";
  var last  = parts[parts.length - 1] || "";
  if (!first || !last || first === last) return [];
  return [
    { email: first + "." + last + "@" + domain, pattern: "first.last" },
    { email: first + "@" + domain,               pattern: "first" },
    { email: first[0] + last + "@" + domain,     pattern: "flast" },
    { email: first + last[0] + "@" + domain,     pattern: "firstl" },
    { email: last + "@" + domain,                pattern: "last" }
  ];
}

async function googlePlacesSearch(companyName, state) {
  if (!GOOGLE_KEY) return null;
  try {
    var query = encodeURIComponent(companyName + (state ? " " + state : ""));
    var url   = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=" + query
      + "&inputtype=textquery&fields=place_id,name,formatted_address,formatted_phone_number,website&key=" + GOOGLE_KEY;
    var res  = await fetchUrl(url);
    var data = JSON.parse(res.body);
    if (data.status !== "OK" || !data.candidates || !data.candidates.length) return null;
    var place = data.candidates[0];

    if (place.place_id) {
      var durl = "https://maps.googleapis.com/maps/api/place/details/json?place_id=" + place.place_id
        + "&fields=name,formatted_address,formatted_phone_number,website,url&key=" + GOOGLE_KEY;
      var dr   = await fetchUrl(durl);
      var dd   = JSON.parse(dr.body);
      if (dd.status === "OK" && dd.result) {
        return {
          name:       dd.result.name || place.name,
          address:    dd.result.formatted_address || "",
          phone:      dd.result.formatted_phone_number || "",
          website:    dd.result.website || "",
          mapsUrl:    dd.result.url || "",
          source:     "Google Maps",
          confidence: "HIGH"
        };
      }
    }
    return {
      name: place.name, address: place.formatted_address || "",
      phone: place.formatted_phone_number || "", website: place.website || "",
      mapsUrl: "", source: "Google Maps", confidence: "MEDIUM"
    };
  } catch(e) {
    logger.warn("Google Places error: " + e.message);
    return null;
  }
}

async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  var result = { emails: [], phones: [], contactPageUrl: null };
  try {
    var home = await fetchUrl(websiteUrl, { timeout: 8000 });
    result.emails = extractEmails(home.body);
    result.phones = extractPhones(stripHtml(home.body));

    var cm = home.body.match(/href=["']([^"']*contact[^"']*)/i);
    if (cm) {
      var cu = cm[1];
      if (cu.startsWith("/")) {
        try { var base = new URL(websiteUrl); cu = base.origin + cu; } catch(e) {}
      }
      if (!cu.startsWith("http")) cu = websiteUrl + "/" + cu;
      result.contactPageUrl = cu;
      try {
        var cp = await fetchUrl(cu, { timeout: 8000 });
        var cpe = extractEmails(cp.body);
        var cpp = extractPhones(stripHtml(cp.body));
        var seen = {};
        result.emails.concat(cpe).forEach(function(e) { if (!seen[e]) { seen[e]=true; result.emails.push(e); } });
        var seenp = {};
        result.phones.concat(cpp).forEach(function(p) { if (!seenp[p]) { seenp[p]=true; result.phones.push(p); } });
        result.emails = result.emails.slice(0,5);
        result.phones = result.phones.slice(0,5);
      } catch(e) { logger.warn("Contact page failed: " + e.message); }
    }
  } catch(e) {
    logger.warn("Website scrape failed for " + websiteUrl + ": " + e.message);
  }
  return result;
}

async function lookupTrustee(trusteeName) {
  if (!trusteeName) return null;
  try {
    var res  = await fetchUrl("https://www.justice.gov/ust/subchapter-v-trustees", { timeout: 10000 });
    var text = stripHtml(res.body);
    var lastName = trusteeName.split(" ").slice(-1)[0];
    var idx  = text.indexOf(lastName);
    if (idx > -1) {
      var snippet = text.slice(Math.max(0, idx - 100), idx + 300);
      var emails  = extractEmails(snippet);
      var phones  = extractPhones(snippet);
      if (emails.length || phones.length) {
        return {
          name: trusteeName, email: emails[0]||null, phone: phones[0]||null,
          source: "USTP Subchapter V Trustee Directory",
          url: "https://www.justice.gov/ust/subchapter-v-trustees",
          confidence: "HIGH"
        };
      }
    }
  } catch(e) {
    logger.warn("Trustee lookup failed: " + e.message);
  }
  return {
    name: trusteeName, email: null, phone: null,
    source: "USTP Directory — manual lookup recommended",
    url: "https://www.justice.gov/ust/subchapter-v-trustees",
    confidence: "MEDIUM"
  };
}

var STATE_BAR = {
  txsb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txnb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txeb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  txwb:"https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer",
  nysb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  nyeb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  nynb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  nywb:"https://iapps.courts.state.ny.us/attorney/AttorneySearch",
  flsb:"https://www.floridabar.org/directories/find-mbr/",
  flmb:"https://www.floridabar.org/directories/find-mbr/",
  flnb:"https://www.floridabar.org/directories/find-mbr/",
  caeb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  canb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  cacb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  casb:"https://apps.calbar.ca.gov/attorney/Licensee/Detail/",
  ilnb:"https://www.iardc.org/lawyer-search",
  ilcb:"https://www.iardc.org/lawyer-search",
  ilsb:"https://www.iardc.org/lawyer-search",
  njb:"https://www.njcourts.gov/attorneys/attySearch.html",
  deb:"https://www.dsba.org/find-a-lawyer/",
  vaeb:"https://www.vsb.org/site/members/search",
  vawb:"https://www.vsb.org/site/members/search",
  ganb:"https://www.gabar.org/membersearchapp/",
  gamb:"https://www.gabar.org/membersearchapp/",
  gasb:"https://www.gabar.org/membersearchapp/",
  paeb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
  pamb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
  pawb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
  ohsb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
  ohnb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
  nceb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  ncmb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  ncwb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
  mab:"https://www.massbbo.org/bbolookup.php",
  mdb:"https://www.courts.state.md.us/attyregistry",
  wawb:"https://www.mywsba.org/LawyerDirectory/",
  waeb:"https://www.mywsba.org/LawyerDirectory/",
  azb:"https://azbar.legalserviceslink.com/",
  cob:"https://www.coloradosupremecourt.com/Self%20Help/AttorneySearch.asp",
  mnb:"https://lprb.mncourts.gov/attorney/Pages/AttorneySearch.aspx",
  orb:"https://www.osbar.org/public/ris/rissearch.asp",
  meb:"https://www.mainebar.org/page/FindanAttorney",
  ndb:"https://www.sband.org/page/find_a_lawyer_",
  ksb:"https://www.ksbar.org/page/find_a_lawyer",
  kyeb:"https://www.kybar.org/page/FindAnAttorney",
  kywb:"https://www.kybar.org/page/FindAnAttorney",
  mieb:"https://www.michbar.org/member/directory",
  miwb:"https://www.michbar.org/member/directory"
};

var STATE_MAP = {
  txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",
  nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
  flsb:"Florida",flmb:"Florida",flnb:"Florida",
  caeb:"California",canb:"California",cacb:"California",casb:"California",
  ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",
  njb:"New Jersey",deb:"Delaware",dcb:"DC",
  vaeb:"Virginia",vawb:"Virginia",
  ganb:"Georgia",gamb:"Georgia",gasb:"Georgia",
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
  moeb:"Missouri",mowb:"Missouri",
  mtb:"Montana",nebraskab:"Nebraska",nvb:"Nevada",nhb:"New Hampshire",
  nmb:"New Mexico",prb:"Puerto Rico",rib:"Rhode Island",
  scb:"South Carolina",sdb:"South Dakota",
  tneb:"Tennessee",tnmb:"Tennessee",tnwb:"Tennessee",
  utb:"Utah",vtb:"Vermont",
  wvnb:"West Virginia",wvsb:"West Virginia",
  wieb:"Wisconsin",wiwb:"Wisconsin",wyb:"Wyoming",
  areb:"Arkansas",arwb:"Arkansas",akb:"Alaska",arb:"Arizona",
  idb:"Idaho",ianb:"Iowa",iasb:"Iowa",
  innb:"Indiana",insb:"Indiana",
  okeb:"Oklahoma",oknb:"Oklahoma",okwb:"Oklahoma"
};

async function enrichCase(caseData) {
  var debtor     = caseData.debtor || caseData.caseName || caseData.debtorName || "";
  var courtId    = caseData.courtId || "";
  var trustee    = caseData.trustee || {};
  var attorneys  = caseData.attorneys || [];
  var principals = caseData.principals || [];

  var state  = STATE_MAP[courtId] || "";
  var result = { company: null, trustee: null, attorneys: [], principals: [], warnings: [] };

  // 1. Google Places — company info
  logger.info("Enriching company: " + debtor);
  var places = await googlePlacesSearch(debtor, state);
  if (places) {
    result.company = Object.assign({ name: debtor, emails: [], scrapedPhones: [] }, places);
    if (places.website) {
      var webData = await scrapeWebsite(places.website);
      if (webData) {
        result.company.emails        = webData.emails || [];
        result.company.scrapedPhones = webData.phones || [];
        result.company.contactPageUrl= webData.contactPageUrl;
      }
    }
  } else {
    result.warnings.push("Company not found on Google Maps — may be a new or very small business.");
    result.company = { name: debtor, address: null, phone: null, website: null, emails: [], scrapedPhones: [], source: "Not found", confidence: "NONE" };
  }

  // 2. Email guesses for principals
  if (result.company && result.company.website && principals.length) {
    try {
      var domain = new URL(result.company.website).hostname.replace(/^www\./, "");
      result.principals = principals.map(function(p) {
        return Object.assign({}, p, {
          emailGuesses: guessEmails(p.name, domain),
          domain: domain,
          note: "Email patterns are estimated — verify before sending"
        });
      });
    } catch(e) { result.principals = principals; }
  } else {
    result.principals = principals;
  }

  // 3. Trustee lookup
  if (trustee && trustee.name) {
    logger.info("Looking up trustee: " + trustee.name);
    var td = await lookupTrustee(trustee.name);
    result.trustee = Object.assign({}, trustee, td);
  } else {
    result.trustee = { name: null, email: null, phone: null, source: "No trustee assigned yet", confidence: "NONE" };
  }

  // 4. Attorney state bar links
  result.attorneys = attorneys.map(function(a) {
    return Object.assign({}, a, {
      barUrl: STATE_BAR[courtId] || "https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-locator/",
      note: "Search the state bar directory above for verified contact info"
    });
  });

  return result;
}

module.exports = { enrichCase };
