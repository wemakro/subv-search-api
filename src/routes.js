const express = require("express");
const cors    = require("cors");
const router  = express.Router();

// Apply CORS to all routes
router.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","Accept"] }));
router.options("*", cors());
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const store                        = require("./store");
const logger                       = require("./logger");

router.get("/health", (req, res) => {
  res.json({ status:"ok", cases:store.listCases().length, hydrated:store.listCases({hydratedOnly:true}).length });
});

router.get("/debug/courtlistener/token", (req, res) => {
  const t = process.env.COURTLISTENER_TOKEN||"";
  res.json({ set:!!t, length:t.length, prefix:t?t.slice(0,4)+"...":null });
});

// GET /search
router.get("/search", async (req, res) => {
  try {
    const { dateFrom, dateTo, court="all", maxPages="5", hydrate="false", q } = req.query;
    if (!dateFrom) return res.status(400).json({ error:"dateFrom required (YYYY-MM-DD)" });
    logger.info(`/search dateFrom=${dateFrom} dateTo=${dateTo} court=${court} hydrate=${hydrate}`);
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

// GET /cases
router.get("/cases", (req, res) => {
  res.json({ cases:store.listCases({ hydratedOnly:req.query.hydratedOnly==="true" }) });
});

// GET /cases/:docketId
router.get("/cases/:docketId", (req, res) => {
  const c = store.getCase(req.params.docketId);
  if (!c) return res.status(404).json({ error:"Case not found" });
  res.json(c);
});

// GET+POST /cases/:docketId/hydrate
async function hydrateRoute(req, res) {
  try {
    const { docketId } = req.params;
    const h = await hydrateDocket(docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) {
    res.status(500).json({ error:e.message||"Internal error" });
  }
}
router.get("/cases/:docketId/hydrate", hydrateRoute);
router.post("/cases/:docketId/hydrate", hydrateRoute);

// GET /cases/:docketId/petition-documents
router.get("/cases/:docketId/petition-documents", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.petitionDocuments) return res.json({ petitionDocuments:c.petitionDocuments });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ petitionDocuments:h.petitionDocuments });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /cases/:docketId/principals
router.get("/cases/:docketId/principals", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.hydrated) return res.json({ principals:c.principals, warnings:c.debug?.warnings||[] });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ principals:h.principals, warnings:h.debug?.warnings||[] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /cases/:docketId/outreach-contacts
router.get("/cases/:docketId/outreach-contacts", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.hydrated) return res.json({ outreachContacts:c.outreachContacts });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ outreachContacts:h.outreachContacts });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /cases/:docketId/raw
router.get("/cases/:docketId/raw", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c) return res.json(c);
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// POST /jobs/discover-subv
router.post("/jobs/discover-subv", async (req, res) => {
  try {
    const { dateFrom, dateTo, court="all", maxPages=5 } = req.body;
    if (!dateFrom) return res.status(400).json({ error:"dateFrom required" });
    const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court, maxPages });
    discovered.forEach(d => store.saveDiscoveredCase(d));
    res.json({ queued:discovered.length, docketIds:discovered.map(d=>d.docketId) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

module.exports = router;
