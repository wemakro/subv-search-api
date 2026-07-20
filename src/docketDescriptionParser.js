// src/docketDescriptionParser.js
//
// Extracts attorney, trustee, and key deadlines from CM/ECF docket entry
// DESCRIPTION text — the free metadata CourtListener scrapes for every case.
// No PDFs, no PACER purchases, no AI calls.
//
// Conservative by design:
//   - Every extracted value carries the source entry id + matched snippet.
//   - Never invents names or dates. No match => null.
//   - Distinguishes debtor's attorney from UST attorneys via the
//     "on behalf of" party.
//
// Patterns are built from real entries observed across districts:
// D.P.R., N.D. Fla., M.D. Fla., N.D. Tex., N.D. Cal., W.D. Tex., M.D. Tenn.

const logger = require("./logger");

// Name fragment: "Diana Torres Cancel", "Michael C Markham", "Frances A. Smith"
// Handles ALL-CAPS names ("DIANA TORRES CANCEL") and middle initials.
const NAME = "[A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]*\\.?){1,4}";

// ── TRUSTEE PATTERNS ─────────────────────────────────────────────────────────
const TRUSTEE_PATTERNS = [
  // "DIANA TORRES CANCEL is appointed trustee to the case"
  { re: new RegExp(`(${NAME})\\s+is appointed trustee`, "i"), label: "is-appointed" },
  // "Notice of Appointment of Daniel Etlinger as Chapter 11 Subchapter V Trustee"
  { re: new RegExp(`Notice of Appointment of (${NAME})\\s+as\\s+(?:Chapter 11,?\\s*)?Sub-?chapter V Trustee`, "i"), label: "notice-of-appointment-as" },
  // "Notice of Appointment of Chapter 11, Subchapter V Trustee . Michael C Markham added to the case"
  { re: new RegExp(`Sub-?chapter V Trustee\\s*[.:]?\\s*(${NAME})\\s+added to the case`, "i"), label: "added-to-case" },
  // "Frances A. Smith (SBRA V) added to the case"
  { re: new RegExp(`(${NAME})\\s*\\(SBRA V\\)\\s*added to the case`, "i"), label: "sbra-v-added" },
];

// Junk guard: reject "names" that are actually boilerplate fragments
const NAME_BLACKLIST = /\b(United States|U\.?S\.?|Trustee|Notice|Chapter|Sub-?chapter|Debtor|Creditors?|Meeting|Appointment|Office|Region|Court|Clerk|Order|Verification|Statement|Attachments?)\b/i;

function cleanName(raw) {
  if (!raw) return null;
  const name = raw.trim().replace(/\s+/g, " ").replace(/[.,;]$/, "");
  if (name.length < 5 || name.split(" ").length < 2) return null;
  if (NAME_BLACKLIST.test(name)) return null;
  return name;
}

// ── DATE PATTERNS ────────────────────────────────────────────────────────────
const D = "(\\d{1,2}\\/\\d{1,2}\\/\\d{4})";
const TIME = "(\\d{1,2}:\\d{2}\\s*[AP]M)";

const DEADLINE_PATTERNS = [
  // "341(a) meeting to be held on 8/18/2026 at 02:00 PM"
  { key: "meeting341", re: new RegExp(`341\\(a\\)\\s+meeting to be held on ${D}(?:\\s+at\\s+${TIME})?`, "i") },
  // "341 Meeting of Creditors Subchapter V of Chapter 11 (F) Set For 7/7/2026 at 02:00 PM"
  { key: "meeting341", re: new RegExp(`341 Meeting of Creditors[^.]{0,80}?Set For ${D}(?:\\s+at\\s+${TIME})?`, "i") },
  // "Meeting of Creditors ... to be held on 7/15/2026 at 08:30 AM"
  { key: "meeting341", re: new RegExp(`Meeting of [Cc]reditors[^.]{0,80}?held on ${D}(?:\\s+at\\s+${TIME})?`, "i") },

  // Plan due — observed variants:
  //   "Chapter 11 Plan Small Business Subchapter V Due by 10/13/2026"
  //   "Chapter 11 Small Business Subchapter V Plan Due by 10/13/2026"
  //   "Ch 11 Small Business Plan Subchapter V due by 10/13/2026"
  { key: "planDue", re: new RegExp(`(?:Plan[^.]{0,45}?Sub-?chapter V|Sub-?chapter V[^.]{0,25}?Plan)[^.]{0,15}?[Dd]ue(?:\\s+by)?\\s+${D}`, "i") },

  // "Proof of Claims due by 9/23/2026" / "Proofs of Claim Due 8/18/2026"
  { key: "proofOfClaimDue", re: new RegExp(`Proofs?\\s+of\\s+Claims?\\s+[Dd]ue(?:\\s+by)?\\s+${D}`, "i") },
  // "Government Proof of Claim due by 1/11/2027"
  { key: "governmentClaimDue", re: new RegExp(`Government Proofs?\\s+of\\s+Claims?\\s+[Dd]ue(?:\\s+by)?\\s+${D}`, "i") },
  // "Last day to oppose discharge or dischargeability is 10/19/2026"
  //  / "Objections to Dischargeability due by 9/8/2026"
  { key: "dischargeObjectionDue", re: new RegExp(`(?:oppose discharge[^.]{0,40}?is|Objections? to Dischargeability due(?:\\s+by)?)\\s+${D}`, "i") },
];

