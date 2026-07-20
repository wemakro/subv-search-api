const { getAllPages } = require("./courtListenerClient");
const logger = require("./logger");

const PETITION_TERMS = [
  { term: "voluntary petition",            score: 100, type: "Voluntary Petition" },
  { term: "official form 201",             score: 100, type: "Voluntary Petition" },
  { term: "chapter 11 voluntary petition", score: 95,  type: "Voluntary Petition" },
  { term: "chapter 11 petition",           score: 90,  type: "Petition" },
  { term: "notice of chapter 11 bankruptcy case", score: 88, type: "309 Notice" },
  { term: "341 notice",                    score: 85,  type: "309 Notice" },
  { term: "subchapter v election",         score: 85,  type: "Subchapter V Election" },
  { term: "appointment of",                score: 82,  type: "Trustee Appointment" },
  { term: "small business debtor",         score: 80,  type: "Small Business Election" },
  { term: "corporate ownership statement", score: 75,  type: "Corporate Ownership Statement" },
  { term: "statement of corporate",        score: 75,  type: "Corporate Ownership Statement" },
  { term: "equity security holders",       score: 70,  type: "Equity Security Holders" },
  { term: "list of equity",                score: 70,  type: "Equity Security Holders" },
  { term: "first day declaration",         score: 65,  type: "First Day Declaration" },
  { term: "declaration in support",        score: 60,  type: "Declaration" },
  { term: "declaration",                   score: 50,  type: "Declaration" },
  { term: "statement of financial affairs",score: 45,  type: "Statement of Financial Affairs" },
  { term: "schedules",                     score: 30,  type: "Schedules" },
  { term: "petition",                      score: 20,  type: "Petition" },
];

function scoreEntry(description) {
  if (!description) return { score: 0, type: "Unknown", reasons: [] };
  const lower = description.toLowerCase();
  let best = { score: 0, type: "Unknown", reasons: [] };
  for (const t of PETITION_TERMS) {
    if (lower.includes(t.term)) {
      if (t.score > best.score) {
        best = { score: t.score, type: t.type, reasons: [`Description contains "${t.term}"`] };
      }
    }
  }
  return best;
}

// Single source of truth for pulling a docket's entries.
// Fetched ONCE per hydration and shared between petition-document detection
// and the description parser.
async function fetchDocketEntries(docketId) {
  logger.info(`Fetching docket entries for docket ${docketId}`);
  return getAllPages(
    "/api/rest/v4/docket-entries/",
    { docket: docketId, order_by: "entry_number" },
    { maxPages: 5 }
  );
}

// Accepts optional prefetched entries to avoid a duplicate API call.
async function findPetitionDocuments(docketId, prefetchedEntries) {
  const entries = Array.isArray(prefetchedEntries)
    ? prefetchedEntries
    : await fetchDocketEntries(docketId);

  const candidates = [];
  for (const entry of entries) {
    const { score, type, reasons } = scoreEntry(entry.description);
    if (score < 20) continue;

    const recapDocs = entry.recap_documents || [];
    if (recapDocs.length === 0) {
      candidates.push({
        docketEntryId:    entry.id,
        dateFiled:        entry.date_filed || null,
        description:      entry.description || "",
        documentNumber:   entry.entry_number || null,
        recapDocumentId:  null,
        recapDocumentUrl: null,
        documentTypeGuess:type,
        relevanceScore:   score,
        reasons,
        source: "CourtListener /docket-entries"
      });
    } else {
      for (const doc of recapDocs) {
        candidates.push({
          docketEntryId:    entry.id,
          dateFiled:        entry.date_filed || null,
          description:      entry.description || "",
          documentNumber:   entry.entry_number || null,
          recapDocumentId:  doc.id || doc,
          recapDocumentUrl: doc.absolute_url
            ? `https://www.courtlistener.com${doc.absolute_url}` : null,
          documentTypeGuess:type,
          relevanceScore:   score,
          reasons,
          source: "CourtListener /docket-entries + recap_documents"
        });
      }
    }
  }

  candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  logger.info(`Found ${candidates.length} petition document candidates for docket ${docketId}`);
  return candidates;
}

module.exports = { findPetitionDocuments, fetchDocketEntries };
