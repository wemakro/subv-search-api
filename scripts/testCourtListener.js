require("dotenv").config();
const { discoverSubchapterVCases } = require("../src/courtListenerSearchService");
const { hydrateDocket }            = require("../src/caseHydrationService");

const token = process.env.COURTLISTENER_TOKEN;
if (!token) { console.error("ERROR: COURTLISTENER_TOKEN not set in .env"); process.exit(1); }
console.log(`Token set (length ${token.length}, prefix ${token.slice(0,4)}...)\n`);

(async () => {
  const dateFrom = "2026-05-01";
  const dateTo   = "2026-06-01";

  console.log(`Discovering Sub-V cases from ${dateFrom} to ${dateTo}...\n`);
  const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court: "txsb", maxPages: 2 });
  console.log(`Found ${discovered.length} unique dockets\n`);

  if (!discovered.length) {
    console.log("No dockets found. Check token permissions or try a wider date range.");
    process.exit(0);
  }

  discovered.slice(0, 3).forEach((d, i) => {
    console.log(`[${i+1}] ${d.caseName} | ${d.docketNumber} | ${d.courtId} | filed ${d.dateFiled}`);
  });

  const first = discovered.find(d => d.docketId);
  if (!first) { console.log("\nNo docket IDs found to hydrate."); process.exit(0); }

  console.log(`\nHydrating docket ${first.docketId} (${first.caseName})...\n`);
  const h = await hydrateDocket(first.docketId);

  console.log("=== Hydration Result ===");
  console.log("Case Name:      ", h.caseName);
  console.log("Docket Number:  ", h.docketNumber);
  console.log("Court:          ", h.courtId);
  console.log("Chapter:        ", h.chapter);
  console.log("Sub-V:          ", h.subchapterV.confidence, "-", h.subchapterV.reasons.join("; "));
  console.log("Trustee:        ", h.trustee?.name || "not found");
  console.log("Parties:        ", h.raw.partiesCount);
  console.log("Attorneys:      ", h.raw.attorneysCount);
  console.log("Docket Entries: ", h.raw.docketEntriesCount);
  if (h.attorneys?.length) {
    console.log("\nAttorneys found:");
    h.attorneys.forEach(a => console.log(` - ${a.name} | ${a.firm||"no firm"} | ${a.email||"no email"} | representing: ${a.representing.join(", ")}`));
  }
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
