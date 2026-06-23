function containsSubV(str) {
  if (!str) return false;
  const s = str.toLowerCase();
  return s.includes("subchapter v") || s.includes("subchapter 5") ||
    s.includes("sub chapter v") || s.includes("election of subchapter") ||
    s.includes("small business debtor");
}

function classifySubchapterV({ docket, bankruptcyInformation, parties, attorneys, docketEntries }) {
  const reasons = [];
  let score = 0;

  // Chapter check — must be 11, unless docket entries confirm Sub-V + Chapter 11 explicitly
  const chapter = docket?.chapter || bankruptcyInformation?.chapter || "";

  const descriptionConfirmsSubV = (docketEntries || []).some(e => {
    const d = (e.description || "").toLowerCase();
    return d.includes("subchapter v") && d.includes("chapter 11") && !d.includes("chapter 7");
  });

  if (String(chapter) !== "11" && !descriptionConfirmsSubV) {
    return { isLikely: false, confidence: "NONE", reasons: [`Chapter is ${chapter || "unknown"}, not 11`] };
  }

  if (descriptionConfirmsSubV && String(chapter) !== "11") {
    reasons.push("Docket entry description confirms Chapter 11 Subchapter V (overriding metadata chapter field)");
    score += 80;
  }

  // HIGH: explicit Sub-V flag in bankruptcy metadata
  if (bankruptcyInformation?.is_subchapter_v === true) {
    reasons.push("CourtListener bankruptcy metadata: is_subchapter_v = true");
    score += 100;
  }

  // HIGH: case name or docket description mentions Sub-V
  if (containsSubV(docket?.case_name)) {
    reasons.push("Case name contains Subchapter V indicator");
    score += 50;
  }

  // MEDIUM: docket entries mention Sub-V
  const entryHits = (docketEntries || []).filter(e => containsSubV(e.description));
  if (entryHits.length > 0) {
    reasons.push(`${entryHits.length} docket entry/entries mention Subchapter V`);
    score += 30;
  }

  // MEDIUM: parties or attorneys mention Sub-V in their info
  const partyHit = (parties || []).some(p => containsSubV(p.extra_info) || containsSubV(p.name));
  if (partyHit) {
    reasons.push("Party record mentions Subchapter V");
    score += 20;
  }

  // LOW: just Chapter 11, no other signals
  if (score === 0) {
    reasons.push("Chapter 11 but no explicit Subchapter V indicators found");
    score = 5;
  }

  let confidence;
  if (score >= 80)      confidence = "HIGH";
  else if (score >= 30) confidence = "MEDIUM";
  else                  confidence = "LOW";

  return { isLikely: score >= 30, confidence, reasons };
}

module.exports = { classifySubchapterV };
