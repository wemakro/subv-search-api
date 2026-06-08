const https  = require("https");
const http   = require("http");
const logger = require("./logger");

const GOOGLE_KEY = process.env.GOOGLE_API_KEY || "";

// ── GENERIC FETCH ──
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib      = url.startsWith("https") ? https : http;
    const timeout  = options.timeout || 10000;
    const req      = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SubVCRM/1.0)",
        "Accept":     "text/html,application/json",
        ...(options.headers || {})
      }
    }, (resp) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location) {
        return fetchUrl(resp.headers.location, options).then(resolve).catch(reject);
      }
      let data = "";
      resp.setEncoding("utf8");
      resp.on("data", c => data += c);
      resp.on("end", () => resolve({ status: resp.statusCode, body: data, headers: resp.headers }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
    req.on("error", reject);
  });
}

// ── EXTRACT TEXT ──
function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,"")
             .replace(/<style[\s\S]*?<\/style>/gi,"")
             .replace(/<[^>]+>/g," ")
             .replace(/\s+/g," ").trim();
}

function extractEmails(text) {
  const matches = text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || [];
  // Filter out generic/placeholder emails
  const blacklist = /noreply|no-reply|donotreply|example|test@|info@.*\.(png|jpg)|privacy@|abuse@/i;
  return [...new Set(matches.filter(e => !blacklist.test(e)))].slice(0, 5);
}

function extractPhones(text) {
  const matches = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g) || [];
  return [...new Set(matches.map(p => p.trim()))].slice(0, 5);
}

// ── GOOGLE PLACES SEARCH ──
async function googlePlacesSearch(companyName, courtState) {
  if (!GOOGLE_KEY) return null;
  try {
    const query     = encodeURIComponent(`${companyName} ${courtState||""}`);
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name,formatted_address,formatted_phone_number,website,rating&key=${GOOGLE_KEY}`;
    const { body }  = await fetchUrl(searchUrl);
    const data      = JSON.parse(body);
    if (data.status !== "OK" || !data.candidates?.length) return null;
    const place = data.candidates[0];

    // Get full details if we have place_id
    if (place.place_id) {
      const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_address,formatted_phone_number,website,opening_hours,url&key=${GOOGLE_KEY}`;
      const { body: db } = await fetchUrl(detailUrl);
      const detail = JSON.parse(db);
      if (detail.status === "OK" && detail.result) {
        return {
          name:     detail.result.name || place.name,
          address:  detail.result.formatted_address || "",
          phone:    detail.result.formatted_phone_number || "",
          website:  detail.result.website || "",
          mapsUrl:  detail.result.url || "",
          source:   "Google Maps",
          confidence: "HIGH"
        };
      }
    }
    return {
      name:    place.name,
      address: place.formatted_address || "",
      phone:   place.formatted_phone_number || "",
      website: place.website || "",
      mapsUrl: "",
      source:  "Google Maps",
      confidence: "MEDIUM"
    };
  } catch(e) {
    logger.warn("Google Places error: " + e.message);
    return null;
  }
}

// ── SCRAPE WEBSITE FOR CONTACT INFO ──
async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  const result = { emails:[], phones:[], contactPageUrl: null, source: websiteUrl };
  try {
    // 1. Scrape homepage
    const home = await fetchUrl(websiteUrl, { timeout: 8000 });
    const homeText = stripHtml(home.body);
    result.emails = extractEmails(home.body);
    result.phones = extractPhones(homeText);

    // 2. Find contact page link
    const contactMatch = home.body.match(/href=["']([^"']*contact[^"']*)/i);
    if (contactMatch) {
      let contactUrl = contactMatch[1];
      if (contactUrl.startsWith("/")) {
        const base = new URL(websiteUrl);
        contactUrl = base.origin + contactUrl;
      }
      if (!contactUrl.startsWith("http")) contactUrl = websiteUrl + "/" + contactUrl;
      result.contactPageUrl = contactUrl;
      try {
        const cp = await fetchUrl(contactUrl, { timeout: 8000 });
        const cpEmails = extractEmails(cp.body);
        const cpPhones = extractPhones(stripHtml(cp.body));
        result.emails = [...new Set([...result.emails, ...cpEmails])].slice(0,5);
        result.phones = [...new Set([...result.phones, ...cpPhones])].slice(0,5);
      } catch(e) { logger.warn("Contact page scrape failed: " + e.message); }
    }
  } catch(e) {
    logger.warn("Website scrape failed for " + websiteUrl + ": " + e.message);
  }
  return result;
}

