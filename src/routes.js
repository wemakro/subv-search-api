const express = require("express");
const cors    = require("cors");
const router  = express.Router();
const { discoverSubchapterVCases } = require("./courtListenerSearchService");
const { hydrateDocket }            = require("./caseHydrationService");
const { enrichCase }               = require("./enrichmentService");
const { getAllPages }              = require("./courtListenerClient");
const { parseContactBlock }        = require("./attorneyContactParser");
const { classifyAttorneys }        = require("./attorneyRoleClassifier");
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

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY VERIFICATION ROUTE — attorney firm parsing + role classification
//
// Read-only. Fetches nothing that hydration doesn't already fetch, writes
// nothing to the store, and changes no existing behaviour. Its only job is to
// prove the two new modules work against real CourtListener data before they
// get wired into caseHydrationService.js.
//
//   GET /debug/attorneys/:docketId
//
// What to check in the response:
//   rawFieldKeys              -> does `firm_name` actually exist on the v4
//                                attorney resource? (settles the root-cause
//                                assumption in one look)
//   partyTypesSeen[].attorneyIds -> are these populated? if every array is
//                                empty, the attorney->party join is not
//                                available and role attribution must come from
//                                docket text instead
//   summary.debtorCounsel     -> should be 1-3 on a typical Sub-V case
//   attorneys[].parsed        -> firmName / email / domain spot-check
//   attorneys[].parsed.unparsedLines -> tells us what parser rules to add
//
// Remove this route once Step 2 (hydration wiring) is deployed.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/debug/attorneys/:docketId", async (req, res) => {
  const docketId = req.params.docketId;
  try {
    logger.info(`/debug/attorneys ${docketId}`);

    // filter_nested_results=True keeps the nested `attorneys` array on each
    // party scoped to THIS docket. Without it the array can include attorneys
    // from other cases the same party appears in, which poisons role mapping.
    const parties = await getAllPages("/api/rest/v4/parties/", {
      docket: docketId,
      filter_nested_results: "True"
    }, { maxPages: 3 });

    // Explicit `fields=` and page_size=20 are required to avoid the indefinite
    // hang seen on high-volume courts such as txsb. Do NOT add
    // parties_represented here.
    const attorneys = await getAllPages("/api/rest/v4/attorneys/", {
      docket: docketId,
      filter_nested_results: "True",
      fields: "id,name,contact_raw,email,phone",
      page_size: 20
    }, { maxPages: 3 });

    const withParsed = attorneys.map(a => ({
      id:           a.id,
      name:         a.name || "",
      rawFieldKeys: Object.keys(a).filter(k => k !== "_clStatus"),
      contactRaw:   a.contact_raw || null,
      parsed:       parseContactBlock(a.contact_raw, a.name, { email: a.email, phone: a.phone })
    }));

    // Trustee names taken from the parties list, with the U.S. Trustee office
    // explicitly excluded — the UST is not the Subchapter V case trustee.
    const trusteeNames = parties
      .filter(p => (p.party_types || []).some(t => /trustee/i.test((t && t.name) || "")))
      .filter(p => !/u\.?\s?s\.?\s+trustee|united\s+states\s+trustee/i.test(p.name || ""))
      .map(p => p.name)
      .filter(Boolean);

    const result = classifyAttorneys({ attorneys: withParsed, parties, trusteeNames });

    res.json({
      docketId,
      counts: { parties: parties.length, attorneys: attorneys.length },
      trusteeNamesDetected: trusteeNames,
      partyTypesSeen: parties.map(p => ({
        name:        p.name || "",
        types:       (p.party_types || []).map(t => (t && t.name) || ""),
        attorneyIds: (p.attorneys || []).map(a => (a && a.id) || a)
      })),
      summary:   result.summary,
      warnings:  result.warnings,
      attorneys: result.attorneys
    });
  } catch (e) {
    logger.error(`/debug/attorneys ${docketId} failed:`, e.message || e);
    res.status(500).json({ docketId, error: e.message || String(e) });
  }
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
