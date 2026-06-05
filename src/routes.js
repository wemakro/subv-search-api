const express = require("express");
const router  = express.Router();
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const store                        = require("./store");
const logger                       = require("./logger");

// GET /health
router.get("/health", (req, res) => {
  res.json({ status: "ok", cases: store.listCases().length, hydrated: store.listCases({ hydratedOnly: true }).length });
});

// GET /debug/courtlistener/token
router.get("/debug/courtlistener/token", (req, res) => {
  const token = process.env.COURTLISTENER_TOKEN || "";
  res.json({
    set:    !!token,
    length: token.length,
    prefix: token ? token.slice(0, 4) + "..." : null
  });
});

// GET /search?dateFrom=&dateTo=&court=&maxPages=&hydrate=true
router.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, court = "all", maxPages = "5", hydrate = "false" } = req.query;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom is required (YYYY-MM-DD)" });

    logger.info(`/search dateFrom=${dateFrom} dateTo=${dateTo} court=${court} hydrate=${hydrate}`);

    const discovered = await discoverSubchapterVCases({
      dateFrom, dateTo, court,
      maxPages: Math.min(parseInt(maxPages) || 5, 10)
    });

    discovered.forEach(d => store.saveDiscoveredCase(d));

    let hydratedResults = [];
    if (hydrate === "true") {
      for (const d of discovered.slice(0, 10)) { // cap at 10 to avoid timeout
        if (d.docketId) {
          const h = await hydrateDocket(d.docketId);
          store.saveHydratedCase(h);
          hydratedResults.push(h);
        }
      }
    }

    res.json({
      discovered: discovered.length,
      results:    hydrate === "true" ? hydratedResults : discovered
    });
  } catch(e) {
    logger.error("Search route error:", e.message || e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
});

// GET /cases
router.get("/cases", (req, res) => {
  const { hydratedOnly = "false" } = req.query;
  res.json({ cases: store.listCases({ hydratedOnly: hydratedOnly === "true" }) });
});

// GET /cases/:docketId
router.get("/cases/:docketId", (req, res) => {
  const c = store.getCase(req.params.docketId);
  if (!c) return res.status(404).json({ error: "Case not found" });
  res.json(c);
});

// POST /cases/:docketId/hydrate
router.post("/cases/:docketId/hydrate", async (req, res) => {
  try {
    const { docketId } = req.params;
    logger.info(`Hydrating docket ${docketId} via POST`);
    const h = await hydrateDocket(docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) {
    logger.error("Hydrate route error:", e.message || e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
});

// GET /cases/:docketId/hydrate (convenience GET)
router.get("/cases/:docketId/hydrate", async (req, res) => {
  try {
    const { docketId } = req.params;
    const existing = store.getCase(docketId);
    if (existing?.hydrated) return res.json(existing);
    const h = await hydrateDocket(docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) {
    logger.error("Hydrate GET error:", e.message || e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
});

// POST /jobs/discover-subv
router.post("/jobs/discover-subv", async (req, res) => {
  try {
    const { dateFrom, dateTo, court = "all", maxPages = 5 } = req.body;
    if (!dateFrom) return res.status(400).json({ error: "dateFrom required in body" });
    const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court, maxPages });
    discovered.forEach(d => store.saveDiscoveredCase(d));
    res.json({ queued: discovered.length, docketIds: discovered.map(d => d.docketId) });
  } catch(e) {
    res.status(500).json({ error: e.message || "Internal error" });
  }
});

module.exports = router;
