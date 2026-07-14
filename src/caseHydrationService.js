const { clGetJson, getAllPages }          = require("./courtListenerClient");
const { classifySubchapterV }             = require("./subchapterVClassifier");
const { findPetitionDocuments }           = require("./docketEntryDocumentService");
const { getRecapDocumentText }            = require("./recapDocumentService");
const { extractPetitionFields }           = require("./petitionTextExtractor");
const { extractPrincipals }              = require("./principalExtractor");
const { buildOutreachContacts }          = require("./contactExtractionService");
const logger = require("./logger");

const CL = "https://www.courtlistener.com";

// Ownership document types — these NAME THE OWNERS and must always be read,
// even when petition documents outrank them by relevance score.
const OWNERSHIP_DOC_TYPES = [
  "Corporate Ownership Statement",
  "Equity Security Holders",
];

async function safeGet(path, label, debug) {
  try {
    debug.endpointsCalled.push(path);
    const r = await clGetJson(path);
    if (r?._clError) {
      debug.warnings.push(`${label} returned status ${r._clStatus}`);
      if (r._clStatus === 403) debug.nextBestActions.push(`${label} returned 403 — token may lack permission for this endpoint.`);
      return null;
    }
    return r;
  } catch(e) {
    debug.warnings.push(`${label} failed: ${e.message || JSON.stringify(e).slice(0,80)}`);
    return null;
  }
}

async function safeList(path, params, label, debug) {
  try {
    debug.endpointsCalled.push(`${path}?${new URLSearchParams(params)}`);
    return await getAllPages(path, params, { maxPages: 3 });
  } catch(e) {
    debug.warnings.push(`${label} list failed: ${e.message || JSON.stringify(e).slice(0,80)}`);
    return [];
  }
}

function extractTrustee(parties, bkData) {
  if (bkData?.trustee_name) {
    return {
      name: bkData.trustee_name,
      email: null, phone: null, address: null,
      raw: JSON.stringify(bkData).slice(0,200),
      source: "CourtListener /bankruptcy-information",
      confidence: "HIGH"
    };
  }
  const tp = (parties || []).find(p =>
    (p.party_types||[]).some(t => (t.name||"").toLowerCase().includes("trustee"))
  );
  if (!tp) return { name: null, email: null, phone: null, address: null, raw: null, source: null, confidence: null };
  return {
    name: tp.name, email: null, phone: null,
    address: tp.extra_info || null,
    raw: JSON.stringify(tp).slice(0,200),
    source: "CourtListener /parties",
    confidence: "MEDIUM"
  };
}

function normalizeParties(parties) {
  return (parties||[]).map(p => ({
    id: p.id||null, name: p.name||"",
    type: (p.party_types||[]).map(t=>t.name).join(", "),
    role: (p.party_types||[]).map(t=>t.name).join(", "),
    extraInfo: p.extra_info||null,
    attorneyIds: (p.attorneys||[]).map(a=>a.id||a),
    party_types: p.party_types || [],
    source: "CourtListener /parties"
  }));
}

function normalizeAttorneys(attorneys, parties) {
  const attyToParties = {};
  (parties||[]).forEach(p => {
    (p.attorneys||[]).forEach(a => {
      const aid = a.id||a;
      if (!attyToParties[aid]) attyToParties[aid] = [];
      attyToParties[aid].push(p.name);
    });
  });
  return (attorneys||[]).map(a => {
    const contact = a.contact_raw||a.contact||"";
    const emailMatch = contact.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    const phoneMatch = contact.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
    return {
      id: a.id||null, name: a.name||"",
      firm: a.firm_name||null,
      email: emailMatch?.[0]||null,
      phone: phoneMatch?.[0]?.trim()||null,
      fax: null,
      contactRaw: contact||null,
      representing: attyToParties[a.id]||[],
      source: "CourtListener /attorneys"
    };
  });
}

