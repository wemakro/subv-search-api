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

router.use(cors({ origin:"*", methods:["GET","POST","OPTIONS"], allowedHeaders:["Content-Type","Authorization","Accept","x-cron-secret"] }));
router.options("*", cors());

// ── HEALTH ──
router.get("/health", async (req, res) => {
  let dbStatus     = "not_connected";
  let tables       = [];
  let caseCount    = 0;
  let contactCount = 0;
  let trusteeCount = 0;
  try {
    const result = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    tables       = result.rows.map(r => r.table_name);
    dbStatus     = "connected";
    const cc     = await query("SELECT COUNT(*) AS n FROM cases");
    const ct     = await query("SELECT COUNT(*) AS n FROM contacts");
    const ctr    = await query("SELECT COUNT(*) AS n FROM trustees");
    caseCount    = parseInt(cc.rows[0].n, 10);
    contactCount = parseInt(ct.rows[0].n, 10);
    trusteeCount = parseInt(ctr.rows[0].n, 10);
  } catch(e) {
    dbStatus = "error: " + e.message;
  }
  res.json({ status:"ok", database:dbStatus, tables, caseCount, contactCount, trusteeCount });
});

// ── DEBUG ──
router.get("/debug/courtlistener/token", (req, res) => {
  const t = process.env.COURTLISTENER_TOKEN || "";
  res.json({ set:!!t, length:t.length, prefix:t ? t.slice(0,4)+"..." : null });
});

// ── COURTLISTENER SEARCH DIAGNOSTIC ──
router.get("/debug/cl-search", async (req, res) => {
  const { clGetJson } = require("./courtListenerClient");
  const type  = req.query.type  || "r";
  const q     = req.query.q     || '"Subchapter V" "Chapter 11"';
  const from  = req.query.from  || null;
  const to    = req.query.to    || null;
  const court = req.query.court || "";

  let fullQ = q;
  if (from && to) fullQ += ` AND dateFiled:[${from} TO ${to}]`;

  const params = new URLSearchParams({
    type,
    q:         fullQ,
    order_by:  "score desc",
    page_size: "5",
  });
  if (court) params.set("court", court);

  const url = `/api/rest/v4/search/?${params.toString()}`;
  logger.info(`CL diagnostic: ${url}`);

  try {
    const result = await clGetJson(url);
    res.json({
      url,
      status:  result._clStatus,
      count:   result.count,
      results: (result.results || []).slice(0, 3),
      next:    result.next || null,
      raw:     JSON.stringify(result).slice(0, 2000),
    });
  } catch(e) {
    res.status(500).json({ error: e.message, url });
  }
});

// ── COURTLISTENER WEBHOOK RECEIVER ──
router.post("/webhooks/courtlistener", async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const body      = req.body;
    const eventType = body?.webhook?.event_type;
    const idempotency = req.headers["idempotency-key"] || "";
    logger.info(`CL Webhook — event_type: ${eventType} idempotency: ${idempotency}`);

    if (eventType === 2) {
      const results = body?.payload?.results || [];
      logger.info(`Search alert webhook: ${results.length} new results`);
      for (const hit of results) {
        const docketId = hit.docket_id || hit.id || null;
        if (!docketId) continue;
        logger.info(`Webhook processing docket: ${docketId}`);
        hydrateDocket(docketId)
          .then(async h => {
            await store.saveHydratedCase(h);
            logger.info(`Webhook saved: ${docketId} — ${h.caseName}`);
          })
          .catch(e => logger.error(`Webhook hydration failed ${docketId}: ${e.message}`));
      }
    }
    if (eventType === 1) {
      const results = body?.payload?.results || [];
      logger.info(`Docket alert webhook: ${results.length} new entries`);
    }
  } catch(e) {
    logger.error("Webhook processing error:", e.message);
  }
});

