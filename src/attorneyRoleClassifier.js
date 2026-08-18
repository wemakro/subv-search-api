"use strict";

/**
 * attorneyRoleClassifier.js
 *
 * Decides, for every attorney attached to a docket, WHO THEY REPRESENT.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/rest/v4/attorneys/?docket={id}` returns every attorney on the case:
 * debtor's counsel, creditors' counsel, counsel for the Subchapter V trustee,
 * and the Office of the United States Trustee. Nothing in that response says
 * which is which. Current code treats them as one undifferentiated list, so
 * the Sub-V trustee and the attorney of record end up interchangeable.
 *
 * The role information lives on the OTHER endpoint: each object returned by
 * `/api/rest/v4/parties/?docket={id}` carries a `party_types` array and a
 * nested `attorneys` array. Joining attorney -> party -> party_type is the
 * only reliable way to identify debtor's counsel.
 *
 * This module is PURE — no network, no database, no side effects.
 *
 * Usage:
 *   const { classifyAttorneys } = require("./attorneyRoleClassifier");
 *   const result = classifyAttorneys({ attorneys, parties, trusteeNames: ["Sylvia Mayer"] });
 */

// ── ROLE PATTERNS (checked in this order — order matters) ───────────────────

const UST_PARTY_RE     = /(?:united\s+states\s+trustee|u\.?\s?s\.?\s+trustee|assistant\s+u\.?\s?s\.?\s+trustee|\bust\b)/i;
const DEBTOR_PARTY_RE  = /\bdebtor\b|debtor[-\s]in[-\s]possession|\bd\.?i\.?p\.?\b|\bjoint\s+debtor\b/i;
const TRUSTEE_PARTY_RE = /\btrustee\b/i;
const CREDITOR_PARTY_RE= /\bcreditor\b|\bcommittee\b|\blessor\b|\blandlord\b|\bplaintiff\b|\bdefendant\b|\binterested\s+party\b|\brespondent\b|\bmovant\b|\bpetitioner\b/i;

// Outreach priority: lower number = contact sooner
const PRO_SE_RE = /\bpro\s*[-\s]?se\b/i;