// ── Document selection ──────────────────────────────────────────────────────
// v2: The old code took the top 3 by relevance score. Voluntary Petition
// entries (score 100) always crowded out Corporate Ownership Statements (75)
// and Equity Security Holder lists (70) — the documents that literally name
// the owners were never opened.
//
// New selection: top 2 petition-type docs + ALL ownership-type docs (up to 3)
// + fill remaining slots by score. Cap 6 documents total per case.
function selectDocumentsToRead(petitionDocuments) {
  const withDocId = petitionDocuments.filter(d => d.recapDocumentId);

  const ownership = withDocId
    .filter(d => OWNERSHIP_DOC_TYPES.includes(d.documentTypeGuess))
    .slice(0, 3);

  const petitions = withDocId
    .filter(d => /petition/i.test(d.documentTypeGuess || ""))
    .slice(0, 2);

  const selected = [];
  const seen = new Set();
  for (const d of [...petitions, ...ownership]) {
    const key = d.recapDocumentId;
    if (!seen.has(key)) { seen.add(key); selected.push(d); }
  }

  // Fill remaining slots (up to 6) with the highest-scored leftovers
  for (const d of withDocId) {
    if (selected.length >= 6) break;
    const key = d.recapDocumentId;
    if (!seen.has(key)) { seen.add(key); selected.push(d); }
  }

  // If nothing has a recap document, keep the top 3 entries anyway so
  // downstream warnings fire correctly.
  if (selected.length === 0) return petitionDocuments.slice(0, 3);

  return selected;
}

