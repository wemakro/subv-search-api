const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || "";

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

    const keyword  = q || "subchapter v";
    const toParam  = dateTo ? "&filed_before=" + dateTo : "";

    // Single court filter if district specified, otherwise no court filter
    // (omitting court searches all courts including bankruptcy)
    const courtParam = (district && district !== "all") ? "&court=" + district : "";

    const searchUrl = "https://www.courtlistener.com/api/rest/v4/search/?"
      + "type=r"
      + "&q=" + encodeURIComponent(keyword)
      + "&filed_after=" + dateFrom
      + toParam
      + courtParam
      + "&order_by=score+desc"
      + "&page_size=50";

    console.log("Searching:", searchUrl);

    const { status, raw } = await httpsGet(searchUrl, headers);

    console.log("CL status:", status, "raw preview:", raw.slice(0, 200));

    let body;
    try {
      body = JSON.parse(raw);
    } catch(e) {
      return res.status(502).json({
        error: "CourtListener returned non-JSON (status " + status + ")",
        preview: raw.slice(0, 300)
      });
    }

    if (status !== 200) {
      return res.status(status).json({
        error: "CourtListener error " + status,
        detail: JSON.stringify(body).slice(0, 500)
      });
    }

    const seen = new Set();
    const results = [];
    for (const hit of (body.results || [])) {
      const key = hit.docket_id || hit.id;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        debtor:   hit.caseName        || hit.case_name    || "",
        caseNo:   hit.docketNumber    || hit.docket_number || "",
        court:    hit.court_id        || hit.court         || "",
        filed:    hit.dateFiled       || hit.date_filed    || "",
        attorney: hit.assigned_to_str || "",
        url: hit.absolute_url
          ? "https://www.courtlistener.com" + hit.absolute_url
          : hit.docket_absolute_url
            ? "https://www.courtlistener.com" + hit.docket_absolute_url
            : ""
      });
    }

    res.json({ count: body.count || results.length, results });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Running on port " + PORT));
