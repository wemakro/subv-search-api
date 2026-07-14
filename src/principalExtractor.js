// Extracts principals from all available evidence sources
// Priority: petition signer > party data > docket entries
// Never invents names, emails, or phone numbers

const { matchesAnyName } = require("./nameMatch");

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

function fromPetitionFields(petitionFields) {
  const results = [];
  if (!petitionFields) return results;

  // Signer / authorized representative — highest confidence
  const signerName = petitionFields.signerName || petitionFields.authorizedRepresentativeName;
  const signerTitle = petitionFields.signerTitle || petitionFields.authorizedRepresentativeTitle;
  if (signerName && signerName.length >= 4) {
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

  // Role-based candidates from petition text
  for (const cand of (petitionFields.principalCandidates || [])) {
    if (!cand.name || cand.name.length < 4) continue;
    const conf = isHighConfidenceRole(cand.role) ? "HIGH"
               : isMediumConfidenceRole(cand.role) ? "MEDIUM" : null;
    if (!conf) continue;
    // Don't duplicate if already captured as signer
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

  // Owner names from equity holders section
  for (const name of (petitionFields.ownerNames || [])) {
    if (results.some(r => r.name === name)) continue;
    results.push({
      name, role: "Equity Security Holder", title: "Owner",
      company: null, address: null, email: null, phone: null,
      source: "Petition text (equity security holders)",
      sourceDocumentId: null, sourceUrl: null,
      confidence: "MEDIUM", evidence: [], isPrimary: false
    });
  }

  return results;
}

function fromPartyData(parties) {
  const results = [];
  const principalRoles = [
    "debtor","officer","director","member","principal","owner","partner",
    "authorized representative","managing member","president","ceo"
  ];
  for (const p of (parties || [])) {
    const roleStr = (p.party_types || []).map(t => (t.name||"").toLowerCase()).join(" ");
    const isRelevant = principalRoles.some(r => roleStr.includes(r));
    if (!isRelevant) continue;
    const conf = isHighConfidenceRole(roleStr) ? "MEDIUM" : "LOW"; // downgrade because party data is less reliable
    results.push({
      name:       p.name || "",
      role:       p.party_types ? p.party_types.map(t => t.name).join(", ") : "Unknown",
      title:      null,
      company:    null,
      address:    p.extra_info || null,
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

function extractPrincipals({ parties, petitionFields, attorneys }) {
  // Case attorneys must never surface as principals, whatever the source
  const attorneyNames = (attorneys || [])
    .map(a => (typeof a === "string" ? a : a && a.name))
    .filter(Boolean);
  if (petitionFields && petitionFields.attorneyName) attorneyNames.push(petitionFields.attorneyName);

  const all = [
    ...fromPetitionFields(petitionFields),
    ...fromPartyData(parties),
  ].filter(p => p.name && !matchesAnyName(p.name, attorneyNames));

  // Deduplicate by name
  const seen = new Set();
  const deduped = [];
  for (const p of all) {
    const key = p.name.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); deduped.push(p); }
  }

  // Sort: HIGH > MEDIUM > LOW, isPrimary first
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  deduped.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return (order[a.confidence]||3) - (order[b.confidence]||3);
  });

  return deduped;
}

module.exports = { extractPrincipals };
