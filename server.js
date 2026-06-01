const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || "";

// All 94 bankruptcy court IDs on CourtListener
const ALL_BK_COURTS = [
  "almb","alnb","alsb","akb","arb","areb","arwb",
  "cacb","caeb","canb","casb","cob","ctb","deb","dcb",
  "flmb","flnb","flsb","gamb","ganb","gasb","gub","hib","idb",
  "ilcb","ilnb","ilsb","innb","insb","ianb","iasb","ksb",
  "kyeb","kywb","laeb","lamb","lawb","meb","mdb","mab",
  "mieb","miwb","mnb","msnb","mssb","moeb","mowb","mtb",
  "nebraskab","nvb","nhb","njb","nmb","nyeb","nynb","nysb","nywb",
  "nceb","ncmb","ncwb","ndb","ohnb","ohsb","okeb","oknb","okwb",
  "orb","paeb","pamb","pawb","prb","rib","scb","sdb",
  "tneb","tnmb","tnwb","txeb","txnb","txsb","txwb",
  "utb","vtb","vaeb","vawb","waeb","wawb","wvnb","wvsb",
  "wieb","wiwb","wyb","vib","nmib"
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

app.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, district } = req.query;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom required" });
    if (!CL_TOKEN) return res.status(401).json({ error: "No CourtListener token set." });

    const headers = {
      "Accept": "application/json",
      "Authorization": "Token " + CL_TOKEN
    };

    const toParam = dateTo ? "&date_filed__lte=" + dateTo : "";
    let allResults = [];

    if (district && district !== "all") {
      // Single court search
      const url = "https://www.courtlistener.com/api/rest/v4/dockets/?"
        + "court=" + district
        + "&date_filed__gte=" + dateFrom
        + toParam
        + "&order_by=-date_filed"
        + "&page_size=50"
        + "&fields=id,case_name,docket_number,court_id,date_filed,date_terminated,assigned_to_str,absolute_url";

      const { status, raw } = await httpsGet(url, headers);
      let body;
      try { body = JSON.parse(raw); } catch(e) {
        return res.status(502).json({ error: "CourtListener returned non-JSON", preview: raw.slice(0,200) });
      }
      if (status !== 200) return res.status(status).json({ error: "CourtListener error " + status, detail: JSON.stringify(body).slice(0,300) });
      allResults = body.results || [];

    } else {
      // Search top 20 highest-volume bankruptcy courts in parallel
      const topCourts = ["txsb","nysb","deb","flsb","canb","cacb","ilnb","ganb","njb","mdflb","paeb","vaeb","txnb","flmb","ohsb","nynb","nywb","azb","cob","nvb"];
      const fetches = topCourts.map(court => {
        const url = "https://www.courtlistener.com/api/rest/v4/dockets/?"
          + "court=" + court
          + "&date_filed__gte=" + dateFrom
          + toParam
          + "&order_by=-date_filed"
          + "&page_size=10"
          + "&fields=id,case_name,docket_number,court_id,date_filed,date_terminated,assigned_to_str,absolute_url";
        return httpsGet(url, headers).then(({ raw }) => {
          try { return JSON.parse(raw).results || []; } catch(e) { return []; }
        }).catch(() => []);
      });

      const nested = await Promise.all(fetches);
      allResults = nested.flat().sort((a, b) => (b.date_filed||"").localeCompare(a.date_filed||""));
    }

    const results = allResults.map(d => ({
      debtor:     d.case_name       || "",
      caseNo:     d.docket_number   || "",
      court:      d.court_id        || "",
      filed:      d.date_filed      || "",
      terminated: d.date_terminated || "",
      attorney:   d.assigned_to_str || "",
      url: d.absolute_url ? "https://www.courtlistener.com" + d.absolute_url : ""
    }));

    res.json({ count: results.length, results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Running on port " + PORT));
