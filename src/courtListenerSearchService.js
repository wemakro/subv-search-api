const { getAllPages } = require("./courtListenerClient");
const logger = require("./logger");

const SEARCH_TEMPLATES = [
  {
    // Docket-level search — matches cases where the docket itself is tagged Sub-V
    name: "docket-subv",
    type: "d",
    q: 'chapter:11 AND ("subchapter v" OR "subchapter 5" OR "small business debtor")',
  },
  {
    // RECAP document search — matches filings that mention Sub-V in document text
    name: "recap-subv",
    type: "r",
    q: '("Subchapter V" OR "Subchapter 5" OR "election of subchapter v" OR "small business debtor") AND chapter:11',
  },
  {
    // Docket entry search — TIGHTENED: must mention subchapter v OR small business debtor
    // Removed "Voluntary Petition" and "Official Form 201" alone — too broad, matches all Chapter 11
    name: "filing-subv",
    type: "rd",
    q: '("Subchapter V" OR "small business debtor") AND chapter:11',
  },
];

function buildDateQ(dateFrom, dateTo) {
  if (dateFrom && dateTo) return ` AND dateFiled:[${dateFrom} TO ${dateTo}]`;
  if (dateFrom)           return ` AND dateFiled:[${dateFrom} TO *]`;
  return "";
}

async function runTemplate(template, { dateFrom, dateTo, court, maxPages }) {
  const params = {
    type:      template.type,
    q:         template.q + buildDateQ(dateFrom, dateTo),
    order_by:  "score desc",
    page_size: 20,
  };
  if (court && court !== "all") params.court = court;

  logger.info(`Search template [${template.name}] type=${template.type} court=${court||"all"}`);

  const hits = await getAllPages("/api/rest/v4/search/", params, { maxPages });
  logger.info(`Template [${template.name}] returned ${hits.length} hits`);
  return hits.map(h => ({
    docketId:    h.docket_id   || h.id        || null,
    searchType:  template.name,
    caseName:    h.caseName    || h.case_name  || "",
    docketNumber:h.docketNumber|| h.docket_number || "",
    courtId:     h.court_id    || h.court      || "",
    dateFiled:   h.dateFiled   || h.date_filed || "",
    absoluteUrl: h.absolute_url
      ? "https://www.courtlistener.com" + h.absolute_url
      : h.docket_absolute_url
        ? "https://www.courtlistener.com" + h.docket_absolute_url
        : "",
    matchedQuery: template.q,
    rawPreview:  JSON.stringify(h).slice(0, 300),
  }));
}

async function discoverSubchapterVCases({ dateFrom, dateTo, court = "all", maxPages = 5 }) {
  const allHits = [];

  for (const tmpl of SEARCH_TEMPLATES) {
    try {
      const hits = await runTemplate(tmpl, { dateFrom, dateTo, court, maxPages });
      allHits.push(...hits);
    } catch(e) {
      logger.warn(`Template [${tmpl.name}] failed: ${e.message || JSON.stringify(e)}`);
    }
  }

  // Deduplicate by docketId
  const seen = new Set();
  const deduped = [];
  for (const h of allHits) {
    const key = h.docketId ? String(h.docketId) : h.caseName + h.docketNumber;
    if (!seen.has(key)) { seen.add(key); deduped.push(h); }
  }

  // Post-filter: drop results with no docketId and no case name
  // These are fee receipts and other noise entries
  const filtered = deduped.filter(function(h) {
    if (!h.docketId) return false;
    // Drop pure fee receipt entries — they have no case name and no absolute URL
    if (!h.caseName && !h.absoluteUrl) return false;
    return true;
  });

  logger.info(`Discovery complete: ${allHits.length} total hits, ${deduped.length} unique, ${filtered.length} after noise filter`);
  return filtered;
}

module.exports = { discoverSubchapterVCases };