const ROLE_META = {
  debtor_counsel:    { priority: 1, outreachEligible: true,  label: "Debtor's counsel (attorney of record)" },
  pro_se:            { priority: 7, outreachEligible: false, label: "Self-represented debtor — no counsel of record" },
  invalid_record:    { priority: 8, outreachEligible: false, label: "Placeholder / blank attorney record — not a person" },
  unknown_counsel:   { priority: 4, outreachEligible: false, label: "Role unresolved — needs manual review" },
  trustee_counsel:   { priority: 5, outreachEligible: false, label: "Subchapter V trustee or trustee's counsel" },
  creditor_counsel:  { priority: 6, outreachEligible: false, label: "Creditor / other party counsel" },
  ust_office:        { priority: 9, outreachEligible: false, label: "Office of the U.S. Trustee — never contact" }
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

function nameTokens(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(?:jr|sr|ii|iii|iv|esq|esquire|md|phd|cpa)\b/g, " ")
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/** Conservative person-name match: requires first AND last token to agree. */
function sameHuman(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}

function partyTypeString(party) {
  const types = party && Array.isArray(party.party_types) ? party.party_types : [];
  return types.map(t => (t && t.name) || "").join(" | ");
}

/**
 * Extract { attorneyId, roleCode } from a party's nested `attorneys` array.
 *
 * CourtListener v4 does NOT nest attorney objects here. It nests the
 * party-attorney RELATIONSHIP, shaped like:
 *
 *   {
 *     "attorney":    "https://www.courtlistener.com/api/rest/v4/attorneys/14438631/",
 *     "attorney_id": 14438631,
 *     "date_action": null,
 *     "docket":      "https://www.courtlistener.com/api/rest/v4/dockets/73744137/",
 *     "docket_id":   73744137,
 *     "role":        10
 *   }
 *
 * Reading `.id` therefore returns undefined and every join silently fails.
 * We read `attorney_id`, falling back to the URL and then to `.id` so the
 * function still works if the shape changes or if plain integers are returned.
 *
 * `role` is an integer enum on the relationship. Its meaning is NOT documented
 * here and must be confirmed against CourtListener before being relied on —
 * we surface it for inspection but never branch on it.
 */
function attorneyLinksOnParty(party) {
  const list = (party && Array.isArray(party.attorneys)) ? party.attorneys : [];
  const out = [];

  for (const a of list) {
    if (a === null || a === undefined) continue;

    let id = null;
    let roleCode = null;

    if (typeof a === "number" || typeof a === "string") {
      id = String(a);
    } else if (typeof a === "object") {
      roleCode = (a.role !== undefined) ? a.role : null;
      if (a.attorney_id !== undefined && a.attorney_id !== null) {
        id = String(a.attorney_id);
      } else if (typeof a.attorney === "string") {
        const m = a.attorney.match(/\/attorneys\/(\d+)\/?/);
        if (m) id = m[1];
      } else if (a.id !== undefined && a.id !== null) {
        id = String(a.id);
      }
    }

    if (id) out.push({ attorneyId: id, roleCode });
  }
  return out;
}

// ── MAIN ────────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {Array}  input.attorneys     Raw or pre-parsed attorney objects. Each needs { id, name }.
 *                                     If a `parsed` key is present (from attorneyContactParser)
 *                                     its `isUstOffice` flag is honoured.
 * @param {Array}  input.parties       Raw objects from /parties/?docket=X&filter_nested_results=True
 * @param {Array}  input.trusteeNames  Optional. Known Sub-V trustee name(s) for this case, from
 *                                     bankruptcy-information, the parties list, or the docket text parser.
 * @returns {object} { attorneys: [...], debtorCounsel: [...], summary: {...}, warnings: [...] }
 */
function classifyAttorneys(input) {
  input = input || {};
  const attorneys    = Array.isArray(input.attorneys) ? input.attorneys : [];
  const parties      = Array.isArray(input.parties) ? input.parties : [];
  const trusteeNames = (Array.isArray(input.trusteeNames) ? input.trusteeNames : []).filter(Boolean);

  const warnings = [];

  // Build attorneyId -> [{ partyName, partyTypes }]
  const repMap = Object.create(null);
  let totalLinks = 0;
  for (const p of parties) {
    const types = partyTypeString(p);
    for (const link of attorneyLinksOnParty(p)) {
      totalLinks++;
      const aid = link.attorneyId;
      if (!repMap[aid]) repMap[aid] = [];
      repMap[aid].push({
        partyName:  p.name || "",
        partyTypes: types,
        roleCode:   link.roleCode
      });
    }
  }

  if (parties.length && !totalLinks) {
    warnings.push(
      "Parties were returned but none carried an attorney link. Role attribution is impossible for this " +
      "docket. This is normal when counsel has not yet appeared; if it happens on every docket, check that " +
      "/parties/ is called with filter_nested_results=True."
    );
  }

  const classified = attorneys.map(a => {
    const aid    = a.id !== undefined && a.id !== null ? String(a.id) : null;
    const reps   = (aid && repMap[aid]) ? repMap[aid] : [];
    const parsed = a.parsed || null;
    const reasons = [];

    let role = null;

    // 0a. Blank placeholder records. CM/ECF emits attorney rows with an empty
    //     name; they carry a valid party link and would otherwise sail through
    //     as debtor's counsel with HIGH confidence.
    const cleanName = String(a.name || "").trim();
    if (cleanName.length < 3) {
      role = "invalid_record";
      reasons.push("Attorney record has no usable name — placeholder row, not a real person");
    }

    // 0b. Pro se. The debtor itself is listed in the attorney table with
    //     contact_raw "PRO SE". Also catch the case where the attorney name is
    //     just the name of the party being "represented".
    if (!role) {
      const proSeByContact = !!(parsed && parsed.isProSe);
      const proSeByName    = PRO_SE_RE.test(cleanName);
      const nameIsParty    = reps.some(r => {
        const pn = String(r.partyName || "").trim().toLowerCase();
        return pn.length > 2 && pn === cleanName.toLowerCase();
      });
      if (proSeByContact || proSeByName || nameIsParty) {
        role = "pro_se";
        reasons.push(
          nameIsParty && !proSeByContact && !proSeByName
            ? 'Attorney name is identical to the party name ("' + cleanName + '") — this is the party, not counsel'
            : "Contact block or name marked PRO SE — self-represented, no counsel of record"
        );
      }
    }

    // 1. Hard exclusion: Office of the U.S. Trustee.
    //    Checked first because the party type "U.S. Trustee" also contains "trustee".
    const ustByParty   = reps.some(r => UST_PARTY_RE.test(r.partyTypes) || UST_PARTY_RE.test(r.partyName));
    const ustByContact = !!(parsed && parsed.isUstOffice);
    if (ustByParty || ustByContact) {
      role = "ust_office";
      reasons.push(ustByParty ? "Represents a U.S. Trustee party" : "Contact block / email domain matches the UST or DOJ");
    }

    // 2. Named Sub-V trustee appearing in the attorney table.
    //    Sub-V trustees are usually practising bankruptcy attorneys, so they show up
    //    here as well as in the parties list. THIS IS THE MISATTRIBUTION BUG.
    if (!role) {
      const trusteeHit = trusteeNames.find(tn => sameHuman(tn, a.name));
      if (trusteeHit) {
        role = "trustee_counsel";
        reasons.push('Attorney name matches the case trustee ("' + trusteeHit + '") — not debtor\'s counsel');
      }
    }

    // 3. Debtor's counsel — the segment we actually want.
    if (!role) {
      const debtorRep = reps.find(r =>
        DEBTOR_PARTY_RE.test(r.partyTypes) && !TRUSTEE_PARTY_RE.test(r.partyTypes)
      );
      if (debtorRep) {
        role = "debtor_counsel";
        reasons.push('Represents party "' + debtorRep.partyName + '" typed as "' + debtorRep.partyTypes + '"');
      }
    }

    // 4. Trustee's counsel.
    if (!role && reps.some(r => TRUSTEE_PARTY_RE.test(r.partyTypes))) {
      role = "trustee_counsel";
      reasons.push("Represents a trustee party");
    }

    // 5. Creditors and everyone else with a resolved party link.
    if (!role && reps.some(r => CREDITOR_PARTY_RE.test(r.partyTypes))) {
      role = "creditor_counsel";
      reasons.push("Represents a creditor or other non-debtor party");
    }

    // 6. No party link at all. DO NOT assume debtor's counsel.
    if (!role) {
      role = "unknown_counsel";
      reasons.push(
        reps.length
          ? "Linked to parties but no party type matched a known role: " + reps.map(r => r.partyTypes).join(" ; ")
          : "No party link returned for this attorney — cannot determine who they represent"
      );
    }

    const meta = ROLE_META[role];

    return Object.assign({}, a, {
      role:              role,
      roleLabel:         meta.label,
      roleReasons:       reasons,
      roleConfidence:    role === "unknown_counsel" ? "LOW"
                       : (reps.length ? "HIGH" : "MEDIUM"),
      outreachEligible:  meta.outreachEligible,
      outreachPriority:  meta.priority,
      representedParties: reps
    });
  });

  const debtorCounsel = classified.filter(a => a.role === "debtor_counsel");

  const anyProSe = classified.some(a => a.role === "pro_se");

  if (!debtorCounsel.length && classified.length) {
    warnings.push(
      anyProSe
        ? "No debtor's counsel — the debtor appears to be filing pro se. This is a valid outcome, not a data " +
          "gap. There is no attorney to contact on this case."
        : "No debtor's counsel identified on this docket despite " + classified.length +
          " attorney record(s). Flag for manual review rather than defaulting to the first attorney."
    );
  }

  const summary = {
    total:            classified.length,
    debtorCounsel:    debtorCounsel.length,
    trusteeCounsel:   classified.filter(a => a.role === "trustee_counsel").length,
    creditorCounsel:  classified.filter(a => a.role === "creditor_counsel").length,
    ustOffice:        classified.filter(a => a.role === "ust_office").length,
    proSe:            classified.filter(a => a.role === "pro_se").length,
    invalidRecord:    classified.filter(a => a.role === "invalid_record").length,
    unknown:          classified.filter(a => a.role === "unknown_counsel").length
  };

  classified.sort((x, y) => x.outreachPriority - y.outreachPriority);

  return { attorneys: classified, debtorCounsel: debtorCounsel, summary: summary, warnings: warnings };
}

module.exports = {
  classifyAttorneys,
  ROLE_META,
  _internals: { sameHuman, nameTokens, partyTypeString, attorneyLinksOnParty }
};
