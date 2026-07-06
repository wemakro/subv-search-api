"use strict";
const { getAllPages } = require("./courtListenerClient");
const logger = require("./logger");

const SEARCH_TEMPLATES = [
  {
    // Primary: newest Sub-V Chapter 11 docket filings first
    name: "docket-subv",
    type: "d",
    q: '"Subchapter V" "Chapter 11"',
  },
  {
    // Secondary: catch filings that use "small business debtor" phrasing
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
    order_by:  "dateFiled desc",  // NEWEST FIRST — ensures current filings are always processed
    page_size: 20,
  };
  if (court && court !== "all") params.court = court;

  logger.info(`Search [${template.name}] type=${template.type} order=dateFiled desc q="${params.q}"`);

  let hits = [];
  try {
    hits = await getAllPages("/api/rest/v4/search/", params, { maxPages });
  } catch(e) {
    logger.warn(`Template [${template.name}] failed: ${e.message}`);
    return [];
  }

  logger.info(`Template [${template.name}] returned ${hits.length} hits`);

  return hits.map(function(h) {
    return {
      docketId:     h.docket_id      || h.id              || null,
      searchType:   template.name,
      caseName:     (h.caseName      || h.case_name        || "").replace(/,?\s*debtor\s*$/i, "").trim(),
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
    };
  });
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
    const key = h.docketId ? String(h.docketId) : h.caseName + h.docketNumber;
    if (!seen.has(key)) { seen.add(key); deduped.push(h); }
  }

  // Remove entries with no docketId or obviously bad names
  const BAD_NAMES = /^(unknown|and the case|official form|voluntary petition|in re:|case number)/i;
  const filtered = deduped.filter(function(h) {
    if (!h.docketId) return false;
    if (!h.caseName) return false;
    if (BAD_NAMES.test(h.caseName)) return false;
    return true;
  });

  logger.info(`Discovery: ${allHits.length} total, ${deduped.length} unique, ${filtered.length} after filter`);
  return filtered;
}

module.exports = { discoverSubchapterVCases };
