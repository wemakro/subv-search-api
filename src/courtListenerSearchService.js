const { getAllPages } = require("./courtListenerClient");
const logger = require("./logger");

const SEARCH_TEMPLATES = [
  {
    // Primary: docket search with date filter — type=d works with dateFiled
    name: "docket-subv",
    type: "d",
    q: '"Subchapter V" "Chapter 11"',
  },
  {
    // Secondary: catch additional filings mentioning small business debtor
    name: "docket-sbd",
    type: "d",
    q: '"small business debtor" "Chapter 11"',
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

  logger.info(`Search [${template.name}] type=${template.type} q="${params.q}"`);

  let hits = [];
  try {
    hits = await getAllPages("/api/rest/v4/search/", params, { maxPages });
  } catch(e) {
    logger.warn(`Template [${template.name}] failed: ${e.message}`);
    return [];
  }

  logger.info(`Template [${template.name}] returned ${hits.length} hits`);

  return hits.map(h => ({
    docketId:     h.docket_id      || h.id              || null,
    searchType:   template.name,
    caseName:     h.caseName       || h.case_name        || "",
    docketNumber: h.docketNumber   || h.docket_number    || "",
    courtId:      h.court_id       || h.court            || "",
    courtName:    h.court          || "",
    dateFiled:    h.dateFiled      || h.date_filed       || "",
    chapter:      h.chapter        || null,
    assignedTo:   h.assignedTo     || h.assigned_to      || null,
    trusteeStr:   h.trustee_str    || null,
    attorney:     h.attorney       || [],
    firm:         h.firm           || [],
    absoluteUrl:  h.docket_absolute_url
      ? "https://www.courtlistener.com" + h.docket_absolute_url
      : h.absolute_url
        ? "https://www.courtlistener.com" + h.absolute_url
        : "",
    matchedQuery: template.q,
    rawPreview:   JSON.stringify(h).slice(0, 400),
  }));
}

async function discoverSubchapterVCases({ dateFrom, dateTo, court = "all", maxPages = 5 }) {
  const allHits = [];

  for (const tmpl of SEARCH_TEMPLATES) {
    try {
      const hits = await runTemplate(tmpl, { dateFrom, dateTo, court, maxPages });
      allHits.push(...hits);
    } catch(e) {
      logger.warn(`Template [${tmpl.name}] failed: ${e.message}`);
    }
  }

  // Deduplicate by docketId
  const seen    = new Set();
  const deduped = [];
  for (const h of allHits) {
    const key = h.docketId
      ? String(h.docketId)
      : h.caseName + h.docketNumber;
    if (!seen.has(key)) { seen.add(key); deduped.push(h); }
  }

  // Drop noise — entries with no docketId
  const filtered = deduped.filter(h => {
    if (!h.docketId) return false;
    return true;
  });

  logger.info(`Discovery: ${allHits.length} total, ${deduped.length} unique, ${filtered.length} after filter`);
  return filtered;
}

module.exports = { discoverSubchapterVCases };