async function hydrateDocket(docketId) {
  logger.info(`Hydrating docket ${docketId}`);
  const debug = { endpointsCalled:[], missingData:[], warnings:[], nextBestActions:[] };

  // 1. Docket
  const docket = await safeGet(`/api/rest/v4/dockets/${docketId}/`, "docket", debug);
  if (!docket) return { docketId, error: "Could not fetch docket", debug };

  // 2. Bankruptcy info
  const bkResp = await safeGet(`/api/rest/v4/bankruptcy-information/?docket=${docketId}`, "bankruptcy-info", debug);
  const bkData = bkResp?.results?.[0] || null;
  if (!bkData) debug.missingData.push("bankruptcy-information returned empty");

  // 3. Parties
  const parties = await safeList("/api/rest/v4/parties/", { docket: docketId }, "parties", debug);
  if (!parties.length) debug.missingData.push("No parties returned");

  // 4. Attorneys — fetched BEFORE document reading so the attorney list is
  // available to the petition text extractor for name rejection.
  const attorneys = await safeList(
    "/api/rest/v4/attorneys/",
    { docket: docketId, filter_nested_results: "True" },
    "attorneys", debug
  );
  if (!attorneys.length) debug.missingData.push("No attorneys returned");

  const normParties    = normalizeParties(parties);
  const normAttorneys  = normalizeAttorneys(attorneys, parties);

  // Attorney names for extraction-time rejection — includes firm names
  const attorneyNames = [
    ...normAttorneys.map(a => a.name).filter(Boolean),
    ...normAttorneys.map(a => a.firm).filter(Boolean),
  ];

  // 5. Find candidate documents
  let petitionDocuments = [];
  try {
    petitionDocuments = await findPetitionDocuments(docketId);
  } catch(e) {
    debug.warnings.push(`findPetitionDocuments failed: ${e.message}`);
  }
  if (!petitionDocuments.length) {
    debug.warnings.push("No petition docket entry found.");
    debug.nextBestActions.push("Manual review of CourtListener docket recommended.");
  }

  // 6. Read selected documents — petition + ownership docs
  const docsToRead = selectDocumentsToRead(petitionDocuments);
  const ownershipDocsSelected = docsToRead.filter(d => OWNERSHIP_DOC_TYPES.includes(d.documentTypeGuess)).length;
  logger.info(`Docket ${docketId}: reading ${docsToRead.length} documents (${ownershipDocsSelected} ownership docs)`);

  let petitionFields = {};
  let combinedOwnerNames = [];
  let petitionDocumentsWithText = 0;
  const petitionDocumentsOut = [];

  for (const doc of docsToRead) {
    let textResult = { available: false, text: "", textPreview: "", extractionMethod: "not_available", warnings: [] };
    if (doc.recapDocumentId) {
      textResult = await getRecapDocumentText(doc.recapDocumentId);
      if (textResult.available) petitionDocumentsWithText++;
    } else {
      debug.warnings.push(`Petition entry found (entry #${doc.documentNumber}) but no RECAP document attached.`);
      debug.nextBestActions.push("Controlled RECAP/PACER fetch may be needed for petition PDF.");
    }

    petitionDocumentsOut.push({
      docketEntryId:    doc.docketEntryId,
      recapDocumentId:  doc.recapDocumentId,
      documentTypeGuess:doc.documentTypeGuess,
      description:      doc.description,
      relevanceScore:   doc.relevanceScore,
      textAvailable:    textResult.available,
      textPreview:      textResult.textPreview || "",
      sourceUrl:        textResult.sourceUrl || doc.recapDocumentUrl,
      warnings:         [...doc.reasons, ...(textResult.warnings||[])]
    });

    if (textResult.available && textResult.text) {
      // Extract from every readable document with attorney rejection active
      const extracted = extractPetitionFields(textResult.text, { attorneyNames });

      // First document with a signer wins the main fields
      if (!petitionFields.signerName && !petitionFields.authorizedRepresentativeName) {
        petitionFields = { ...extracted, ...petitionFields };
      }

      // Owner names accumulate across ALL documents read — this is where
      // Corporate Ownership Statements and Equity Holder lists contribute.
      if (extracted.ownerNames && extracted.ownerNames.length) {
        combinedOwnerNames.push(...extracted.ownerNames);
      }

      // Merge evidence snippets
      if (extracted.evidenceSnippets?.length) {
        petitionFields.evidenceSnippets = [
          ...(petitionFields.evidenceSnippets || []),
          ...extracted.evidenceSnippets
        ];
      }
    }
  }

  if (combinedOwnerNames.length) {
    petitionFields.ownerNames = [...new Set([...(petitionFields.ownerNames || []), ...combinedOwnerNames])];
  }

  if (petitionDocumentsWithText === 0) {
    debug.warnings.push("Petition document found but no plain text available.");
    debug.nextBestActions.push("Add contact enrichment provider after confirming principal name manually.");
  }

  // 7. Principals — attorney list passed for final rejection filter
  const principals = extractPrincipals({ parties: normParties, petitionFields, attorneys: normAttorneys });

  if (!principals.length) {
    debug.warnings.push("Principal not found in petition text.");
    debug.nextBestActions.push("Manual review of petition PDF recommended to identify signer.");
  }

  // 8. Sub-V classification
  const docketEntries = petitionDocumentsOut.map(p => ({ description: p.description }));
  const subchapterV   = classifySubchapterV({ docket, bankruptcyInformation: bkData, parties: normParties, attorneys: normAttorneys, docketEntries });

  // 9. Trustee
  const trustee = extractTrustee(parties, bkData);
  if (!trustee.name) debug.missingData.push("Trustee not found in bankruptcy metadata or parties.");

  // 10. Debtor — phone/email only attributed if it survived attorney blanking
  const debtor = {
    name:    petitionFields.debtorName || docket.case_name || "",
    address: petitionFields.debtorAddress || null,
    email:   petitionFields.debtorEmail || null,
    phone:   petitionFields.debtorPhone || null,
    source:  petitionFields.debtorName ? "Petition text" : "Docket case_name",
    confidence: petitionFields.debtorName ? "HIGH" : "MEDIUM"
  };

  // 11. Assemble
  const hydratedCase = {
    docketId,
    caseName:     docket.case_name      || "",
    debtorName:   debtor.name,
    docketNumber: docket.docket_number  || "",
    courtId:      docket.court_id       || "",
    courtName:    docket.court          || "",
    dateFiled:    docket.date_filed     || "",
    absoluteUrl:  docket.absolute_url   ? `${CL}${docket.absolute_url}` : "",
    chapter:      bkData?.chapter       || docket.chapter || null,
    subchapterV,
    trustee,
    debtor,
    attorneys:         normAttorneys,
    parties:           normParties,
    petitionDocuments: petitionDocumentsOut,
    petitionFields,
    principals,
    outreachContacts:  [],
    debug,
    rawCounts: {
      bankruptcyInformationCount: bkData ? 1 : 0,
      partiesCount:               parties.length,
      attorneysCount:             attorneys.length,
      docketEntriesCount:         petitionDocuments.length,
      petitionDocumentsCount:     petitionDocumentsOut.length,
      petitionDocumentsWithTextCount: petitionDocumentsWithText,
      ownershipDocumentsReadCount: ownershipDocsSelected,
      principalsCount:            principals.length,
      outreachContactsCount:      0
    }
  };

  hydratedCase.outreachContacts = buildOutreachContacts(hydratedCase);
  hydratedCase.rawCounts.outreachContactsCount = hydratedCase.outreachContacts.length;

  logger.info(`Hydration complete for ${docketId}: ${principals.length} principals, ${normAttorneys.length} attorneys, ${petitionDocumentsWithText} docs with text (${ownershipDocsSelected} ownership)`);
  return hydratedCase;
}

module.exports = { hydrateDocket };
