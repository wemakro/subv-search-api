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
  try {
    const result = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    tables   = result.rows.map(r => r.table_name);
    dbStatus = "connected";
  } catch(e) {
    dbStatus = "error: " + e.message;
  }
  res.json({ status:"ok", database:dbStatus, tables });
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
    const
