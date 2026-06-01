const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || "";

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: resp.statusCode, body: data }); }
      });
    }).on("error", reject);
  });
}

app.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, district } = req.query;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom required" });
    const courtParam = district && district !== "all" ? "&court=" + district : "";
    const toParam = dateTo ? "&date_filed__lte=" + dateTo : "";
    const url = "https://www.courtlistener.com/api/rest/v4/dockets/?type=bk&date_filed__gte=" + dateFrom + toParam + courtParam + "&order_by=-date_filed&page_size=50&fields=id,case_name,docket_number,court_id,date_filed,date_terminated,assigned_to_str,absolute_url";
    const headers = { "Accept": "application/json" };
    if (CL_TOKEN) headers["Authorization"] = "Token " + CL_TOKEN;
    const { status, body } = await httpsGet(url, headers);
    if (status !== 200) return res.status(status).json({ error: "CourtListener error " + status });
    const results = (body.results || []).map(d => ({
      debtor: d.case_name || "",
      caseNo: d.docket_number || "",
      court: d.court_id || "",
      filed: d.date_filed || "",
      terminated: d.date_terminated || "",
      attorney: d.assigned_to_str || "",
      url: d.absolute_url ? "https://www.courtlistener.com" + d.absolute_url : ""
    }));
    res.json({ count: body.count || results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Running on port " + PORT));
