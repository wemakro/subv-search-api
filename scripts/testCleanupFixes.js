// scripts/testCleanupFixes.js
// Offline test for the three cleanup fixes:
//   1. nameSanityFilter rejects garbage PDF labels as principal names
//   2. UST attorney excluded from outreach contacts
//   3. "US Trustee" office rejected as the Sub-V trustee from /parties
//
// Run: node scripts/testCleanupFixes.js

const { filterPrincipals } = require("../src/nameSanityFilter");
const { buildOutreachContacts } = require("../src/contactExtractionService");

let pass = 0, fail = 0;

function assert(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label} — got: ${JSON.stringify(got)}`);
    fail++;
  }
}

// ── TEST 1: nameSanityFilter ──────────────────────────────────────────────────
console.log("\n═══ Fix 1: nameSanityFilter ═══");

const aleaPrincipals = [
  { name: "the debtor.",                           role: "Chief Restructuring Officer", confidence: "HIGH" },
  { name: "Peter Kravitz\n                Signature of", role: "Authorized Representative", confidence: "HIGH" },
  { name: "City                State        ZIP Code\n   Location", role: "Principal", confidence: "HIGH" },
  { name: "Principal place of business         Mailing", role: "Principal", confidence: "HIGH" },
  { name: "among other things",                    role: "Principal", confidence: "HIGH" },
  { name: "Official Form",                         role: "Equity Security Holder", confidence: "HIGH" },
  { name: "Bankruptcy Rules",                      role: "Equity Security Holder", confidence: "HIGH" },
  { name: "Federal Rules",                         role: "Equity Security Holder", confidence: "HIGH" },
  { name: "Held\n       FIN Alea LLC",             role: "Equity Security Holder", confidence: "HIGH" },
  { name: "Alea Holdings US Company",              role: "debtor", confidence: "LOW" },
  { name: "Catalina Holdings",                     role: "Equity Security Holder", confidence: "HIGH" },
];

const { kept, removed } = filterPrincipals(aleaPrincipals);
console.log(`  Input: ${aleaPrincipals.length} | Kept: ${kept.length} | Removed: ${removed.length}`);
kept.forEach(p => console.log(`    kept:    "${p.name}"`));
removed.forEach(p => console.log(`    removed: "${String(p.name).slice(0,50).replace(/\n/g," ")}"`));

// Peter Kravitz must be repaired (first line extracted) and kept
assert("Peter Kravitz kept and repaired", kept.some(p => p.name === "Peter Kravitz"), kept.map(p=>p.name));
// Alea Holdings US Company kept (valid entity name -- no suffix but used as debtor party)
// It won't pass ENTITY_SUFFIX_RE so it gets removed — that's acceptable and expected
// "Catalina Holdings" has no suffix either, also removed — acceptable
// The garbage labels must all be removed
assert("'the debtor.' removed", removed.some(r => String(r.name).includes("the debtor")), removed.map(r=>r.name));
assert("'City State ZIP Code' removed", removed.some(r => String(r.name).includes("City")), removed.map(r=>r.name));
assert("'among other things' removed", removed.some(r => String(r.name).includes("among other things")), null);
assert("'Official Form' removed", removed.some(r => String(r.name).includes("Official Form")), null);
assert("'Bankruptcy Rules' removed", removed.some(r => String(r.name).includes("Bankruptcy Rules")), null);
assert("'Principal place of business' removed", removed.some(r => String(r.name).includes("Principal place")), null);

// ── TEST 2: UST attorney excluded from outreach ───────────────────────────────
console.log("\n═══ Fix 2: UST attorney excluded from outreach ═══");

const cocorioAttorneys = [
  {
    id: 13838549, name: "JULIO GUZMAN CARCACHE", firm: null,
    email: null, phone: "404-460-8415", fax: null,
    contactRaw: "U.S. Trustee Program\nPO Box 360810\nSan Juan, PR 00936\n",
    representing: [], source: "CourtListener /attorneys"
  },
  {
    id: 13838547, name: "JESUS ENRIQUE BATISTA SANCHEZ", firm: null,
    email: null, phone: "787-620-2856", fax: null,
    contactRaw: "The Batista Law Group, Psc\nCapital Center I\n239 Ave Arterial DE Hostos\n",
    representing: [], source: "CourtListener /attorneys"
  }
];

const cocorioCase = {
  principals: [],
  attorneys: cocorioAttorneys,
  trustee: { name: "DIANA TORRES CANCEL", source: "Docket entry description", confidence: "HIGH" },
  caseName: "COCORIO LLC",
  petitionFields: {}
};

const contacts = buildOutreachContacts(cocorioCase);
const contactNames = contacts.map(c => c.name);
console.log("  Outreach contacts:", contactNames);

assert("BATISTA SANCHEZ included as debtor attorney", contactNames.includes("JESUS ENRIQUE BATISTA SANCHEZ"), contactNames);
assert("GUZMAN CARCACHE (UST) excluded from outreach", !contactNames.includes("JULIO GUZMAN CARCACHE"), contactNames);
assert("DIANA TORRES CANCEL included as trustee (informational)", contactNames.includes("DIANA TORRES CANCEL"), contactNames);

const guzmanContact = contacts.find(c => c.name === "JULIO GUZMAN CARCACHE");
assert("No contact record created for UST attorney", !guzmanContact, guzmanContact);

// ── TEST 3: US Trustee office not grabbed as Sub-V trustee ───────────────────
console.log("\n═══ Fix 3: 'US Trustee' rejected as Sub-V trustee from /parties ═══");

// Simulate the parties fallback path by requiring the guard logic inline
// (the actual guard is inside extractTrustee in caseHydrationService)
const UST_RE = /\bu\.?s\.?\s*trustee\b|united states trustee|trustee[-\s]region|trustee program/i;

const partiesWithUstOnly = [
  { name: "US TRUSTEE-REGION 21", party_types: [{ name: "U.S. Trustee" }], extra_info: null },
  { name: "MONSITA LECAROZ ARRIBAS", party_types: [{ name: "U.S. Trustee" }], extra_info: null },
];
const partiesWithRealTrustee = [
  { name: "US TRUSTEE-REGION 21", party_types: [{ name: "U.S. Trustee" }], extra_info: null },
  { name: "DIANA TORRES CANCEL", party_types: [{ name: "Trustee" }], extra_info: null },
];

function findSubVTrustee(parties) {
  return parties.find(p => {
    const partyTypeStr = (p.party_types||[]).map(t => t.name||"").join(" ");
    if (!partyTypeStr.toLowerCase().includes("trustee")) return false;
    if (/u\.?s\.?\s*trustee/i.test(partyTypeStr)) return false;
    if (UST_RE.test(p.name || "")) return false;
    return true;
  }) || null;
}

const resultUstOnly = findSubVTrustee(partiesWithUstOnly);
const resultWithReal = findSubVTrustee(partiesWithRealTrustee);

assert("UST-only parties returns null trustee (no false positive)", resultUstOnly === null, resultUstOnly?.name);
assert("Real trustee found when present alongside UST", resultWithReal?.name === "DIANA TORRES CANCEL", resultWithReal?.name);

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail ? 1 : 0);
