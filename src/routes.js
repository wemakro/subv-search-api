const express = require("express");
const cors    = require("cors");
const router  = express.Router();
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const { enrichCase }               = require("./enrichmentService");
const { runDailyPipeline }         = require("./jobs/dailyPipeline");
const { query }                    = require("./db/connection");
const { generateMasterCsv }        = require("./exports/masterCsvExporter");
const { generatePrincipalCsv }     = require("./exports/principalCsvExporter");
const { generateAttorneyCsv }      = require("./exports/attorneyCsvExporter");
const { generateTrusteeCsv }       = require("./exports/trusteeCsvExporter");
const { generateReviewCsv }        = require("./exports/reviewCsvExporter");
const store                        = require("./store");
const logger                       = require("./logger");

const CRON_SECRET = process.env.CRON_SECRET || "";

router.use(cors({ origin:"*", methods:["GET","POST","OPTIONS"], allowedHeaders:["Content-Type","Authorization","Accept"] }));
router.options("*", cors());

// ── HEALTH ──
router.get("/health", async (req, res) => {
  let dbStatus = "not_connected";
  let tables   = [];
  let caseCount = 0;
  let contactCount = 0;
  try {
    const result = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    tables   = result.rows.map(r => r.table_name);
    dbStatus = "connected";
    const cc = await query("SELECT COUNT(*) AS n FROM cases");
    const ct = await query("SELECT COUNT(*) AS n FROM contacts");
    caseCount    = parseInt(cc.rows[0].n, 10);
    contactCount = parseInt(ct.rows[0].n, 10);
  } catch(e) {
    dbStatus = "error: " + e.message;
  }
  res.json({ status:"ok", database:dbStatus, tables, caseCount, contactCount });
});

// ── DEBUG ──
router.get("/debug/courtlistener/token", (req, res) => {
  const t = process.env.COURTLISTENER_TOKEN || "";
  res.json({ set:!!t, length:t.length, prefix:t ? t.slice(0,4)+"..." : null });
});

// ── SEARCH ──
router.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, court="all", maxPages="5", hydrate="false", q } = req.query;
    if (!dateFrom) return res.status(400).json({ error:"dateFrom required (YYYY-MM-DD)" });
    logger.info(`/search dateFrom=${dateFrom} dateTo=${dateTo} court=${court}`);
    const discovered = await discoverSubchapterVCases({
      dateFrom, dateTo, court,
      maxPages: Math.min(parseInt(maxPages)||5, 10), q
    });
    for (const d of discovered) { await store.saveDiscoveredCase(d); }
    let results = discovered;
    if (hydrate === "true") {
      results = [];
      for (const d of discovered.slice(0,10)) {
        if (d.docketId) {
          const h = await hydrateDocket(d.docketId);
          await store.saveHydratedCase(h);
          results.push(h);
        }
      }
    }
    res.json({ discovered: discovered.length, results });
  } catch(e) {
    logger.error("Search error:", e.message||e);
    res.status(500).json({ error: e.message||"Internal error" });
  }
});