// ── GUESS EMAIL PATTERNS ──
function guessEmails(personName, domain) {
  if (!personName || !domain) return [];
  const parts  = personName.toLowerCase().replace(/[^a-z\s]/g,"").trim().split(/\s+/);
  const first  = parts[0] || "";
  const last   = parts[parts.length-1] || "";
  if (!first || !last || first===last) return [];
  return [
    { email: `${first}.${last}@${domain}`, pattern: "first.last" },
    { email: `${first}@${domain}`,         pattern: "first" },
    { email: `${first[0]}${last}@${domain}`, pattern: "flast" },
    { email: `${first}${last[0]}@${domain}`, pattern: "firstl" },
    { email: `${last}@${domain}`,           pattern: "last" },
  ];
}

// ── USTP TRUSTEE LOOKUP ──
async function lookupTrustee(trusteeName, courtState) {
  if (!trusteeName) return null;
  try {
    // USTP has a public trustee directory
    const query   = encodeURIComponent(trusteeName);
    const url     = `https://www.justice.gov/ust/subchapter-v-trustees`;
    const { body } = await fetchUrl(url, { timeout: 10000 });
    const text    = stripHtml(body);

    // Search for trustee name in page
    const nameIdx = text.indexOf(trusteeName.split(" ").slice(-1)[0]); // search by last name
    if (nameIdx > -1) {
      const snippet = text.slice(Math.max(0, nameIdx-100), nameIdx+300);
      const emails  = extractEmails(snippet);
      const phones  = extractPhones(snippet);
      if (emails.length || phones.length) {
        return {
          name:   trusteeName,
          email:  emails[0] || null,
          phone:  phones[0] || null,
          source: "USTP Subchapter V Trustee Directory",
          url:    "https://www.justice.gov/ust/subchapter-v-trustees",
          confidence: "HIGH"
        };
      }
    }

    // Fallback: try state-specific USTP page
    const stateUrl = `https://www.justice.gov/ust/ust-regions-and-offices`;
    return {
      name:   trusteeName,
      email:  null,
      phone:  null,
      source: "USTP Directory (manual lookup recommended)",
      url:    "https://www.justice.gov/ust/subchapter-v-trustees",
      confidence: "MEDIUM"
    };
  } catch(e) {
    logger.warn("Trustee lookup failed: " + e.message);
    return { name: trusteeName, email: null, phone: null, source: "USTP lookup failed", confidence: "LOW" };
  }
}

// ── STATE BAR ATTORNEY LOOKUP ──
async function lookupAttorney(attorneyName, courtId) {
  if (!attorneyName) return null;

  // Map court ID to state bar URL
  const STATE_BAR_URLS = {
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
    njb: "https://www.njcourts.gov/attorneys/attySearch.html",
    deb: "https://www.dsba.org/find-a-lawyer/",
    vaeb:"https://www.vsb.org/site/members/search",
    vawb:"https://www.vsb.org/site/members/search",
    ganb:"https://www.gabar.org/membersearchapp/",
    gamb:"https://www.gabar.org/membersearchapp/",
    paeb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
    pamb:"https://www.padisciplinaryboard.org/for-the-public/find-attorney",
    ohsb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
    ohnb:"https://www.supremecourt.ohio.gov/AttorneySearch/",
    nceb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
    ncmb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
    ncwb:"https://www.ncbar.gov/for-the-public/attorney-lookup/",
    mab: "https://www.massbbo.org/bbolookup.php",
    mdb: "https://www.courts.state.md.us/attyregistry",
    wawb:"https://www.mywsba.org/LawyerDirectory/LawyerProfile.aspx",
    waeb:"https://www.mywsba.org/LawyerDirectory/LawyerProfile.aspx",
    azb: "https://azbar.legalserviceslink.com/",
    cob: "https://www.coloradosupremecourt.com/Self%20Help/AttorneySearch.asp",
    mnb: "https://lprb.mncourts.gov/attorney/Pages/AttorneySearch.aspx",
    orb: "https://www.osbar.org/public/ris/rissearch.asp",
    meb: "https://www.mainebar.org/page/FindanAttorney",
    ndb: "https://www.sband.org/page/find_a_lawyer_",
  };

  const barUrl = STATE_BAR_URLS[courtId] || "https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-locator/";

  // Try Google search for attorney contact
  if (GOOGLE_KEY) {
    try {
      const query = encodeURIComponent(`"${attorneyName}" attorney email phone site:linkedin.com OR site:law.com OR site:avvo.com OR site:martindale.com`);
      // Use Custom Search — fall back to returning bar URL
    } catch(e) {}
  }

  return {
    name:      attorneyName,
    email:     null,
    phone:     null,
    barUrl:    barUrl,
    source:    "State Bar Directory (manual lookup)",
    lookupUrl: barUrl,
    confidence:"MEDIUM",
    note:      `Search for "${attorneyName}" at the state bar directory above for verified contact info.`
  };
}

