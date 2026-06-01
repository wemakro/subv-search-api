const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || "";

// All 94 US bankruptcy court IDs on CourtListener
// Used when user selects a specific district to filter results
const COURT_IDS = [
  "almb","alnb","alsb","akb","arb","areb","arwb",
  "cacb","caeb","canb","casb","cob","ctb","deb","dcb",
  "flmb","flnb","flsb","gamb","ganb","gasb","gub","hib","idb",
  "ilcb","ilnb","ilsb","innb","insb","ianb","iasb","ksb",
  "kyeb","kywb","laeb","lamb","lawb","meb","mdb","mab",
  "mieb","miwb","mnb","msnb","mssb","moeb","mowb","mtb",
  "nebraskab","nvb","nhb","njb","nmb",
  "nyeb","nynb","nysb","nywb",
  "nceb","ncmb","ncwb","ndb","ohnb","ohsb",
  "okeb","oknb","okwb","orb",
  "paeb","pamb","pawb","prb","rib","scb","sdb",
  "tneb","tnmb","tnwb","txeb","txnb","txsb","txwb",
  "utb","vtb","vaeb","vawb","waeb","wawb",
  "wvnb","wvsb","wieb","wiwb","wyb","vib","nmib"
];

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", token: CL_TOKEN ? "set" : "missing" });
});

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => resolve({ status: resp.statusCode, raw: data }));
    }).on("error", reject);
  });
}

// GET /search?dateFrom=2026-05-01&dateTo=2026-06-01&district=txsb&q=subchapter+v
app.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, district, q } = req.query;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom required" });
    if (!CL_TOKEN) return res.status(401).json({ error: "No CourtListener token set." });

    const headers = {
      "Accept": "application/json",
      "Authorization": "Token " + CL_TOKEN
    };

    // If specific district selected, filter to that court only
    // If "all", pass no court filter — CourtListener searches all courts
    // but we add all bk court IDs as OR to ensure only bankruptcy courts returned
    const courtParam = (district && district !== "all")
      ? "&court=" + district
      : "&court=" + COURT_IDS.join("&court=");

    const toParam = dateTo ? "&filed_before=" + dateTo : "";

    const keyword = q || "subchapter v";
    const searchUrl = "https://www.courtlistener.com/api/rest/v4/search/?"
      + "type=r"
      + "&q=" + encodeURIComponent(keyword)
      + "&filed_after=" + dateFrom
      + toParam
      + courtParam
      + "&order_by=score+desc"
      + "&page_size=50";

    const { status, raw } = await httpsGet(searchUrl, headers);

    let body;
    try { body = JSON.parse(raw); } catch(e) {
      return res.status(502).json({
        error: "CourtListener returned non-JSON (status " + status + ")",
        preview: raw.slice(0, 300)
      });
    }

    if (status !== 200) {
      return res.status(status).json({
        error: "CourtListener error " + status,
        detail: JSON.stringify(body).slice(0, 300)
      });
    }

    // Search API returns hits with nested docket info
    const seen = new Set();
    const results = [];
    for (const hit of (body.results || [])) {
      const docketId = hit.docket_id || hit.id;
      if (seen.has(docketId)) continue;
      seen.add(docketId);
      results.push({
        debtor:   hit.caseName      || hit.case_name   || "",
        caseNo:   hit.docketNumber  || hit.docket_number || "",
        court:    hit.court_id      || hit.court        || "",
        filed:    hit.dateFiled     || hit.date_filed   || "",
        attorney: hit.assigned_to_str || "",
        firm:     "",
        url: hit.absolute_url
          ? "https://www.courtlistener.com" + hit.absolute_url
          : (hit.docket_absolute_url
            ? "https://www.courtlistener.com" + hit.docket_absolute_url
            : "")
      });
    }

    res.json({ count: body.count || results.length, results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Running on port " + PORT));