router.get("/webhooks/courtlistener", (req, res) => {
  res.json({ status: "ok", message: "CourtListener webhook endpoint is active" });
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

// ── ENRICH ──
router.get("/cases/:docketId/enrich", async (req, res) => {
  try {
    const { docketId } = req.params;
    let c = await store.getCase(docketId);

    if (!c) {
      logger.info(`Auto-hydrating ${docketId} before enrichment`);
      c = await hydrateDocket(docketId);
      await store.saveHydratedCase(c);
    }

    if (c && !c.debtorName) {
      c = {
        ...c,
        debtorName:   c.debtor_name   || c.case_name  || "",
        caseName:     c.case_name     || "",
        docketId:     c.courtlistener_docket_id || docketId,
        docketNumber: c.case_number   || "",
        courtId:      c.court_id      || "",
        dateFiled:    c.petition_date
          ? new Date(c.petition_date).toISOString().slice(0, 10)
          : "",
        attorneys:    [],
        principals:   [],
        trustee:      { name: null },
        debtor:       { name: c.debtor_name || c.case_name || "" },
      };
    }

    const enriched = await enrichCase(c);
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
    const result = await query(`SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 20`);
    res.json({ runs: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/pipeline/runs/:id", async (req, res) => {
  try {
    const result = await query("SELECT * FROM automation_runs WHERE id = $1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error:"Run not found" });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINE — RESET STUCK RUNS ──
router.get("/pipeline/reset-stuck", async (req, res) => {
  const secret = req.query.secret || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await query(`
      UPDATE automation_runs
      SET status = 'failed', completed_at = NOW(),
          error_summary = '{"error":"Manually reset via API"}'
      WHERE status IN ('running','queued')
      RETURNING id, status, started_at
    `);
    res.json({ message: "Stuck runs cleared", reset: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINE — CHECK ACTIVE RUN ──
router.get("/pipeline/active", async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM automation_runs
      WHERE status IN ('running','queued')
      ORDER BY started_at DESC LIMIT 1
    `);
    res.json({ activeRun: result.rows[0] || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINE — STATS ──
router.get("/pipeline/stats", async (req, res) => {
  try {
    const [casesResult, contactsResult, lastRunResult, trusteeResult] = await Promise.all([
      query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_subchapter_v) AS subv FROM cases"),
      query("SELECT contact_type, COUNT(*) FROM contacts GROUP BY contact_type"),
      query(`SELECT * FROM automation_runs WHERE status IN ('completed','completed_with_errors') ORDER BY completed_at DESC LIMIT 1`),
      query("SELECT COUNT(*) AS total FROM trustees WHERE active = TRUE"),
    ]);
    const contactsByType = {};
    contactsResult.rows.forEach(r => { contactsByType[r.contact_type] = parseInt(r.count, 10); });
    res.json({
      cases:    { total: parseInt(casesResult.rows[0].total, 10), subchapterV: parseInt(casesResult.rows[0].subv, 10) },
      contacts: contactsByType,
      trustees: parseInt(trusteeResult.rows[0].total, 10),
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

function todayStr() { return new Date().toISOString().slice(0, 10); }

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

// ── TRUSTEE IMPORT ──
router.post("/admin/import-trustees", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.body?.secret || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const trustees = req.body?.trustees;
  if (!Array.isArray(trustees) || trustees.length === 0) {
    return res.status(400).json({ error: "trustees array required in request body" });
  }

  let inserted = 0, updated = 0, errors = [];

  for (const t of trustees) {
    try {
      const result = await query(`
        INSERT INTO trustees (
          district_code, district_name, full_name, email, phone,
          contact_type, program_type, appointment_type,
          source_url, source_verified_at, active,
          outreach_status, notes, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (district_code, full_name) DO UPDATE SET
          district_name      = COALESCE(EXCLUDED.district_name, trustees.district_name),
          email              = COALESCE(EXCLUDED.email, trustees.email),
          phone              = COALESCE(EXCLUDED.phone, trustees.phone),
          source_url         = COALESCE(EXCLUDED.source_url, trustees.source_url),
          source_verified_at = COALESCE(EXCLUDED.source_verified_at, trustees.source_verified_at),
          active             = EXCLUDED.active,
          updated_at         = NOW()
        RETURNING (xmax = 0) AS is_insert
      `, [
        t.district_code, t.district_name || null,
        t.name || t.full_name,
        t.email || null, t.phone || null,
        t.contact_type || "subchapter_v_trustee",
        t.program_type || "USTP",
        t.appointment_type || "case_by_case",
        t.source_url || null, t.source_verified_at || null,
        t.active !== false,
        t.outreach_status || "not_contacted",
        t.notes || null,
      ]);
      if (result.rows[0]?.is_insert) inserted++;
      else updated++;
    } catch(e) {
      errors.push({ trustee: t.name || t.full_name, error: e.message });
    }
  }

  logger.info(`Trustee import: ${inserted} inserted, ${updated} updated, ${errors.length} errors`);
  res.json({ inserted, updated, errors, total: trustees.length });
});

// ── TRUSTEE LOOKUP ──
router.get("/trustees", async (req, res) => {
  try {
    const { district, name } = req.query;
    let sql = "SELECT * FROM trustees WHERE active = TRUE";
    const params = [];
    if (district) {
      params.push(district.toLowerCase());
      sql += ` AND district_code = $${params.length}`;
    }
    if (name) {
      params.push(`%${name}%`);
      sql += ` AND full_name ILIKE $${params.length}`;
    }
    sql += " ORDER BY district_code, full_name";
    const result = await query(sql, params);
    res.json({ trustees: result.rows, total: result.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLOSE BACKFILL ──
// Pushes existing confirmed Sub-V cases from the database to Close CRM.
// Use limit and offset to process in small batches.
// Safe to run multiple times — duplicate check prevents re-creating existing leads.
router.get("/admin/close-backfill", async (req, res) => {
  const secret = req.query.secret || "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { pushCaseToClose, getContactsForCase } = require("./integrations/closeIntegration");
  const limit  = Math.min(parseInt(req.query.limit  || "10", 10), 30);
  const offset = parseInt(req.query.offset || "0", 10);

  // Optional date filters so you can target a specific filing window
  const fromDate = req.query.fromDate || null;
  const toDate   = req.query.toDate   || null;

  try {
    let sql = `
      SELECT * FROM cases
      WHERE is_subchapter_v = TRUE
        AND case_name IS NOT NULL
        AND LENGTH(TRIM(case_name)) > 3
        AND case_name NOT ILIKE '%unknown debtor%'
        AND case_name NOT ILIKE '%and the case number%'
        AND case_name NOT ILIKE '%official form%'
        AND case_name NOT ILIKE '%voluntary petition%'
    `;
    const params = [];

    if (fromDate) {
      params.push(fromDate);
      sql += ` AND petition_date >= $${params.length}`;
    }
    if (toDate) {
      params.push(toDate);
      sql += ` AND petition_date <= $${params.length}`;
    }

    sql += ` ORDER BY petition_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    const cases  = result.rows;

    logger.info(`Close backfill: ${cases.length} cases to process (limit ${limit} offset ${offset})`);

    // Return immediately so the request doesn't time out
    res.json({
      status:    "started",
      total:     cases.length,
      limit,
      offset,
      fromDate:  fromDate || "any",
      toDate:    toDate   || "any",
      message:   "Processing in background — check server logs for progress",
    });

    // Process in background
    (async function() {
      const stats = { pushed: 0, skipped: 0, errors: 0 };
      for (const c of cases) {
        await new Promise(function(r) { setTimeout(r, 500); });
        try {
          const contacts   = await getContactsForCase(c.id, query);
          const pushResult = await pushCaseToClose(c, contacts);
          if (pushResult.success)       stats.pushed++;
          else if (pushResult.skipped)  stats.skipped++;
          else                          stats.errors++;
          logger.info(
            "Close backfill: " + (c.case_name || c.case_number) +
            " — " + (pushResult.success ? "pushed ✓" :
                     pushResult.skipped  ? "skipped (" + pushResult.reason + ")" :
                     "ERROR: " + pushResult.message)
          );
        } catch(e) {
          stats.errors++;
          logger.error("Close backfill error for " + c.case_name + ": " + e.message);
        }
      }
      logger.info(
        "Close backfill complete: " + stats.pushed + " pushed, " +
        stats.skipped + " skipped, " + stats.errors + " errors"
      );
    })();

  } catch(e) {
    logger.error("Close backfill setup error: " + e.message);
    res.status(500).json({ error: e.message });
  }
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
