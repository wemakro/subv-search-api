const { clGetJson, getAllPages }          = require("./courtListenerClient");
const { classifySubchapterV }             = require("./subchapterVClassifier");
const { findPetitionDocuments }           = require("./docketEntryDocumentService");
const { getRecapDocumentText }            = require("./recapDocumentService");
const { extractPetitionFields }           = require("./petitionTextExtractor");
const { extractPrincipals }              = require("./principalExtractor");
const { buildOutreachContacts }          = require("./contactExtractionService");
const logger = require("./logger");

const CL = "https://www.courtlistener.com";

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
  // Try bankruptcy metadata first
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
    const isUSTrusteeOffice = /united states trustee|office of (the )?us trustee/i.test(contact);
    return {
      id: a.id||null, name: a.name||"",
      firm: isUSTrusteeOffice ? "Office of the United States Trustee" : (a.firm_name||null),
      email: emailMatch?.[0]||null,
      phone: phoneMatch?.[0]?.trim()||null,
      fax: null,
      contactRaw: contact||null,
      representing: attyToParties[a.id]||[],
      isUSTrusteeOffice,
      source: "CourtListener /attorneys"
    };
  });
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

  // 4. Attorneys
  const attorneys = await safeList(
    "/api/rest/v4/attorneys/",
    { docket: docketId, filter_nested_results: "True" },
    "attorneys", debug
  );
  if (!attorneys.length) debug.missingData.push("No attorneys returned");

  // 5. Petition documents
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

  // 6. Fetch petition text from top RECAP document
  let petitionFields = {};
  let petitionDocumentsWithText = 0;
  const petitionDocumentsOut = [];

  for (const doc of petitionDocuments.slice(0, 3)) {
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

    // Extract from best available text. Merge instead of replace: keep
    // fields from earlier (higher-relevance) docs and let later docs fill
    // gaps — a wholesale replace loses debtor fields whenever an earlier
    // doc yielded no usable signer.
    if (textResult.available && textResult.text && !petitionFields.signerName) {
      const extracted = extractPetitionFields(textResult.text);
      petitionFields = Object.assign({}, extracted, petitionFields, {
        evidenceSnippets: [
          ...(petitionFields.evidenceSnippets || []),
          ...(extracted.evidenceSnippets || []),
        ],
      });
    }
  }

  if (petitionDocumentsWithText === 0) {
    debug.warnings.push("Petition document found but no plain text available.");
    debug.nextBestActions.push("Add contact enrichment provider after confirming principal name manually.");
  }

  // 7. Principals
  const normParties    = normalizeParties(parties);
  const normAttorneys  = normalizeAttorneys(attorneys, parties);
  const principals     = extractPrincipals({ parties: normParties, petitionFields, attorneys: normAttorneys });

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

  // 10. Debtor
  const debtor = {
    name:    petitionFields.debtorName || docket.case_name || "",
    address: petitionFields.debtorAddress || null,
    email:   petitionFields.debtorEmail || null,
    phone:   petitionFields.debtorPhone || null,
    source:  petitionFields.debtorName ? "Petition text" : "Docket case_name",
    confidence: petitionFields.debtorName ? "HIGH" : "MEDIUM"
  };

  // 11. Outreach contacts
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
      principalsCount:            principals.length,
      outreachContactsCount:      0
    }
  };

  hydratedCase.outreachContacts = buildOutreachContacts(hydratedCase);
  hydratedCase.rawCounts.outreachContactsCount = hydratedCase.outreachContacts.length;

  logger.info(`Hydration complete for ${docketId}: ${principals.length} principals, ${normAttorneys.length} attorneys, ${petitionDocumentsWithText} docs with text`);
  return hydratedCase;
}

module.exports = { hydrateDocket };
