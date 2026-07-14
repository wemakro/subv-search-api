// src/petitionTextExtractor.js
// Extracts structured fields from petition plain text.
// Conservative: only returns values with surrounding evidence.
//
// v2 CHANGES:
// - Attorney signature blocks are located and BLANKED before extracting
//   debtor/signer fields, so the attorney's name and phone can never be
//   attributed to the owner.
// - Every extracted name is cross-checked against the case's known
//   attorney list (passed in from hydration) and rejected on match.
// - Attorney fields are extracted FIRST from the full text, then the
//   attorney regions are removed for all remaining extraction.

const NAME_PATTERN = /[A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,4}/;

// Regions of the document that belong to the attorney — these get blanked
// before any owner/signer extraction runs.
const ATTORNEY_REGION_PATTERNS = [
  /signature\s+of\s+attorney[\s\S]{0,700}/gi,
  /attorney\s+for\s+(?:the\s+)?debtor\(?s?\)?[\s\S]{0,500}/gi,
  /\/s\/\s*[A-Z][^\n]{2,60}\n[^\n]{0,80}(?:bar\s+(?:no|number)|esq)[\s\S]{0,300}/gi,
  /counsel\s+for\s+(?:the\s+)?debtor[\s\S]{0,400}/gi,
];

// Signals that a name string is an attorney, not a business owner
const ATTORNEY_NAME_SIGNALS = [
  /\besq\.?\b/i, /\bj\.?d\.?\b/i, /\battorney\b/i, /\bcounsel\b/i,
  /\blaw\s+(?:firm|office|group|offices)\b/i, /\bllp\b/i, /\bpllc\b/i,
  /\bp\.?c\.?\b/i, /\bbar\s+(?:no|number)\b/i, /\blawyer\b/i,
];

