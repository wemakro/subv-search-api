// src/contactExtractionService.js
//
// Builds outreach contacts in priority order.
// Principal first, attorney second, trustee informational only.
//
// FIX: UST attorneys (U.S. Trustee Program lawyers) are EXCLUDED from outreach.
// They appear in /attorneys because they filed documents, but they represent
// the government — not the debtor — and must never be contacted as sales targets.

const UST_RE = /\bu\.?s\.?\s*trustee\b|united states trustee|trustee[-\s]region|trustee program/i;

function isUstAttorney(attorney) {
  // Check contact address block
  if (UST_RE.test(attorney.contactRaw || "")) return true;
  // Check representing list
  if ((attorney.representing || []).some(r => UST_RE.test(r || ""))) return true;
  // Check firm name
  if (UST_RE.test(attorney.firm || "")) return true;
  return false;
}

function buildOutreachContacts(hydratedCase) {
  const contacts = [];
  const { principals, attorneys, trustee, caseName } = hydratedCase;

  // Priority 1 & 2: Principals with contact info, then without
  for (const p of (principals || [])) {
    if (!p.name) continue;
    const hasContact = p.email || p.phone;
    contacts.push({
      contactType:   "principal",
      priority:      hasContact ? 1 : 2,
      name:          p.name,
      organization:  p.company || caseName || "",
      role:          p.role || "",
      title:         p.title || "",
      firm:          null,
      email:         p.email || null,
      phone:         p.phone || null,
      address:       p.address || null,
      source:        p.source,
      sourceUrl:     p.sourceUrl || null,
      sourceDocumentId: p.sourceDocumentId || null,
      confidence:    p.confidence,
      evidence:      p.evidence || [],
      recommendedChannel: p.email ? "email" : p.phone ? "phone" : "manual_lookup",
      notes: hasContact
        ? null
        : "No direct contact info found. Consider manual lookup or contact enrichment after confirming principal identity.",
      consentStatus:    "unknown",
      unsubscribeStatus:"not_sent_yet"
    });
  }

  // Priority 3: Debtor company contact if found in petition
  const { petitionFields } = hydratedCase;
  if (petitionFields?.debtorName && (petitionFields?.debtorEmail || petitionFields?.debtorPhone)) {
    contacts.push({
      contactType:   "debtor",
      priority:      3,
      name:          petitionFields.debtorName,
      organization:  petitionFields.debtorName,
      role:          "Debtor Company",
      title:         null,
      firm:          null,
      email:         petitionFields.debtorEmail || null,
      phone:         petitionFields.debtorPhone || null,
      address:       petitionFields.debtorAddress || null,
      source:        "Petition text",
      sourceUrl:     null,
      sourceDocumentId: null,
      confidence:    "MEDIUM",
      evidence:      [],
      recommendedChannel: petitionFields.debtorEmail ? "email" : "phone",
      notes:         "Debtor company contact from petition.",
      consentStatus:    "unknown",
      unsubscribeStatus:"not_sent_yet"
    });
  }

  // Priority 4: Debtor attorneys — EXCLUDING UST attorneys
  for (const a of (attorneys || [])) {
    if (!a.name) continue;

    // Skip U.S. Trustee Program attorneys — they are government lawyers,
    // not outreach targets
    if (isUstAttorney(a)) continue;

    contacts.push({
      contactType:   "debtor_attorney",
      priority:      4,
      name:          a.name,
      organization:  a.firm || "",
      role:          "Debtor Attorney",
      title:         "Attorney",
      firm:          a.firm || null,
      email:         a.email || null,
      phone:         a.phone || null,
      address:       a.contactRaw || null,
      source:        a.source,
      sourceUrl:     null,
      sourceDocumentId: null,
      confidence:    "HIGH",
      evidence:      [],
      recommendedChannel: a.email ? "email" : a.phone ? "phone" : "manual_lookup",
      notes:         "Attorney represents the debtor. Contact after confirming no principal is available.",
      consentStatus:    "unknown",
      unsubscribeStatus:"not_sent_yet"
    });
  }

  // Priority 5: Trustee — informational only, never an outreach target
  if (trustee?.name) {
    contacts.push({
      contactType:   "trustee",
      priority:      5,
      name:          trustee.name,
      organization:  "",
      role:          "Sub-V Trustee",
      title:         "Trustee",
      firm:          null,
      email:         trustee.email || null,
      phone:         trustee.phone || null,
      address:       trustee.address || null,
      source:        trustee.source,
      sourceUrl:     null,
      sourceDocumentId: null,
      confidence:    "HIGH",
      evidence:      [],
      recommendedChannel: "informational_only",
      notes:         "Trustee is case context only, not the primary outreach target.",
      consentStatus:    "unknown",
      unsubscribeStatus:"not_sent_yet"
    });
  }

  // Sort by priority
  contacts.sort((a, b) => a.priority - b.priority);
  return contacts;
}

module.exports = { buildOutreachContacts };