function toIso(mdY) {
  const m = mdY.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function snippet(text, matchIndex, matchLen) {
  return text
    .slice(Math.max(0, matchIndex - 50), matchIndex + matchLen + 50)
    .replace(/\s+/g, " ")
    .trim();
}

// ── ATTORNEY PATTERNS ────────────────────────────────────────────────────────
// "Filed by JESUS ENRIQUE BATISTA SANCHEZ on behalf of COCORIO LLC"
// "Filed by Richard L Pope Jr of Lake Hills Legal Services, P.C. on behalf of GESUALDO, LLC"
const FILED_BY_RE = new RegExp(`[Ff]iled by (${NAME})(?:\\s+of\\s+(.{3,60}?))?\\s+on behalf of\\s+([^(;]{3,80}?)(?:\\s*[.(]|$)`, "g");
// CM/ECF filer signature: "(BATISTA SANCHEZ, JESUS) (Entered: 07/15/2026)"
const SIGNATURE_RE = /\(([A-Z][A-Za-z'\- ]{1,30}?),\s*([A-Z][A-Za-z'\- .]{1,25}?)\)\s*(?:\(Entered:|$)/g;

const UST_PARTY_RE = /\b(?:U\.?S\.?\s*TRUSTEE|UNITED STATES TRUSTEE|UST\b|TRUSTEE[\s-]*REGION)/i;

// ── MAIN ─────────────────────────────────────────────────────────────────────
/**
 * @param {Array<{id?: number|string, entry_number?: number, description?: string, date_filed?: string}>} entries
 * @returns {{
 *   trustee: {name, source, confidence, evidence} | null,
 *   attorneys: Array<{name, representing, role, source, confidence, evidence}>,
 *   filerSignatures: Array<{name, entryId}>,
 *   deadlines: Object<string, {date, dateIso, time, evidence}>,
 *   warnings: string[]
 * }}
 */
function parseDocketEntries(entries) {
  const result = {
    trustee: null,
    attorneys: [],
    filerSignatures: [],
    deadlines: {},
    warnings: [],
  };
  if (!Array.isArray(entries) || !entries.length) {
    result.warnings.push("No docket entries provided to description parser.");
    return result;
  }

  const seenAttorneys = new Set();

  for (const entry of entries) {
    const text = entry.description || "";
    if (text.length < 15) continue;
    const entryRef = { entryId: entry.id || null, entryNumber: entry.entry_number || null, dateFiled: entry.date_filed || null };

    // 1) Trustee
    if (!result.trustee) {
      for (const { re, label } of TRUSTEE_PATTERNS) {
        const m = text.match(re);
        if (!m) continue;
        const name = cleanName(m[1]);
        if (!name) continue;
        result.trustee = {
          name,
          source: "Docket entry description (trustee appointment)",
          confidence: "HIGH",
          evidence: [{ field: "trustee", value: name, pattern: label, snippet: snippet(text, m.index, m[0].length), ...entryRef }],
        };
        break;
      }
    }

    // 2) Attorneys via "filed by X on behalf of Y"
    FILED_BY_RE.lastIndex = 0;
    let fm;
    while ((fm = FILED_BY_RE.exec(text)) !== null) {
      const name = cleanName(fm[1]);
      if (!name) continue;
      const firm = fm[2] ? fm[2].trim().replace(/[.,;]$/, "") : null;
      const representing = (fm[3] || "").trim().replace(/[.,;]$/, "");
      // Party capture can truncate at "." (e.g. "U.S. Trustee" → "U.S"), so
      // also check the text immediately following the match for UST markers.
      const context = text.slice(fm.index, fm.index + fm[0].length + 50);
      const isUst = UST_PARTY_RE.test(representing) ||
                    /U\.?S\.?\s*Trustee|United States Trustee/i.test(context);
      const key = name.toLowerCase();
      if (seenAttorneys.has(key)) continue;
      seenAttorneys.add(key);
      result.attorneys.push({
        name,
        firm,
        representing,
        role: isUst ? "ust_attorney" : "debtor_attorney",
        source: "Docket entry description (filed by ... on behalf of)",
        confidence: "HIGH",
        evidence: [{ field: "attorney", value: name, snippet: snippet(text, fm.index, fm[0].length), ...entryRef }],
      });
    }

    // 3) CM/ECF filer signatures "(Last, First)" — weaker signal, kept separate.
    SIGNATURE_RE.lastIndex = 0;
    let sm;
    while ((sm = SIGNATURE_RE.exec(text)) !== null) {
      const last = sm[1].trim();
      const first = sm[2].trim();
      if (NAME_BLACKLIST.test(last) || NAME_BLACKLIST.test(first)) continue;
      const full = `${first} ${last}`;
      if (!result.filerSignatures.some(s => s.name.toLowerCase() === full.toLowerCase())) {
        result.filerSignatures.push({ name: full, ...entryRef });
      }
    }

    // 4) Deadlines — first hit per key wins (earliest entries are authoritative)
    for (const { key, re } of DEADLINE_PATTERNS) {
      if (result.deadlines[key]) continue;
      const dm = text.match(re);
      if (!dm) continue;
      result.deadlines[key] = {
        date: dm[1],
        dateIso: toIso(dm[1]),
        time: dm[2] || null,
        evidence: { snippet: snippet(text, dm.index, dm[0].length), ...entryRef },
      };
    }
  }

  logger.info(
    `Docket description parse: trustee=${result.trustee ? result.trustee.name : "none"}, ` +
    `attorneys=${result.attorneys.length}, deadlines=[${Object.keys(result.deadlines).join(",") || "none"}]`
  );
  return result;
}

module.exports = { parseDocketEntries };
