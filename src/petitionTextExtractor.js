// Extracts structured fields from petition plain text
// Conservative: only returns values with surrounding evidence

const { namesMatch } = require("./nameMatch");

const NAME_PATTERN = /[A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]+){1,4}/;
// First and last tokens must be full words; middle tokens may be bare
// initials ("John Q Public" — OCR often drops the period)
const FULL_NAME_PATTERN = /^[A-Z][a-zA-Z'\-\.]+(?:\s+[A-Z][a-zA-Z'\-\.]*){0,3}\s+[A-Z][a-zA-Z'\-\.]+$/;

// Captured strings containing form language are not a person's name
const NON_NAME_WORDS = /\b(signature|authorized|representative|petition|debtor|behalf|executed|declaration|penalty|perjury|title|date|form|case|number|court|chapter)\b/i;

// Signals that a signature/name sits in the attorney's block, not the debtor's.
// Official petition forms carry BOTH the debtor representative's signature and
// the attorney's /s/ e-signature — and scanned petitions where the debtor
// signed by hand often have ONLY the attorney's /s/ in the text layer.
const ATTORNEY_CONTEXT = /\battorneys?\b|\bcounsel\b|\besq\.?\b|\besquire\b|bar\s*(?:no|number|#)|law\s+(?:firm|office|offices|group)|\bpllc\b|\bllp\b/i;
const DEBTOR_SIGNER_CONTEXT = /authorized\s+representative|signature\s+of\s+debtor|on\s+behalf\s+of\s+the\s+debtor|position\s+or\s+relationship\s+to\s+debtor|authorized\s+to\s+file|declaration\s+under\s+penalty/i;

const FIELD_PATTERNS = [
  // Signer / authorized representative
  {
    field: "signerName",
    nameField: true,
    patterns: [
      // Name must stay on one line (a \s separator would swallow the
      // printed-name line and "Title:" label below the signature), but one
      // newline directly after /s/ is allowed — common in conformed
      // signatures. Middle tokens may be bare initials.
      /\/s\/[ \t]*\r?\n?[ \t]*([A-Z][a-zA-Z'\-\.]+(?:[ \t]+[A-Z][a-zA-Z'\-\.]*){1,4})/,
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
    nameField: true,
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

// Decides whether a name match sits in the attorney's signature block or the
// debtor's. Block headers precede signatures on the official forms, so the
// nearest header BEFORE the match decides; an "Esq."/bar-number right after
// the name is an attorney giveaway regardless of headers.
function classifyNameContext(text, idx, matchLen) {
  const afterName = text.slice(idx, Math.min(text.length, idx + matchLen + 80));
  if (/\b(esq\.?|esquire)\b|bar\s*(?:no|number|#)/i.test(afterName)) return "attorney";

  // 500-char back-window: the perjury declaration between the debtor-signer
  // header and the actual /s/ line regularly exceeds 300 chars
  const before = text.slice(Math.max(0, idx - 500), idx);
  let attorneyPos = -1, debtorPos = -1, m;
  const attRe = new RegExp(ATTORNEY_CONTEXT.source, "gi");
  while ((m = attRe.exec(before)) !== null) attorneyPos = m.index;
  const debRe = new RegExp(DEBTOR_SIGNER_CONTEXT.source, "gi");
  while ((m = debRe.exec(before)) !== null) debtorPos = m.index;

  if (attorneyPos > debtorPos) return "attorney";
  if (debtorPos > -1) return "debtor";
  return "neutral";
}

function extractField(text, fieldDef) {
  if (!fieldDef.nameField) {
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

  // Person-name fields: scan EVERY match of every pattern (not just the
  // first), drop any that sit in an attorney signature block, and prefer
  // matches near debtor-signer language. The first-match-wins approach used
  // to return the attorney's /s/ e-signature as the petition signer.
  const candidates = [];
  fieldDef.patterns.forEach(function(pattern, patternRank) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const regex = new RegExp(pattern.source, flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index === regex.lastIndex) regex.lastIndex++;
      const val = (match[1] || match[0]).trim().replace(/\s+/g, " ");
      if (val.length < 3 || val.length > 150) continue;
      if (!FULL_NAME_PATTERN.test(val) || NON_NAME_WORDS.test(val)) continue;
      const context = classifyNameContext(text, match.index, match[0].length);
      if (context === "attorney") continue;
      const snippet = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60).replace(/\n/g, " ");
      candidates.push({
        value: val, snippet,
        index: match.index,
        patternRank,
        inDebtorBlock: context === "debtor",
      });
    }
  });
  if (!candidates.length) return null;
  candidates.sort(function(a, b) {
    if (a.inDebtorBlock !== b.inDebtorBlock) return a.inDebtorBlock ? -1 : 1;
    if (a.patternRank !== b.patternRank) return a.patternRank - b.patternRank;
    return a.index - b.index;
  });
  return candidates[0];
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
      if (/\b(the|this|said|above|below|within|herein|debtor|court|case|chapter|section|esq|esquire|attorney|attorneys|counsel|law|llp|pllc)\b/i.test(name)) continue;
      if (classifyNameContext(text, match.index, match[0].length) === "attorney") continue;
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

  let signerIndex = null;
  for (const fieldDef of FIELD_PATTERNS) {
    if (fieldDef.field === "signerTitle") continue; // anchored to the signer below
    const found = extractField(text, fieldDef);
    if (found) {
      result[fieldDef.field] = found.value;
      if (fieldDef.field === "signerName" && typeof found.index === "number") signerIndex = found.index;
      result.evidenceSnippets.push({
        field: fieldDef.field,
        value: found.value,
        snippet: found.snippet
      });
    }
  }

  // signerTitle: only look near the accepted signer, never across the whole
  // document — a doc-wide search used to pick up titles from other blocks
  if (result.signerName && signerIndex !== null) {
    const titleDef = FIELD_PATTERNS.find(f => f.field === "signerTitle");
    const window = text.slice(Math.max(0, signerIndex - 200), signerIndex + 400);
    const foundTitle = extractField(window, { field: "signerTitle", patterns: titleDef.patterns });
    if (foundTitle && !ATTORNEY_CONTEXT.test(foundTitle.value)) {
      result.signerTitle = foundTitle.value;
      result.evidenceSnippets.push({ field: "signerTitle", value: foundTitle.value, snippet: foundTitle.snippet });
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

  // Never return the case attorney as a signer or principal candidate
  if (result.attorneyName) {
    if (result.signerName && namesMatch(result.signerName, result.attorneyName)) {
      delete result.signerName;
      delete result.signerTitle;
    }
    if (result.authorizedRepresentativeName && namesMatch(result.authorizedRepresentativeName, result.attorneyName)) {
      delete result.authorizedRepresentativeName;
      delete result.authorizedRepresentativeTitle;
    }
    if (result.principalCandidates) {
      result.principalCandidates = result.principalCandidates.filter(c => !namesMatch(c.name, result.attorneyName));
      if (!result.principalCandidates.length) delete result.principalCandidates;
    }
    if (result.ownerNames) {
      result.ownerNames = result.ownerNames.filter(n => !namesMatch(n, result.attorneyName));
      if (!result.ownerNames.length) delete result.ownerNames;
    }
  }

  return result;
}

module.exports = { extractPetitionFields };
