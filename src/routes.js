const express = require("express");
const cors    = require("cors");
const router  = express.Router();
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const { enrichCase }               = require("./enrichmentService");
const { runDailyPipeline, runCloseBackfill, runReclassify } = require("./jobs/dailyPipeline");
const store                        = require("./store");
const logger                       = require("./logger");
const { query }                    = require("./db/connection");

router.use(cors({ origin:"*", methods:["GET","POST","OPTIONS"], allowedHeaders:["Content-Type","Authorization","Accept"] }));
router.options("*", cors());

// ── Health ─────────────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  try {
    const caseCount    = await query("SELECT COUNT(*) FROM cases");
    const contactCount = await query("SELECT COUNT(*) FROM contacts");
    const trusteeCount = await query("SELECT COUNT(*) FROM trustees");
    res.json({
      status:       "ok",
      database:     "connected",
      tables:       ["automation_runs","case_contacts","cases","contacts","enrichment_attempts","export_runs","field_evidence","organizations","schema_migrations","trustees"],
      caseCount:    parseInt(caseCount.rows[0].count),
      contactCount: parseInt(contactCount.rows[0].count),
      trusteeCount: parseInt(trusteeCount.rows[0].count)
    });
  } catch(e) {
    res.json({ status: "ok", database: "error: " + e.message });
  }
});

// ── Debug ──────────────────────────────────────────────────────────────────
router.get("/debug/courtlistener/token", (req, res) => {
  const t = process.env.COURTLISTENER_TOKEN || "";
  res.json({ set:!!t, length:t.length, prefix:t ? t.slice(0,4)+"..." : null });
});

// ── CourtListener search (legacy endpoint — used by old CRM frontend) ──────
router.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, court="all", maxPages="5", hydrate="false", q } = req.query;
    if (!dateFrom) return res.status(400).json({ error:"dateFrom required (YYYY-MM-DD)" });
    logger.info(`/search dateFrom=${dateFrom} dateTo=${dateTo} court=${court}`);
    const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court, maxPages:Math.min(parseInt(maxPages)||5,10), q });
    discovered.forEach(d => store.saveDiscoveredCase(d));
    let results = discovered;
    if (hydrate==="true") {
      results = [];
      for (const d of discovered.slice(0,10)) {
        if (d.docketId) {
          const h = await hydrateDocket(d.docketId);
          store.saveHydratedCase(h);
          results.push(h);
        }
      }
    }
    res.json({ discovered:discovered.length, results });
  } catch(e) {
    logger.error("Search error:", e.message||e);
    res.status(500).json({ error:e.message||"Internal error" });
  }
});

// ── Cases (legacy) ─────────────────────────────────────────────────────────
router.get("/cases", (req, res) => {
  res.json({ cases:store.listCases({ hydratedOnly:req.query.hydratedOnly==="true" }) });
});

router.get("/cases/:docketId", (req, res) => {
  const c = store.getCase(req.params.docketId);
  if (!c) return res.status(404).json({ error:"Case not found" });
  res.json(c);
});

async function hydrateRoute(req, res) {
  try {
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) { res.status(500).json({ error:e.message }); }
}
router.get("/cases/:docketId/hydrate", hydrateRoute);
router.post("/cases/:docketId/hydrate", hydrateRoute);

router.get("/cases/:docketId/enrich", async (req, res) => {
  try {
    const { docketId } = req.params;
    let c = store.getCase(docketId);
    if (!c || !c.hydrated) {
      c = await hydrateDocket(docketId);
      store.saveHydratedCase(c);
    }
    const enriched = await enrichCase(c);
    c.enrichment = enriched;
    store.saveHydratedCase(c);
    res.json({ docketId, enrichment: enriched });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// ── Pipeline runs log ──────────────────────────────────────────────────────
router.get("/pipeline/runs", async (req, res) => {
  try {
    const result = await query(
      `SELECT id, run_type, started_at, completed_at, status,
              search_start_date, search_end_date,
              cases_found, new_cases_created, existing_cases_updated,
              contacts_created, contacts_updated, cases_failed,
              error_summary, triggered_by, dry_run, created_at
       FROM automation_runs
       ORDER BY started_at DESC
       LIMIT 30`
    );
    res.json({ runs: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pipeline lock reset ────────────────────────────────────────────────────
router.get("/pipeline/reset-stuck", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error:"Unauthorized" });
  try {
    await query(`UPDATE automation_runs SET status='failed', error_summary='{"error":"Manually reset via API"}' WHERE status='running'`);
    res.json({ reset: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pipeline test trigger ──────────────────────────────────────────────────
router.get("/pipeline/run-test", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error:"Unauthorized" });
  const { dryRun, startDate, endDate, court } = req.query;

  // Respond immediately — pipeline runs in background
  res.json({
    status:    "started",
    message:   "Pipeline running in background. Check /pipeline/runs for results.",
    dryRun:    dryRun === "true",
    startDate: startDate || "auto",
    endDate:   endDate   || "auto",
  });

  // Run async in background
  runDailyPipeline({
    dryRun:      dryRun === "true",
    startDate:   startDate || null,
    endDate:     endDate   || null,
    court:       court     || "all",
    triggeredBy: "browser_test",
  }).catch(e => logger.error("Background pipeline error: " + e.message));
});

// ── Daily cron trigger (called by Render cron) ─────────────────────────────
router.post("/jobs/run-daily", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET && req.body?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error:"Unauthorized" });
  }

  res.json({ status:"started", message:"Daily pipeline running in background" });

  runDailyPipeline({ triggeredBy:"cron" })
    .catch(e => logger.error("Daily pipeline error: " + e.message));
});

// ── Close backfill ─────────────────────────────────────────────────────────
// Pushes DB cases that are confirmed Sub-V but not yet in Close.
// Uses close_lead_id to guarantee no duplicates — safe to run multiple times.
// Run in batches of 20 using the offset parameter:
//   /admin/close-backfill?secret=...&limit=20&offset=0
//   /admin/close-backfill?secret=...&limit=20&offset=20
//   etc. until hasMore: false
router.get("/admin/close-backfill", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error:"Unauthorized" });
  }

  const limit  = parseInt(req.query.limit  || "20", 10);
  const offset = parseInt(req.query.offset || "0",  10);

  try {
    logger.info("Close backfill triggered via API — limit:" + limit + " offset:" + offset);
    const result = await runCloseBackfill({ limit, offset });
    res.json(result);
  } catch(e) {
    logger.error("Backfill error: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Close backfill status ──────────────────────────────────────────────────
// Shows how many cases still need to be pushed to Close
router.get("/admin/close-backfill/status", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error:"Unauthorized" });
  }
  try {
    const pending = await query(
      `SELECT COUNT(*) FROM cases WHERE is_subchapter_v = true AND (close_lead_id IS NULL OR close_lead_id = '')`
    );
    const done = await query(
      `SELECT COUNT(*) FROM cases WHERE close_lead_id IS NOT NULL AND close_lead_id != ''`
    );
    const total = await query(`SELECT COUNT(*) FROM cases WHERE is_subchapter_v = true`);
    res.json({
      pendingPush: parseInt(pending.rows[0].count),
      pushedToClose: parseInt(done.rows[0].count),
      totalSubV: parseInt(total.rows[0].count),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Reclassify unclassified cases (is_subchapter_v IS NULL) ────────────────
// Re-hydrates in small batches. Each case uses ~8 CourtListener requests.
// Run: /admin/reclassify?secret=...&limit=5   (max 10 per run)
router.get("/admin/reclassify", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error:"Unauthorized" });
  }
  try {
    const result = await runReclassify({ limit: req.query.limit || "5" });
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
