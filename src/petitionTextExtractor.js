// Extracts structured fields from petition plain text
// Conservative: only returns values with surrounding evidence

const NAME_PATTERN = /[A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,4}/;

const FIELD_PATTERNS = [
  // Signer / authorized representative
  {
    field: "signerName",
    patterns: [
      /\/s\/\s+([A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,4})/,
      /signature\s+of\s+authorized\s+representative[^\n]{0,80}\n([^\n]{3,80})/i,
      /signature\s+of\s+debtor[^\n]{0,80}\n([^\n]{3,80})/i,
      /i\s+have\s+been\s+authorized\s+to\s+file[^\n]{0,200}(?:by|on behalf of)\s+([A-Z][^\n,]{3,60})/i,
      /authorized\s+(?:representative|signatory)[^\n]{0,60}\n([^\n]{3,80})/i,
      /printed\s+name\s+of\s+authorized\s+representative[:\s\n]+([^\n,]{3,80})/i,
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
  {
    field: "attorneyName",
    patterns: [
      /name\s+of\s+attorney[:\s\n]+([^\n,]{3,80})/i,
      /attorney\s+for\s+debtor[:\s\n]+([^\n,]{3,80})/i,
      /debtor['s\s]+attorney[:\s\n]+([^\n,]{3,80})/i,
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
      /attorney[^\n]{0,50}phone[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i,
      /attorney[^\n]{0,50}telephone[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i,
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

function extractPetitionFields(text) {
  if (!text || text.length < 50) {
    return { _empty: true, evidenceSnippets: [] };
  }

  const result = { evidenceSnippets: [] };

  for (const fieldDef of FIELD_PATTERNS) {
    const found = extractField(text, fieldDef);
    if (found) {
      result[fieldDef.field] = found.value;
      result.evidenceSnippets.push({
        field: fieldDef.field,
        value: found.value,
        snippet: found.snippet
      });
    }
  }

  // Role-near-name extraction for principalCandidates
  const roleCandidates = extractRolesNearNames(text);
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

  // Owner names from "List of Equity Security Holders" section
  const equitySection = text.match(/equity\s+security\s+holders[\s\S]{0,2000}/i);
  if (equitySection) {
    const names = [...equitySection[0].matchAll(/([A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,3})\s+\d+[\.\s]/g)];
    if (names.length > 0) {
      result.ownerNames = names.map(m => m[1].trim());
    }
  }

  return result;
}

module.exports = { extractPetitionFields };
