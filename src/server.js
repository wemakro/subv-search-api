require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const routes  = require("./routes");
const logger  = require("./logger");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    service: "Sub-V Search API v3",
    token:   process.env.COURTLISTENER_TOKEN ? "set" : "missing",
    version: "3.0.0",
    endpoints: [
      "GET /health",
      "GET /search?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&court=all&maxPages=3",
      "GET /cases",
      "GET /cases/:docketId",
      "GET /cases/:docketId/hydrate",
      "POST /cases/:docketId/hydrate",
      "GET /cases/:docketId/principals",
      "GET /cases/:docketId/outreach-contacts",
      "GET /cases/:docketId/petition-documents",
      "GET /cases/:docketId/raw",
      "POST /jobs/discover-subv"
    ]
  });
});

app.use("/", routes);

app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err.message || err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => logger.info(`Sub-V Search API v3 running on port ${PORT}`));