const FIELD_PATTERNS = [
  {
    field: "signerName",
    patterns: [
      /signature\s+of\s+authorized\s+representative[^\n]{0,80}\n([^\n]{3,80})/i,
      /signature\s+of\s+debtor[^\n]{0,80}\n([^\n]{3,80})/i,
      /i\s+have\s+been\s+authorized\s+to\s+file[^\n]{0,200}(?:by|on behalf of)\s+([A-Z][^\n,]{3,60})/i,
      /authorized\s+(?:representative|signatory)[^\n]{0,60}\n([^\n]{3,80})/i,
    ]
  },
  {
    field: "signerTitle",
    patterns: [
      /title[:\s]+([^\n,]{3,60})/i,
      /(?:managing\s+member|sole\s+member|president|ceo|chief\s+executive|owner|manager|partner|principal|authorized\s+representative)[^\n]{0,30}/i,
    ]
  },
  {
    field: "authorizedRepresentativeName",
    patterns: [
      /name\s+of\s+authorized\s+representative[:\s\n]+([^\n,]{3,80})/i,
      /printed\s+name[:\s\n]+([^\n,]{3,80})/i,
    ]
  },
  {
    field: "authorizedRepresentativeTitle",
    patterns: [
      /position\s+or\s+relationship\s+to\s+debtor[:\s\n]+([^\n,]{3,80})/i,
    ]
  },
  {
    field: "debtorName",
    patterns: [
      /debtor['s\s]+name[:\s\n]+([^\n,]{3,100})/i,
      /name\s+of\s+debtor[:\s\n]+([^\n,]{3,100})/i,
    ]
  },
  {
    field: "debtorAddress",
    patterns: [
      /principal\s+place\s+of\s+business[:\s\n]+([^\n]{10,150})/i,
      /mailing\s+address[:\s\n]+([^\n]{10,150})/i,
      /address[:\s\n]+([^\n]{10,150})/i,
    ]
  },
  {
    field: "debtorPhone",
    patterns: [
      /telephone[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i,
      /phone[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i,
    ]
  },
  {
    field: "debtorEmail",
    patterns: [
      /email[:\s]+([\w.+-]+@[\w\-]+\.[a-z]{2,})/i,
    ]
  },
];

// Attorney fields are extracted from the FULL text before blanking
const ATTORNEY_FIELD_PATTERNS = [
  {
    field: "attorneyName",
    patterns: [
      /name\s+of\s+attorney[:\s\n]+([^\n,]{3,80})/i,
      /attorney\s+for\s+debtor[:\s\n]+([^\n,]{3,80})/i,
      /debtor['s\s]+attorney[:\s\n]+([^\n,]{3,80})/i,
      /signature\s+of\s+attorney[^\n]{0,80}\n([^\n]{3,80})/i,
    ]
  },
  {
    field: "attorneyFirm",
    patterns: [
      /firm\s+name[:\s\n]+([^\n,]{3,100})/i,
      /law\s+firm[:\s\n]+([^\n,]{3,100})/i,
    ]
  },
  {
    field: "attorneyEmail",
    patterns: [
      /attorney[^\n]{0,50}email[:\s]+([\w.+-]+@[\w\-]+\.[a-z]{2,})/i,
    ]
  },
  {
    field: "attorneyPhone",
    patterns: [
      /attorney[^\n]{0,50}(?:phone|telephone)[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i,
    ]
  },
];

const ROLE_PATTERNS = [
  { role: "Managing Member",            pattern: /managing\s+member/i },
  { role: "Sole Member",                pattern: /sole\s+member/i },
  { role: "President",                  pattern: /\bpresident\b/i },
  { role: "CEO",                        pattern: /\b(?:ceo|chief\s+executive\s+officer)\b/i },
  { role: "Owner",                      pattern: /\bowner\b/i },
  { role: "Authorized Representative",  pattern: /authorized\s+representative/i },
  { role: "Authorized Signatory",       pattern: /authorized\s+signatory/i },
  { role: "Manager",                    pattern: /\bmanager\b/i },
  { role: "Managing Partner",           pattern: /managing\s+partner/i },
  { role: "Principal",                  pattern: /\bprincipal\b/i },
  { role: "Member",                     pattern: /\bmember\b/i },
  { role: "Treasurer",                  pattern: /\btreasurer\b/i },
  { role: "Secretary",                  pattern: /\bsecretary\b/i },
];

// ── Name normalization + attorney matching ─────────────────────────────────
function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\b(esq\.?|jr\.?|sr\.?|ii|iii|iv|j\.?d\.?)\b/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb || na.length < 4 || nb.length < 4) return false;
  if (na === nb) return true;
  // One fully contains the other (handles middle names/initials)
  if (na.includes(nb) || nb.includes(na)) return true;
  // Same last name + same first initial
  const pa = na.split(" "), pb = nb.split(" ");
  if (pa.length >= 2 && pb.length >= 2) {
    if (pa[pa.length-1] === pb[pb.length-1] && pa[0][0] === pb[0][0]) return true;
  }
  return false;
}

function isAttorneyName(name, knownAttorneyNames) {
  if (!name) return false;
  // Signal words in the name string itself
  if (ATTORNEY_NAME_SIGNALS.some(p => p.test(name))) return true;
  // Cross-check against the case's known attorney list
  return (knownAttorneyNames || []).some(a => namesMatch(name, a));
}

// ── Blank attorney regions so owner extraction can't touch them ────────────
function stripAttorneyRegions(text) {
  let cleaned = text;
  for (const pattern of ATTORNEY_REGION_PATTERNS) {
    cleaned = cleaned.replace(pattern, match => " ".repeat(match.length));
  }
  return cleaned;
}

function extractField(text, fieldDef) {
  for (const pattern of fieldDef.patterns) {
    const match = text.match(pattern);
    if (match) {
      const val = (match[1] || match[0]).trim().replace(/\s+/g, " ");
      if (val.length >= 3 && val.length <= 150) {
        const idx = text.indexOf(match[0]);
        const snippet = text.slice(Math.max(0, idx - 60), idx + match[0].length + 60).replace(/\n/g, " ");
        return { value: val, snippet };
      }
    }
  }
  return null;
}

function extractRolesNearNames(text) {
  const candidates = [];
  for (const { role, pattern } of ROLE_PATTERNS) {
    const regex = new RegExp(
      `([A-Z][a-zA-Z'\\-\\.]+(?:\\s+[A-Z][a-zA-Z'\\-\\.]+){1,4})[^\\n]{0,40}${pattern.source}|${pattern.source}[^\\n]{0,40}([A-Z][a-zA-Z'\\-\\.]+(?:\\s+[A-Z][a-zA-Z'\\-\\.]+){1,4})`,
      "gi"
    );
    let match;
    while ((match = regex.exec(text)) !== null) {
      const name = (match[1] || match[2] || "").trim();
      if (name.length < 4 || name.split(" ").length < 2) continue;
      if (/\b(the|this|said|above|below|within|herein|debtor|court|case|chapter|section)\b/i.test(name)) continue;
      const idx = match.index;
      const snippet = text.slice(Math.max(0, idx - 40), idx + match[0].length + 40).replace(/\n/g, " ");
      candidates.push({ name, role, snippet });
    }
  }
  return candidates;
}

// ── MAIN ────────────────────────────────────────────────────────────────────
// options.attorneyNames: array of attorney names from CourtListener /attorneys
// Every extracted owner-side name is rejected if it matches this list.
function extractPetitionFields(text, options) {
  options = options || {};
  const knownAttorneyNames = options.attorneyNames || [];

  if (!text || text.length < 50) {
    return { _empty: true, evidenceSnippets: [] };
  }

  const result = { evidenceSnippets: [] };

  // STEP 1: Extract attorney fields from the FULL text (before blanking)
  for (const fieldDef of ATTORNEY_FIELD_PATTERNS) {
    const found = extractField(text, fieldDef);
    if (found) {
      result[fieldDef.field] = found.value;
      result.evidenceSnippets.push({ field: fieldDef.field, value: found.value, snippet: found.snippet });
    }
  }

  // Add the extracted attorney name to the rejection list
  const rejectList = [...knownAttorneyNames];
  if (result.attorneyName) rejectList.push(result.attorneyName);

  // STEP 2: Blank all attorney regions, then extract owner-side fields
  // from the cleaned text — attorney's name and phone are physically gone.
  const cleaned = stripAttorneyRegions(text);

  for (const fieldDef of FIELD_PATTERNS) {
    const found = extractField(cleaned, fieldDef);
    if (found) {
      result[fieldDef.field] = found.value;
      result.evidenceSnippets.push({ field: fieldDef.field, value: found.value, snippet: found.snippet });
    }
  }

  // STEP 3: Reject any owner-side name that matches an attorney
  for (const nameField of ["signerName", "authorizedRepresentativeName"]) {
    if (result[nameField] && isAttorneyName(result[nameField], rejectList)) {
      result.evidenceSnippets.push({
        field: nameField + "_rejected",
        value: result[nameField],
        snippet: "REJECTED: matches case attorney list"
      });
      delete result[nameField];
    }
  }

  // STEP 4: Role-based candidates from cleaned text, attorney-filtered
  const roleCandidates = extractRolesNearNames(cleaned)
    .filter(c => !isAttorneyName(c.name, rejectList));
  if (roleCandidates.length > 0) {
    result.principalCandidates = roleCandidates;
    roleCandidates.forEach(c => {
      result.evidenceSnippets.push({
        field: "principalCandidate",
        value: `${c.name} (${c.role})`,
        snippet: c.snippet
      });
    });
  }

  // STEP 5: Owner names from "List of Equity Security Holders" section
  const equitySection = cleaned.match(/equity\s+security\s+holders[\s\S]{0,3000}/i);
  if (equitySection) {
    const names = [...equitySection[0].matchAll(/([A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,3})\s+\d+[\.\s%]/g)];
    const ownerNames = names
      .map(m => m[1].trim())
      .filter(n => !isAttorneyName(n, rejectList));
    if (ownerNames.length > 0) result.ownerNames = ownerNames;
  }

  // STEP 6: Corporate Ownership Statement — "X owns 10% or more"
  const cosSection = cleaned.match(/corporate\s+ownership\s+statement[\s\S]{0,2000}|own[s]?\s+10%\s+or\s+more[\s\S]{0,1000}/i);
  if (cosSection) {
    const cosNames = [...cosSection[0].matchAll(/([A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,3})/g)]
      .map(m => m[1].trim())
      .filter(n => n.split(" ").length >= 2)
      .filter(n => !/\b(corporate|ownership|statement|united|states|bankruptcy|court|district|chapter|debtor|form|official|rule)\b/i.test(n))
      .filter(n => !isAttorneyName(n, rejectList))
      .slice(0, 5);
    if (cosNames.length > 0) {
      result.ownerNames = [...new Set([...(result.ownerNames || []), ...cosNames])];
    }
  }

  return result;
}

module.exports = { extractPetitionFields, isAttorneyName, namesMatch };
