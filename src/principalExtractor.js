// src/principalExtractor.js
// Extracts principals from all available evidence sources.
// Priority: petition signer > equity holders > party data.
// Never invents names, emails, or phone numbers.
//
// v2 CHANGES:
// - Accepts the case's attorney list and rejects any principal whose
//   name matches an attorney (final safety net — extraction upstream
//   already filters, this catches anything that slips through).
// - Attorney-signal words in a name or role also cause rejection.

const { isAttorneyName } = require("./petitionTextExtractor");

const HIGH_CONFIDENCE_ROLES = [
  "managing member","sole member","president","ceo","chief executive",
  "owner","authorized representative","authorized signatory",
  "managing partner","principal"
];
const MEDIUM_CONFIDENCE_ROLES = [
  "member","manager","partner","treasurer","secretary","officer","director"
];

function isHighConfidenceRole(role) {
  if (!role) return false;
  const r = role.toLowerCase();
  return HIGH_CONFIDENCE_ROLES.some(h => r.includes(h));
}
function isMediumConfidenceRole(role) {
  if (!role) return false;
  const r = role.toLowerCase();
  return MEDIUM_CONFIDENCE_ROLES.some(h => r.includes(h));
}

function roleLooksLikeAttorney(role) {
  if (!role) return false;
  return /\b(attorney|counsel|esq|lawyer|legal)\b/i.test(role);
}

function fromPetitionFields(petitionFields, attorneyNames) {
  const results = [];
  if (!petitionFields) return results;

  const signerName  = petitionFields.signerName || petitionFields.authorizedRepresentativeName;
  const signerTitle = petitionFields.signerTitle || petitionFields.authorizedRepresentativeTitle;

  if (signerName && signerName.length >= 4
      && !isAttorneyName(signerName, attorneyNames)
      && !roleLooksLikeAttorney(signerTitle)) {
    results.push({
      name:             signerName,
      role:             signerTitle || "Petition Signer",
      title:            signerTitle || null,
      company:          petitionFields.debtorName || null,
      address:          petitionFields.debtorAddress || null,
      email:            petitionFields.debtorEmail || null,
      phone:            petitionFields.debtorPhone || null,
      source:           "Petition text (signer/authorized representative)",
      sourceDocumentId: null,
      sourceUrl:        null,
      confidence:       "HIGH",
      evidence:         petitionFields.evidenceSnippets?.filter(s =>
        ["signerName","authorizedRepresentativeName","signerTitle"].includes(s.field)
      ) || [],
      isPrimary: true
    });
  }

  for (const cand of (petitionFields.principalCandidates || [])) {
    if (!cand.name || cand.name.length < 4) continue;
    if (isAttorneyName(cand.name, attorneyNames)) continue;
    if (roleLooksLikeAttorney(cand.role)) continue;
    const conf = isHighConfidenceRole(cand.role) ? "HIGH"
               : isMediumConfidenceRole(cand.role) ? "MEDIUM" : null;
    if (!conf) continue;
    if (results.some(r => r.name === cand.name)) continue;
    results.push({
      name:       cand.name,
      role:       cand.role,
      title:      cand.role,
      company:    petitionFields.debtorName || null,
      address:    null, email: null, phone: null,
      source:     "Petition text (role extraction)",
      sourceDocumentId: null,
      sourceUrl:  null,
      confidence: conf,
      evidence:   [{ field: "principalCandidate", value: cand.name, snippet: cand.snippet }],
      isPrimary:  false
    });
  }

  // Owner names from equity holders / corporate ownership statement —
  // these come from the ownership documents that hydration now reads.
  for (const name of (petitionFields.ownerNames || [])) {
    if (isAttorneyName(name, attorneyNames)) continue;
    if (results.some(r => r.name === name)) continue;
    results.push({
      name, role: "Equity Security Holder", title: "Owner",
      company: petitionFields.debtorName || null,
      address: null, email: null, phone: null,
      source: "Ownership document (equity security holders / corporate ownership statement)",
      sourceDocumentId: null, sourceUrl: null,
      confidence: "HIGH", // named on an ownership document — strong signal
      evidence: [], isPrimary: false
    });
  }

  return results;
}

function namesEqualLoose(a, b) {
  const clean = s => (s||"").toLowerCase().replace(/[.,']/g,"").replace(/\b(llc|inc|corp|corporation|company|co|lp|llp|ltd)\b/g,"").replace(/\s+/g," ").trim();
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

function fromPartyData(parties, attorneyNames, debtorName) {
  const results = [];
  const principalRoles = [
    "debtor","officer","director","member","principal","owner","partner",
    "authorized representative","managing member","president","ceo"
  ];
  for (const p of (parties || [])) {
    const roleStr = (p.party_types || p.type ? [(p.type||"")] : [])
      .concat((p.party_types || []).map(t => (t.name||"")))
      .join(" ").toLowerCase();
    const isRelevant = principalRoles.some(r => roleStr.includes(r));
    if (!isRelevant) continue;
    if (isAttorneyName(p.name, attorneyNames)) continue;
    if (roleLooksLikeAttorney(roleStr)) continue;
    // The debtor company itself is a party — never a principal contact
    if (namesEqualLoose(p.name, debtorName)) continue;
    const conf = isHighConfidenceRole(roleStr) ? "MEDIUM" : "LOW";
    results.push({
      name:       p.name || "",
      role:       roleStr || "Unknown",
      title:      null,
      company:    null,
      address:    p.extraInfo || p.extra_info || null,
      email:      null, phone: null,
      source:     "CourtListener /parties",
      sourceDocumentId: null, sourceUrl: null,
      confidence: conf,
      evidence:   [{ field: "party", value: p.name, snippet: `Party type: ${roleStr}` }],
      isPrimary:  false
    });
  }
  return results;
}

// attorneys: normalized attorney array from hydration — names are extracted
// here into a rejection list applied to every principal source.
function extractPrincipals({ parties, petitionFields, attorneys, caseName }) {
  const attorneyNames = (attorneys || [])
    .map(a => a.name || "")
    .filter(n => n.length > 3);

  const debtorName = (petitionFields && petitionFields.debtorName) || caseName || "";

  const all = [
    ...fromPetitionFields(petitionFields, attorneyNames),
    ...fromPartyData(parties, attorneyNames, debtorName),
  ].filter(p => !namesEqualLoose(p.name, debtorName));

  // Deduplicate by name
  const seen = new Set();
  const deduped = [];
  for (const p of all) {
    const key = p.name.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); deduped.push(p); }
  }

  // Sort: isPrimary first, then HIGH > MEDIUM > LOW
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  deduped.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return (order[a.confidence]||3) - (order[b.confidence]||3);
  });

  return deduped;
}

module.exports = { extractPrincipals };