// ── MAIN ENRICHMENT FUNCTION ──
async function enrichCase(caseData) {
  const { debtor, courtId, trustee, attorneys, principals } = caseData;
  const result = {
    company:  null,
    trustee:  null,
    attorneys:[],
    principals:[],
    warnings: []
  };

  // Derive state from court ID
  const stateMap = {
    txsb:"Texas",txnb:"Texas",txeb:"Texas",txwb:"Texas",
    nysb:"New York",nyeb:"New York",nynb:"New York",nywb:"New York",
    flsb:"Florida",flmb:"Florida",flnb:"Florida",
    caeb:"California",canb:"California",cacb:"California",casb:"California",
    ilnb:"Illinois",ilcb:"Illinois",ilsb:"Illinois",
    njb:"New Jersey",deb:"Delaware",vaeb:"Virginia",vawb:"Virginia",
    ganb:"Georgia",gamb:"Georgia",gasb:"Georgia",
    paeb:"Pennsylvania",pamb:"Pennsylvania",pawb:"Pennsylvania",
    ohsb:"Ohio",ohnb:"Ohio",nceb:"North Carolina",ncmb:"North Carolina",ncwb:"North Carolina",
    mab:"Massachusetts",mdb:"Maryland",wawb:"Washington",waeb:"Washington",
    azb:"Arizona",cob:"Colorado",mnb:"Minnesota",orb:"Oregon",
    meb:"Maine",ndb:"North Dakota",ksb:"Kansas",
    kyeb:"Kentucky",kywb:"Kentucky",laeb:"Louisiana",lamb:"Louisiana",lawb:"Louisiana",
    mieb:"Michigan",miwb:"Michigan",msnb:"Mississippi",mssb:"Mississippi",
    moeb:"Missouri",mowb:"Missouri",mtb:"Montana",nebraskab:"Nebraska",
    nvb:"Nevada",nhb:"New Hampshire",nmb:"New Mexico",
    ndb:"North Dakota",ohnb:"Ohio",ohsb:"Ohio",
    okeb:"Oklahoma",oknb:"Oklahoma",okwb:"Oklahoma",
    prb:"Puerto Rico",rib:"Rhode Island",scb:"South Carolina",sdb:"South Dakota",
    tneb:"Tennessee",tnmb:"Tennessee",tnwb:"Tennessee",
    utb:"Utah",vtb:"Vermont",wvnb:"West Virginia",wvsb:"West Virginia",
    wieb:"Wisconsin",wiwb:"Wisconsin",wyb:"Wyoming",
  };
  const state = stateMap[courtId] || "";

  // 1. Company enrichment via Google Places
  logger.info(`Enriching company: ${debtor}`);
  const places = await googlePlacesSearch(debtor, state);
  if (places) {
    result.company = { ...places, name: debtor };
    // Scrape website for additional contact info
    if (places.website) {
      const webData = await scrapeWebsite(places.website);
      if (webData) {
        result.company.emails  = webData.emails;
        result.company.scrapedPhones = webData.phones;
        result.company.contactPageUrl = webData.contactPageUrl;
      }
    }
  } else {
    result.warnings.push("Company not found on Google Maps — may be a new or very small business.");
    result.company = { name: debtor, address:null, phone:null, website:null, emails:[], source:"Not found", confidence:"NONE" };
  }

  // 2. Guess owner emails from company domain
  if (result.company?.website && principals?.length) {
    try {
      const domain = new URL(result.company.website).hostname.replace(/^www\./,"");
      result.principals = principals.map(p => ({
        ...p,
        emailGuesses: guessEmails(p.name, domain),
        domain,
        note: "Email patterns are estimated — verify before sending"
      }));
    } catch(e) {
      result.principals = principals;
    }
  } else {
    result.principals = principals || [];
  }

  // 3. Trustee enrichment
  if (trustee?.name) {
    logger.info(`Looking up trustee: ${trustee.name}`);
    const trusteeData = await lookupTrustee(trustee.name, state);
    result.trustee = { ...trustee, ...trusteeData };
  }

  // 4. Attorney enrichment
  if (attorneys?.length) {
    logger.info(`Looking up ${attorneys.length} attorney(s)`);
    result.attorneys = await Promise.all(attorneys.map(async (a) => {
      const barData = await lookupAttorney(a.name, courtId);
      return { ...a, ...barData, name: a.name, firm: a.firm||barData?.firm||null };
    }));
  }

  return result;
}

module.exports = { enrichCase, googlePlacesSearch, scrapeWebsite, guessEmails, lookupTrustee, lookupAttorney };
