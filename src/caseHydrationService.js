const { clGetJson, getAllPages }          = require("./courtListenerClient");
const { classifySubchapterV }             = require("./subchapterVClassifier");
const { findPetitionDocuments,
        fetchDocketEntries }              = require("./docketEntryDocumentService");
const { parseDocketEntries }              = require("./docketDescriptionParser");
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

// Trustee resolution priority:
//   1. CourtListener bankruptcy metadata (trustee_name)
//   2. Docket entry description (appointment notice)  ← NEW
//   3. /parties records
// If #1 and #2 both exist and agree on last name, confidence stays HIGH and
// the docket evidence is attached as confirmation.
function extractTrustee(parties, bkData, docketParse, debug) {
  const parsed = docketParse?.trustee || null;

  if (bkData?.trustee_name) {
    const t = {
      name: bkData.trustee_name,
      email: null, phone: null, address: null,
      raw: JSON.stringify(bkData).slice(0,200),
      source: "CourtListener /bankruptcy-information",
      confidence: "HIGH"
    };
    if (parsed) {
      const lastMeta   = bkData.trustee_name.trim().split(/\s+/).pop().toLowerCase();
      const lastParsed = parsed.name.trim().split(/\s+/).pop().toLowerCase();
      if (lastMeta === lastParsed) {
        t.confirmedBy = "Docket entry appointment notice";
        t.evidence = parsed.evidence;
      } else {
        debug.warnings.push(
          `Trustee mismatch: metadata says "${bkData.trustee_name}", docket appointment says "${parsed.name}". Using metadata; review manually.`
        );
      }
    }
    return t;
  }

  if (parsed) {
    return {
      name: parsed.name,
      email: null, phone: null, address: null,
      raw: null,
      source: parsed.source,
      confidence: parsed.confidence,
      evidence: parsed.evidence
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

// Append attorneys the description parser found that /attorneys didn't return.
// Match on last name (case-insensitive) to avoid dupes. UST attorneys are
// excluded — they are not outreach targets.
function mergeParsedAttorneys(normAttorneys, docketParse, debug) {
  const existingLastNames = new Set(
    normAttorneys.map(a => (a.name||"").trim().split(/\s+/).pop().toLowerCase()).filter(Boolean)
  );
  const merged = [...normAttorneys];
  for (const pa of (docketParse?.attorneys || [])) {
    if (pa.role !== "debtor_attorney") continue;
    const last = pa.name.trim().split(/\s+/).pop().toLowerCase();
    if (existingLastNames.has(last)) continue;
    existingLastNames.add(last);
    merged.push({
      id: null,
      name: pa.name,
      firm: pa.firm || null,
      email: null,
      phone: null,
      fax: null,
      contactRaw: null,
      representing: pa.representing ? [pa.representing] : [],
      source: pa.source,
      evidence: pa.evidence
    });
    debug.warnings.push(`Attorney "${pa.name}" found only in docket descriptions — no contact info from /attorneys; state bar lookup needed.`);
  }
  return merged;
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

  // 5. Docket entries — fetched ONCE, shared by petition detection,
  //    the description parser, and the Sub-V classifier.
  let allDocketEntries = [];
  try {
    allDocketEntries = await fetchDocketEntries(docketId);
  } catch(e) {
    debug.warnings.push(`fetchDocketEntries failed: ${e.message || JSON.stringify(e).slice(0,80)}`);
  }
  if (!allDocketEntries.length) debug.missingData.push("No docket entries returned");

  // 5a. Petition document candidates (reuses prefetched entries)
  let petitionDocuments = [];
  try {
    petitionDocuments = await findPetitionDocuments(docketId, allDocketEntries);
  } catch(e) {
    debug.warnings.push(`findPetitionDocuments failed: ${e.message}`);
  }
  if (!petitionDocuments.length) {
    debug.warnings.push("No petition docket entry found.");
    debug.nextBestActions.push("Manual review of CourtListener docket recommended.");
  }

  // 5b. NEW — parse free description text for attorney/trustee/deadlines
  const docketParse = parseDocketEntries(allDocketEntries);
  if (docketParse.warnings.length) debug.warnings.push(...docketParse.warnings);

  // 6. Fetch petition text from top RECAP documents
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

    if (textResult.available && textResult.text && !petitionFields.signerName) {
      petitionFields = extractPetitionFields(textResult.text);
    }
  }

  if (petitionDocumentsWithText === 0) {
    debug.warnings.push("Petition document found but no plain text available.");
    debug.nextBestActions.push("Docket-description data (attorney/trustee/deadlines) still extracted; PDF-level detail unavailable.");
  }

  // 7. Principals
  const normParties       = normalizeParties(parties);
  const attorneysFromApi  = normalizeAttorneys(attorneys, parties);
  const normAttorneys     = mergeParsedAttorneys(attorneysFromApi, docketParse, debug);
  const principals        = extractPrincipals({ parties: normParties, petitionFields });

  if (!principals.length) {
    debug.warnings.push("Principal not found in petition text.");
    debug.nextBestActions.push("Manual review of petition PDF recommended to identify signer.");
  }

  // 8. Sub-V classification — now sees ALL entry descriptions, not just
  //    petition candidates (e.g. "Meeting of Creditors Chapter 11 Subchapter V")
  const docketEntriesForClassifier = allDocketEntries.map(e => ({ description: e.description || "" }));
  const subchapterV = classifySubchapterV({
    docket,
    bankruptcyInformation: bkData,
    parties: normParties,
    attorneys: normAttorneys,
    docketEntries: docketEntriesForClassifier
  });

  // 9. Trustee — metadata > docket description > parties
  const trustee = extractTrustee(parties, bkData, docketParse, debug);
  if (!trustee.name) debug.missingData.push("Trustee not found in metadata, docket descriptions, or parties.");

  // 10. Debtor
  const debtor = {
    name:    petitionFields.debtorName || docket.case_name || "",
    address: petitionFields.debtorAddress || null,
    email:   petitionFields.debtorEmail || null,
    phone:   petitionFields.debtorPhone || null,
    source:  petitionFields.debtorName ? "Petition text" : "Docket case_name",
    confidence: petitionFields.debtorName ? "HIGH" : "MEDIUM"
  };

  // 11. Assemble case
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
    docketDeadlines:   docketParse.deadlines,   // NEW: 341, plan due, POC bar dates
    docketParse: {                              // NEW: full parse w/ evidence for the UI
      trustee:          docketParse.trustee,
      attorneys:        docketParse.attorneys,
      filerSignatures:  docketParse.filerSignatures
    },
    outreachContacts:  [],
    debug,
    rawCounts: {
      bankruptcyInformationCount: bkData ? 1 : 0,
      partiesCount:               parties.length,
      attorneysCount:             normAttorneys.length,
      docketEntriesCount:         allDocketEntries.length,
      petitionDocumentsCount:     petitionDocumentsOut.length,
      petitionDocumentsWithTextCount: petitionDocumentsWithText,
      principalsCount:            principals.length,
      outreachContactsCount:      0
    }
  };

  hydratedCase.outreachContacts = buildOutreachContacts(hydratedCase);
  hydratedCase.rawCounts.outreachContactsCount = hydratedCase.outreachContacts.length;

  logger.info(
    `Hydration complete for ${docketId}: ${principals.length} principals, ${normAttorneys.length} attorneys, ` +
    `trustee=${trustee.name || "none"}, deadlines=[${Object.keys(docketParse.deadlines).join(",") || "none"}], ` +
    `${petitionDocumentsWithText} docs with text`
  );
  return hydratedCase;
}

module.exports = { hydrateDocket };
