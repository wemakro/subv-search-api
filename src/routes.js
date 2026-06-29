// ── COURTLISTENER SEARCH DIAGNOSTIC ──
router.get("/debug/cl-search", async (req, res) => {
  const { clGetJson } = require("./courtListenerClient");
  const type  = req.query.type  || "r";
  const q     = req.query.q     || '"Subchapter V" "Chapter 11"';
  const from  = req.query.from  || "2026-06-27";
  const to    = req.query.to    || "2026-06-29";
  const court = req.query.court || "";

  const params = new URLSearchParams({
    type,
    q:         `${q} AND dateFiled:[${from} TO ${to}]`,
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
      results: result.results?.slice(0, 3) || [],
      next:    result.next || null,
      raw:     JSON.stringify(result).slice(0, 2000),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