// ── CASES ──
router.get("/cases", async (req, res) => {
  try {
    const cases = await store.listCases();
    res.json({ cases, total: cases.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/cases/:docketId", async (req, res) => {
  try {
    const c = await store.getCase(req.params.docketId);
    if (!c) return res.status(404).json({ error:"Case not found" });
    res.json(c);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function hydrateRoute(req, res) {
  try {
    const h = await hydrateDocket(req.params.docketId);
    await store.saveHydratedCase(h);
    res.json(h);
  } catch(e) { res.status(500).json({ error: e.message }); }
}
router.get("/cases/:docketId/hydrate",  hydrateRoute);
router.post("/cases/:docketId/hydrate", hydrateRoute);

router.get("/cases/:docketId/enrich", async (req, res) => {
  try {
    const { docketId } = req.params;
    let c = await store.getCase(docketId);
    if (!c) {
      logger.info(`Auto-hydrating ${docketId} before enrichment`);
      c = await hydrateDocket(docketId);
      await store.saveHydratedCase(c);
    }
    const enriched = await enrichCase(c);
    c.enrichment = enriched;
    await store.saveHydratedCase(c);
    res.json({ docketId, enrichment: enriched });
  } catch(e) {
    logger.error("Enrich error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/cases/:docketId/outreach-contacts", async (req, res) => {
  try {
    const c = await store.getCase(req.params.docketId);
    if (c?.outreachContacts) return res.json({ outreachContacts: c.outreachContacts });
    const h = await hydrateDocket(req.params.docketId);
    await store.saveHydratedCase(h);
    res.json({ outreachContacts: h.outreachContacts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/cases/:docketId/principals", async (req, res) => {
  try {
    const c = await store.getCase(req.params.docketId);
    if (c?.principals) return res.json({ principals: c.principals, warnings: c.debug?.warnings || [] });
    const h = await hydrateDocket(req.params.docketId);
    await store.saveHydratedCase(h);
    res.json({ principals: h.principals, warnings: h.debug?.warnings || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/cases/:docketId/raw", async (req, res) => {
  try {
    const c = await store.getCase(req.params.docketId);
    if (c) return res.json(c);
    const h = await hydrateDocket(req.params.docketId);
    await store.saveHydratedCase(h);
    res.json(h);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINE TEST TRIGGER ──
router.get("/pipeline/run-test", async (req, res) => {
  const secret = req.query.secret || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const dryRun    = req.query.dryRun !== "false";
  const startDate = req.query.startDate || null;
  const endDate   = req.query.endDate   || null;
  res.json({ status:"started", message:"Pipeline running in background", dryRun, startDate, endDate });
  runDailyPipeline({
    startDate, endDate, court:"all", dryRun,
    triggeredBy: "browser_test",
  }).catch(e => logger.error("Test pipeline error:", e.message));
});

// ── PIPELINE — MANUAL TRIGGER ──
router.post("/pipeline/run", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.body?.secret || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { startDate, endDate, court, dryRun } = req.body || {};
  res.json({ status:"started", message:"Pipeline running — check /pipeline/runs for status" });
  runDailyPipeline({
    startDate, endDate,
    court:       court || "all",
    dryRun:      dryRun === true || dryRun === "true",
    triggeredBy: "manual_api",
  }).catch(e => logger.error("Background pipeline error:", e.message));
});

// ── PIPELINE — CRON ENDPOINT ──
router.post("/pipeline/cron", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ status:"started", message:"Daily pipeline triggered" });
  runDailyPipeline({ triggeredBy:"cron", dryRun:false })
    .catch(e => logger.error("Cron pipeline error:", e.message));
});

// ── PIPELINE — HISTORY ──
router.get("/pipeline/runs", async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ runs: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/pipeline/runs/:id", async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM automation_runs WHERE id = $1", [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error:"Run not found" });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINE — STATS ──
router.get("/pipeline/stats", async (req, res) => {
  try {
    const [casesResult, contactsResult, lastRunResult] = await Promise.all([
      query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_subchapter_v) AS subv FROM cases"),
      query("SELECT contact_type, COUNT(*) FROM contacts GROUP BY contact_type"),
      query(`SELECT * FROM automation_runs
             WHERE status IN ('completed','completed_with_errors')
             ORDER BY completed_at DESC LIMIT 1`),
    ]);
    const contactsByType = {};
    contactsResult.rows.forEach(r => {
      contactsByType[r.contact_type] = parseInt(r.count, 10);
    });
    res.json({
      cases: {
        total:       parseInt(casesResult.rows[0].total, 10),
        subchapterV: parseInt(casesResult.rows[0].subv,  10),
      },
      contacts: contactsByType,
      lastRun:  lastRunResult.rows[0] || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV EXPORTS ──
function csvResponse(res, csv, filename) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

router.get("/exports/list", (req, res) => {
  res.json({
    exports: [
      { name:"Master",     url:"/exports/master",     description:"All cases and contacts" },
      { name:"Principals", url:"/exports/principals", description:"Business owners" },
      { name:"Attorneys",  url:"/exports/attorneys",  description:"Debtor attorneys" },
      { name:"Trustees",   url:"/exports/trustees",   description:"Sub-V trustees" },
      { name:"Review",     url:"/exports/review",     description:"Needs manual review" },
    ]
  });
});

router.get("/exports/master", async (req, res) => {
  try {
    const { csv, rowCount } = await generateMasterCsv();
    logger.info(`Master CSV: ${rowCount} rows`);
    csvResponse(res, csv, `chapter11ready_master_${todayStr()}.csv`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/exports/principals", async (req, res) => {
  try {
    const { csv, rowCount } = await generatePrincipalCsv();
    logger.info(`Principals CSV: ${rowCount} rows`);
    csvResponse(res, csv, `chapter11ready_principals_${todayStr()}.csv`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/exports/attorneys", async (req, res) => {
  try {
    const { csv, rowCount } = await generateAttorneyCsv();
    logger.info(`Attorneys CSV: ${rowCount} rows`);
    csvResponse(res, csv, `chapter11ready_attorneys_${todayStr()}.csv`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/exports/trustees", async (req, res) => {
  try {
    const { csv, rowCount } = await generateTrusteeCsv();
    logger.info(`Trustees CSV: ${rowCount} rows`);
    csvResponse(res, csv, `chapter11ready_trustees_${todayStr()}.csv`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/exports/review", async (req, res) => {
  try {
    const { csv, rowCount } = await generateReviewCsv();
    logger.info(`Review CSV: ${rowCount} rows`);
    csvResponse(res, csv, `chapter11ready_needs_review_${todayStr()}.csv`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LEGACY ──
router.post("/enrich", async (req, res) => {
  try {
    const { debtor, courtId, trustee, attorneys, principals } = req.body;
    if (!debtor) return res.status(400).json({ error:"debtor name required" });
    const enriched = await enrichCase({ debtor, courtId, trustee, attorneys, principals });
    res.json({ enrichment: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post("/jobs/discover-subv", async (req, res) => {
  try {
    const { dateFrom, dateTo, court="all", maxPages=5 } = req.body;
    if (!dateFrom) return res.status(400).json({ error:"dateFrom required" });
    const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court, maxPages });
    for (const d of discovered) { await store.saveDiscoveredCase(d); }
    res.json({ queued: discovered.length, docketIds: discovered.map(d => d.docketId) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
