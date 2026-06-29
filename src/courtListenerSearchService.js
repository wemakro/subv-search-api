const { getAllPages } = require("./courtListenerClient");
const logger = require("./logger");

const SEARCH_TEMPLATES = [
  {
    // Primary: docket-level search for Sub-V cases
    name: "docket-subv",
    type: "r",
    q: '"Subchapter V" AND "Chapter 11" NOT "Chapter 7" NOT "Chapter 13"',
  },
  {
    // Secondary: catch small business debtor filings
    name: "small-business-debtor",
    type: "r",
    q: '"small business debtor" AND "Chapter 11" NOT "Chapter 7" NOT "Chapter 13"',
  },
  {
    // Tertiary: explicit Sub-V election filings
    name: "subv-election",
    type: "r",
    q: '"election of subchapter v" AND "Chapter 11" NOT "Chapter 7"',
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

  logger.info(`Search template [${template.name}] q="${params.q}"`);

  const hits = await getAllPages("/api/rest/v4/search/", params, { maxPages });
  logger.info(`Template [${template.name}] returned ${hits.length} hits`);

  return hits.map(h => ({
    docketId:     h.docket_id    || h.id         || null,
    searchType:   template.name,
    caseName:     h.caseName     || h.case_name   || "",
    docketNumber: h.docketNumber || h.docket_number || "",
    courtId:      h.court_id     || h.court       || "",
    dateFiled:    h.dateFiled    || h.date_filed  || "",
    absoluteUrl:  h.absolute_url
      ? "https://www.courtlistener.com" + h.absolute_url
      : h.docket_absolute_url
        ? "https://www.courtlistener.com" + h.docket_absolute_url
        : "",
    matchedQuery: template.q,
    rawPreview:   JSON.stringify(h).slice(0, 300),
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
  const seen   = new Set();
  const deduped = [];
  for (const h of allHits) {
    const key = h.docketId
      ? String(h.docketId)
      : h.caseName + h.docketNumber;
    if (!seen.has(key)) { seen.add(key); deduped.push(h); }
  }

  // Drop noise — fee receipts and entries with no docketId and no case name
  const filtered = deduped.filter(h => {
    if (!h.docketId) return false;
    if (!h.caseName && !h.absoluteUrl) return false;
    return true;
  });

  logger.info(`Discovery: ${allHits.length} total, ${deduped.length} unique, ${filtered.length} after filter`);
  return filtered;
}

module.exports = { discoverSubchapterVCases };
