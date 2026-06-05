const { clGetJson, getAllPages } = require("./courtListenerClient");
const { classifySubchapterV }   = require("./subchapterVClassifier");
const logger = require("./logger");

async function safeGet(path, label) {
  try {
    return await clGetJson(path);
  } catch(e) {
    logger.warn(`Hydration fetch failed [${label}]: ${e.message || JSON.stringify(e).slice(0,100)}`);
    return null;
  }
}

async function safeList(path, params, label) {
  try {
    return await getAllPages(path, params, { maxPages: 3 });
  } catch(e) {
    logger.warn(`Hydration list failed [${label}]: ${e.message || JSON.stringify(e).slice(0,100)}`);
    return [];
  }
}

function extractTrustee(parties) {
  const trusteeParty = (parties || []).find(p => {
    const role = (p.party_types || []).map(t => (t.name||"").toLowerCase()).join(" ");
    return role.includes("trustee");
  });
  if (!trusteeParty) return { name: null, raw: null, source: null };
  return {
    name:   trusteeParty.name || null,
    raw:    JSON.stringify(trusteeParty).slice(0, 200),
    source: "CourtListener /parties"
  };
}

function normalizeParties(parties) {
  return (parties || []).map(p => ({
    id:          p.id        || null,
    name:        p.name      || "",
    type:        p.party_types ? p.party_types.map(t => t.name).join(", ") : "",
    role:        p.party_types ? p.party_types.map(t => t.name).join(", ") : "",
    extraInfo:   p.extra_info || null,
    attorneyIds: (p.attorneys || []).map(a => a.id || a),
    source:      "CourtListener /parties"
  }));
}

function normalizeAttorneys(attorneys, parties) {
  // Find which parties each attorney represents
  const attyToParties = {};
  (parties || []).forEach(p => {
    (p.attorneys || []).forEach(a => {
      const aid = a.id || a;
      if (!attyToParties[aid]) attyToParties[aid] = [];
      attyToParties[aid].push(p.name);
    });
  });

  return (attorneys || []).map(a => {
    // Parse contact block for email/phone
    const contact = a.contact_raw || a.contact || "";
    const emailMatch = contact.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    const phoneMatch = contact.match(/[\d\s().+-]{7,20}/);

    return {
      id:           a.id   || null,
      name:         a.name || "",
      firm:         a.firm_name || null,
      email:        emailMatch ? emailMatch[0] : null,
      phone:        phoneMatch ? phoneMatch[0].trim() : null,
      fax:          null,
      contactRaw:   contact || null,
      representing: attyToParties[a.id] || [],
      source:       "CourtListener /attorneys"
    };
  });
}

function extractPossiblePrincipals(parties) {
  // Only return parties that are explicitly labeled as individuals / principals
  const principalRoles = ["debtor", "officer", "director", "member", "principal", "owner", "partner"];
  return (parties || [])
    .filter(p => {
      const roles = (p.party_types || []).map(t => (t.name||"").toLowerCase()).join(" ");
      return principalRoles.some(r => roles.includes(r));
    })
    .map(p => ({
      name:       p.name,
      role:       (p.party_types || []).map(t => t.name).join(", "),
      source:     "CourtListener /parties",
      confidence: "data-derived"
    }));
}

function normalizeDocketEntries(entries) {
  return (entries || []).map(e => ({
    id:               e.id              || null,
    dateFiled:        e.date_filed      || null,
    description:      e.description     || e.entry_number_and_description || "",
    documentNumber:   e.entry_number    || null,
    recapDocumentId:  e.recap_documents ? (e.recap_documents[0]?.id || null) : null,
    source:           "CourtListener /docket-entries"
  }));
}

async function hydrateDocket(docketId) {
  logger.info(`Hydrating docket ${docketId}`);

  // 1. Docket details
  const docket = await safeGet(`/api/rest/v4/dockets/${docketId}/`, "docket");
  if (!docket || docket._clError) {
    return { docketId, error: "Could not fetch docket", _clStatus: docket?._clStatus };
  }

  // 2. Bankruptcy metadata
  const bkInfo = await safeGet(
    `/api/rest/v4/bankruptcy-information/?docket=${docketId}`,
    "bankruptcy-info"
  );
  const bkData = bkInfo?.results?.[0] || null;

  // 3. Parties
  const parties = await safeList("/api/rest/v4/parties/", { docket: docketId }, "parties");

  // 4. Attorneys
  const attorneys = await safeList(
    "/api/rest/v4/attorneys/",
    { docket: docketId, filter_nested_results: "True" },
    "attorneys"
  );

  // 5. Docket entries (first 2 pages = ~40 entries)
  const docketEntries = await safeList(
    "/api/rest/v4/docket-entries/",
    { docket: docketId, order_by: "-date_filed" },
    "docket-entries"
  );

  // Classification
  const subchapterV = classifySubchapterV({
    docket, bankruptcyInformation: bkData, parties, attorneys, docketEntries
  });

  // Trustee
  const trustee = extractTrustee(parties);

  return {
    docketId,
    caseName:     docket.case_name      || "",
    debtorName:   docket.case_name      || "",
    docketNumber: docket.docket_number  || "",
    courtId:      docket.court_id       || "",
    courtName:    docket.court          || "",
    dateFiled:    docket.date_filed     || "",
    absoluteUrl:  docket.absolute_url
      ? "https://www.courtlistener.com" + docket.absolute_url : "",
    chapter:      bkData?.chapter       || docket.chapter || null,
    trustee,
    parties:           normalizeParties(parties),
    attorneys:         normalizeAttorneys(attorneys, parties),
    possiblePrincipals:extractPossiblePrincipals(parties),
    docketEntries:     normalizeDocketEntries(docketEntries),
    subchapterV,
    raw: {
      docket:                      docket,
      bankruptcyInformationPreview:bkData ? JSON.stringify(bkData).slice(0, 500) : null,
      partiesCount:                parties.length,
      attorneysCount:              attorneys.length,
      docketEntriesCount:          docketEntries.length,
    }
  };
}

module.exports = { hydrateDocket };
