require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const routes  = require("./routes");
const logger  = require("./logger");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","Accept"] }));
app.options("*", cors());
app.use(express.json());

// Serve the CRM frontend from /public
app.use(express.static(path.join(__dirname, "../public")));

app.get("/status", (req, res) => {
  res.json({
    status:  "ok",
    service: "Sub-V Search API v3",
    token:   process.env.COURTLISTENER_TOKEN ? "set" : "missing",
    version: "3.0.0"
  });
});

app.use("/", routes);

app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err.message || err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => logger.info(`Sub-V Search API v3 running on port ${PORT}`));
