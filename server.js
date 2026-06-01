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

app.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, district } = req.query;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom required" });

    if (!CL_TOKEN) {
      return res.status(401).json({ error: "No CourtListener token set. Add COURTLISTENER_TOKEN in Render environment variables." });
    }

    const courtParam = district && district !== "all" ? "&court=" + district : "";
    const toParam = dateTo ? "&date_filed__lte=" + dateTo : "";
    const url = "https://www.courtlistener.com/api/rest/v4/dockets/?type=bk&date_filed__gte=" + dateFrom + toParam + courtParam + "&order_by=-date_filed&page_size=50&fields=id,case_name,docket_number,court_id,date_filed,date_terminated,assigned_to_str,absolute_url";

    const headers = {
      "Accept": "application/json",
      "Authorization": "Token " + CL_TOKEN
    };

    const { status, raw } = await httpsGet(url, headers);

    // Always return JSON — never crash on bad response
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
        detail: JSON.stringify(body).slice(0, 300)
      });
    }

    const results = (body.results || []).map(d => ({
      debtor:     d.case_name        || "",
      caseNo:     d.docket_number    || "",
      court:      d.court_id         || "",
      filed:      d.date_filed       || "",
      terminated: d.date_terminated  || "",
      attorney:   d.assigned_to_str  || "",
      url: d.absolute_url ? "https://www.courtlistener.com" + d.absolute_url : ""
    }));

    res.json({ count: body.count || results.length, results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Running on port " + PORT));
