const express = require("express");
const cors    = require("cors");
const router  = express.Router();
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const { enrichCase }               = require("./enrichmentService");
const store                        = require("./store");
const logger                       = require("./logger");

router.use(cors({ origin:"*", methods:["GET","POST","OPTIONS"], allowedHeaders:["Content-Type","Authorization","Accept"] }));
router.options("*", cors());

router.get("/health", (req, res) => {
  res.json({ status:"ok", cases:store.listCases().length, hydrated:store.listCases({hydratedOnly:true}).length });
});

router.get("/debug/courtlistener/token", (req, res) => {
  const t = process.env.COURTLISTENER_TOKEN||"";
  res.json({ set:!!t, length:t.length, prefix:t?t.slice(0,4)+"...":null });
});

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

router.get("/cases/:docketId/petition-documents", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.petitionDocuments) return res.json({ petitionDocuments:c.petitionDocuments });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ petitionDocuments:h.petitionDocuments });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get("/cases/:docketId/principals", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.hydrated) return res.json({ principals:c.principals, warnings:c.debug?.warnings||[] });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ principals:h.principals, warnings:h.debug?.warnings||[] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get("/cases/:docketId/outreach-contacts", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c?.hydrated) return res.json({ outreachContacts:c.outreachContacts });
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json({ outreachContacts:h.outreachContacts });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get("/cases/:docketId/raw", async (req, res) => {
  try {
    const c = store.getCase(req.params.docketId);
    if (c) return res.json(c);
    const h = await hydrateDocket(req.params.docketId);
    store.saveHydratedCase(h);
    res.json(h);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get("/cases/:docketId/enrich", async (req, res) => {
  try {
    const { docketId } = req.params;
    let c = store.getCase(docketId);
    if (!c || !c.hydrated) {
      logger.info(`Auto-hydrating ${docketId} before enrichment`);
      c = await hydrateDocket(docketId);
      store.saveHydratedCase(c);
    }
    logger.info(`Enriching case ${docketId}`);
    const enriched = await enrichCase(c);
    c.enrichment = enriched;
    store.saveHydratedCase(c);
    res.json({ docketId, enrichment: enriched });
  } catch(e) {
    logger.error("Enrich error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

router.post("/enrich", async (req, res) => {
  try {
    const { debtor, courtId, trustee, attorneys, principals } = req.body;
    if (!debtor) return res.status(400).json({ error:"debtor name required" });
    const enriched = await enrichCase({ debtor, courtId, trustee, attorneys, principals });
    res.json({ enrichment: enriched });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

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
