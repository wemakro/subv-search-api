require("dotenv").config();
const { discoverSubchapterVCases } = require("../src/courtListenerSearchService");
const { hydrateDocket }            = require("../src/caseHydrationService");

const token = process.env.COURTLISTENER_TOKEN;
if (!token) { console.error("ERROR: COURTLISTENER_TOKEN not set"); process.exit(1); }

(async () => {
  const dateFrom = "2026-05-01", dateTo = "2026-06-01";
  console.log(`\nSearching Sub-V cases ${dateFrom} to ${dateTo} (txsb)...\n`);

  const discovered = await discoverSubchapterVCases({ dateFrom, dateTo, court:"txsb", maxPages:2 });
  console.log(`Discovered: ${discovered.length} cases\n`);
  if (!discovered.length) { console.log("None found. Try wider date range."); process.exit(0); }

  const target = discovered.find(d => d.docketId) || discovered[0];
  console.log(`Hydrating: ${target.caseName} (docket ${target.docketId})\n`);

  const h = await hydrateDocket(target.docketId);

  console.log("═══════════════════════════════════════");
  console.log("CASE");
  console.log("  Debtor:      ", h.debtorName);
  console.log("  Case No:     ", h.docketNumber);
  console.log("  Court:       ", h.courtId);
  console.log("  Filed:       ", h.dateFiled);
  console.log("  Chapter:     ", h.chapter);
  console.log("  Sub-V:       ", h.subchapterV.confidence, "-", h.subchapterV.reasons[0]);

  console.log("\nTRUSTEE");
  console.log("  Name:        ", h.trustee?.name || "not found");
  console.log("  Source:      ", h.trustee?.source || "-");

  console.log("\nATTORNEYS (" + h.attorneys.length + ")");
  h.attorneys.slice(0,3).forEach(a =>
    console.log(`  - ${a.name} | ${a.firm||"no firm"} | ${a.email||"no email"} | ${a.phone||"no phone"}`)
  );

  console.log("\nPETITION DOCUMENTS (" + h.petitionDocuments.length + ")");
  h.petitionDocuments.slice(0,3).forEach(p =>
    console.log(`  [score ${p.relevanceScore}] ${p.documentTypeGuess} | text: ${p.textAvailable} | entry #${p.docketEntryId}`)
  );

  console.log("\nPETITION FIELDS");
  const pf = h.petitionFields;
  console.log("  Signer:      ", pf?.signerName || "not found");
  console.log("  Signer title:", pf?.signerTitle || "-");
  console.log("  Auth rep:    ", pf?.authorizedRepresentativeName || "-");
  console.log("  Debtor name: ", pf?.debtorName || "-");
  console.log("  Atty name:   ", pf?.attorneyName || "-");
  console.log("  Atty firm:   ", pf?.attorneyFirm || "-");
  if (pf?.evidenceSnippets?.length) {
    console.log("  Evidence snippets:");
    pf.evidenceSnippets.slice(0,3).forEach(s =>
      console.log(`    [${s.field}] "${s.value}" → ...${s.snippet.slice(0,80)}...`)
    );
  }

  console.log("\nPRINCIPALS (" + h.principals.length + ")");
  if (h.principals.length === 0) {
    console.log("  ⚠️  No principals found. Petition document may require manual review.");
  } else {
    h.principals.forEach((p, i) =>
      console.log(`  [${i+1}] ${p.name} | ${p.role} | conf: ${p.confidence} | ${p.email||"no email"} | ${p.phone||"no phone"}`)
    );
  }

  console.log("\nOUTREACH CONTACTS (" + h.outreachContacts.length + ")");
  h.outreachContacts.forEach((c, i) =>
    console.log(`  [P${c.priority}] ${c.contactType.toUpperCase()}: ${c.name} | ${c.email||"no email"} | ${c.phone||"no phone"} | channel: ${c.recommendedChannel}`)
  );

  console.log("\nDEBUG WARNINGS");
  h.debug.warnings.forEach(w => console.log("  ⚠️  " + w));
  console.log("\nNEXT BEST ACTIONS");
  h.debug.nextBestActions.forEach(a => console.log("  → " + a));
  console.log("═══════════════════════════════════════\n");
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
