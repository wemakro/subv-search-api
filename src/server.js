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

// ── Run DB migrations on startup ───────────────────────────────────────────
// These are safe to run every time — IF NOT EXISTS means they only apply once.
async function runMigrations() {
  try {
    const { query } = require("./db/connection");

    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS close_lead_id TEXT`);
    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS close_pushed_at TIMESTAMPTZ`);
    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS is_subchapter_v BOOLEAN`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cases_close_lead_id ON cases(close_lead_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cases_is_subchapter_v ON cases(is_subchapter_v)`);

    logger.info("DB migrations OK — close_lead_id, close_pushed_at, is_subchapter_v columns ready");
  } catch(e) {
    logger.warn("DB migration warning (non-fatal): " + e.message);
  }
}

app.listen(PORT, async () => {
  logger.info(`Sub-V Search API v3 running on port ${PORT}`);
  await runMigrations();
});
