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
// Safe to run every time — IF NOT EXISTS means they only apply once.
async function runMigrations() {
  try {
    const { query } = require("./db/connection");

    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS close_lead_id TEXT`);
    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS close_pushed_at TIMESTAMPTZ`);
    await query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS is_subchapter_v BOOLEAN`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cases_close_lead_id ON cases(close_lead_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cases_is_subchapter_v ON cases(is_subchapter_v)`);

    // enrichment_attempts columns needed by enrichmentStore.js
    await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS case_id INTEGER`);
    await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS status TEXT`);
    await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS source TEXT`);
    await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS enrichment_json JSONB`);
    await query(`ALTER TABLE enrichment_attempts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await query(`CREATE INDEX IF NOT EXISTS idx_enrichment_case_id ON enrichment_attempts(case_id)`);

    logger.info("DB migrations OK — all columns ready");
  } catch(e) {
    logger.warn("DB migration warning (non-fatal): " + e.message);
  }
}

// ── In-app daily scheduler ──────────────────────────────────────────────────
// Fires the pipeline at 11:00 UTC (2PM Jerusalem) every day.
// This lives in the app because there is no external Render cron service.
// Dependency-free: checks the clock every minute; the pipeline's own lock
// prevents double runs even if this fires twice.
let lastScheduledRunDate = null;
function startDailyScheduler() {
  setInterval(() => {
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 11 && now.getUTCMinutes() < 5 && lastScheduledRunDate !== today) {
        lastScheduledRunDate = today;
        logger.info("In-app scheduler: firing daily pipeline (11:00 UTC)");
        const { runDailyPipeline } = require("./jobs/dailyPipeline");
        runDailyPipeline({ triggeredBy: "cron" })
          .then(r => logger.info("Scheduled pipeline finished: " + JSON.stringify(r || {}).slice(0, 200)))
          .catch(e => logger.error("Scheduled pipeline error: " + e.message));
      }
    } catch(e) {
      logger.error("Scheduler tick error: " + e.message);
    }
  }, 60 * 1000);
  logger.info("Daily scheduler armed — fires at 11:00 UTC");
}

app.listen(PORT, async () => {
  logger.info(`Sub-V Search API v3 running on port ${PORT}`);
  await runMigrations();
  startDailyScheduler();
});
