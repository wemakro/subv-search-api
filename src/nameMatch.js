"use strict";
// Shared name normalization and matching.
// Used to keep case attorneys out of the principal/owner slot: the same person
// arrives formatted differently across sources ("John A. Smith" from
// CourtListener vs "/s/ John Smith" from petition text vs "John Smith, Esq."),
// so comparisons match on normalized first + last name.

const SUFFIX_TOKENS = new Set([
  "esq", "esquire", "jd", "jr", "sr", "ii", "iii", "iv",
  "pllc", "llp", "cpa", "md", "dds",
]);

function nameTokens(name) {
  if (!name) return [];
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s'\-]/gi, " ")
    .split(/\s+/)
    .filter(function(t) { return t && !SUFFIX_TOKENS.has(t); });
}

// True when `longer` contains `shorter` as a contiguous token run
function containsRun(longer, shorter) {
  if (shorter.length < 2 || shorter.length > longer.length) return false;
  outer: for (let i = 0; i <= longer.length - shorter.length; i++) {
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) continue outer;
    }
    return true;
  }
  return false;
}

// True when two names refer to the same person: same first + last name,
// ignoring middle names/initials, punctuation, and professional suffixes.
// Also matches a person name embedded in a firm-style string
// ("John Smith" vs "Law Offices of John Smith" / "John Smith & Associates").
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const fa = ta.filter(function(t) { return t.length > 1; });
  const fb = tb.filter(function(t) { return t.length > 1; });
  if (fa.length >= 2 && fb.length >= 2) {
    if (fa[0] === fb[0] && fa[fa.length - 1] === fb[fb.length - 1]) return true;
    return fa.length <= fb.length ? containsRun(fb, fa) : containsRun(fa, fb);
  }
  // Not enough usable tokens for first+last — require full equality
  return ta.join(" ") === tb.join(" ");
}

function matchesAnyName(name, names) {
  return (names || []).some(function(n) { return namesMatch(name, n); });
}

module.exports = { nameTokens, namesMatch, matchesAnyName };
