// src/nameSanityFilter.js
//
// Rejects "names" that are actually PDF form labels or legal boilerplate
// scraped by the petition text extractor (e.g. "City State ZIP Code",
// "Official Form", "among other things", "the debtor.").
//
// Also REPAIRS salvageable names: "Peter Kravitz\n  Signature of" becomes
// "Peter Kravitz" (take the first line, then validate).
//
// This runs DOWNSTREAM of extraction (in hydration and contact building),
// so the extractor files themselves don't need to change.

// Words that never appear in a real person's or company's name but appear
// constantly in bankruptcy form labels and boilerplate.
const FORM_WORD_RE = new RegExp(
  "\\b(city|state|zip|code|street|number|county|mailing|address|location|" +
  "principal place|official form|form \\d|bankruptcy|federal rules|rules|" +
  "signature|printed name|title|debtor|creditor|petition|schedule|declaration|" +
  "among other things|authorized agent|page|document|district|court|clerk|" +
  "united states|u\\.?s\\.?\\s*trustee|trustee program|attachment|exhibit|" +
  "check one|fill in|if known|if any|see instructions)\\b",
  "i"
);

// Entity suffixes that make a multi-word ENTITY name acceptable
const ENTITY_SUFFIX_RE = /\b(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|Ltd\.?|Co\.?|Company|LLP|L\.P\.|LP|PSC|P\.S\.C\.|PC|P\.C\.|PLLC|PA|P\.A\.)$/i;

// First line only, collapsed whitespace, trailing punctuation stripped.
function sanitizeName(raw) {
  if (!raw) return null;
  const firstLine = String(raw).split("\n").map(s => s.trim()).find(s => s.length > 0) || "";
  const cleaned = firstLine.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
  return cleaned || null;
}

// A plausible PERSON name: 2-5 words, letters only, 5-40 chars, no form words.
function isPlausiblePersonName(raw) {
  const name = sanitizeName(raw);
  if (!name) return false;
  if (name.length < 5 || name.length > 40) return false;
  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (FORM_WORD_RE.test(name)) return false;
  if (!/^[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*)+$/.test(name)) return false;
  return true;
}

// A plausible CONTACT name: a person name, OR an entity name ending in a
// business suffix (LLC, Inc, Corp, ...). Used for principals/owners where
// the debtor company itself is a legitimate record.
function isPlausibleContactName(raw) {
  const name = sanitizeName(raw);
  if (!name) return false;
  if (isPlausiblePersonName(name)) return true;
  // Entity path: allow form-word test to be skipped ONLY for the suffix check,
  // but still reject obvious boilerplate.
  if (name.length < 4 || name.length > 60) return false;
  if (!ENTITY_SUFFIX_RE.test(name)) return false;
  // Even entities must not contain hard boilerplate markers
  if (/official form|bankruptcy rules|federal rules|signature|printed name|check one/i.test(name)) return false;
  return true;
}

// Filter + repair a list of principal/contact records in place.
// Returns { kept, removed } where removed carries the reason for the debug log.
function filterPrincipals(principals) {
  const kept = [];
  const removed = [];
  for (const p of (principals || [])) {
    const fixed = sanitizeName(p.name);
    if (fixed && isPlausibleContactName(fixed)) {
      kept.push({ ...p, name: fixed });
    } else {
      removed.push({ name: p.name, reason: "failed name sanity check" });
    }
  }
  return { kept, removed };
}

module.exports = { sanitizeName, isPlausiblePersonName, isPlausibleContactName, filterPrincipals };
