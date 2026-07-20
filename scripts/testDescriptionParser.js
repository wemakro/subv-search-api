// scripts/testDescriptionParser.js
// Offline test — no API token needed. Fixtures are REAL docket entry
// descriptions captured from CourtListener search results (July 2026)
// across 7 districts, so this validates the parser against actual
// per-district CM/ECF formatting.
//
// Run: npm run test:parser

const { parseDocketEntries } = require("../src/docketDescriptionParser");

const FIXTURES = [
  {
    district: "D.P.R. (COCORIO LLC)",
    expect: { trustee: "DIANA TORRES CANCEL", debtorAttorney: "JESUS ENRIQUE BATISTA SANCHEZ", deadlines: ["meeting341","proofOfClaimDue","governmentClaimDue","dischargeObjectionDue","planDue"] },
    entries: [
      { id: 1, entry_number: 1, description: "Voluntary petition under chapter 11 Subchapter V Non-Individual With Notice to Individual Consumer Debtor, With List of creditors. List of Creditors Holding 20 Largest Unsecured Claims. Attorney Statement of Compensation $0.00 Fee Amount $1738 Chapter 11 Plan Small Business Subchapter V Due by 10/13/2026.. Filed by JESUS ENRIQUE BATISTA SANCHEZ on behalf of COCORIO LLC (BATISTA SANCHEZ, JESUS) (Entered: 07/15/2026)" },
      { id: 2, entry_number: 2, description: "First Meeting of Creditors & Notice of Appointment of Sub-Chapter V Trustee: DIANA TORRES CANCEL is appointed trustee to the case. 341(a) meeting to be held on 8/18/2026 at 02:00 PM via Telephonic Conference Information for AUST/Trial Attys. Last day to oppose discharge or dischargeability is 10/19/2026. Proof of Claims due by 9/23/2026. Government Proof of Claim due by 1/11/2027. filed by JULIO GUZMAN CARCACHE on behalf of US TRUSTEE-REGION 21 (GUZMAN CARCACHE, JULIO) (Entered: 07/15/2026)" },
    ]
  },
  {
    district: "N.D. Fla. (Hometown Hospitality LLC)",
    expect: { trustee: "Daniel Etlinger", deadlines: [] },
    entries: [
      { id: 5, entry_number: 5, description: "Notice of Appointment of Daniel Etlinger as Chapter 11 Subchapter V Trustee Filed by United States Trustee. (Attachments: # 1 Verification Statement - Dan Etlinger) (United States Trustee) (Entered: 07/15/2026)" },
      { id: 1, entry_number: 1, description: "Chapter 11 Subchapter V Voluntary Petition (Non-Individual) (Filing Fee: $1738.00) filed by Hometown Hospitality LLC. Attorney Disclosure Statement due 07/29/2026. Schedule A/B due 07/29/2026. Statement of Financial Affairs due 07/29/2026. Deadline to Cure Deficiency(ies): 07/29/2026. (Wright, Byron) (Entered: 07/15/2026)" },
    ]
  },
  {
    district: "M.D. Fla. (Ritchey's Truck Repair)",
    expect: { trustee: "Michael C Markham", deadlines: [], ustAttorney: "Nathan A Wheatley" },
    entries: [
      { id: 22, entry_number: 22, description: "Notice of Appointment of Chapter 11, Subchapter V Trustee . Michael C Markham added to the case. Meeting of Creditors scheduled for July 20, 2026 at 1:30 p.m. telephonically via US Trustee - Tampa/Ft. Myers. Filed by Nathan A Wheatley on behalf of U.S. Trustee United States Trustee - TPA. (Attachments: # 1 Exhibit Verified statement of Subchapter V Trustee) (Wheatley, Nathan) (Entered: 06/12/2026)" },
    ]
  },
  {
    district: "N.D. Tex. (Blue Clouds Health Care)",
    expect: { trustee: "Frances A. Smith", deadlines: ["meeting341"] },
    entries: [
      { id: 35, entry_number: 35, description: "Notice of Appointment of Subchapter V Trustee . Frances A. Smith (SBRA V) added to the case. (Schmidt, Erin) (Entered: 06/22/2026)" },
      { id: 8, entry_number: 8, description: "Meeting of creditors 341(a) meeting to be held on 7/15/2026 at 08:30 AM by TELEPHONE. Proofs of Claims due by 8/17/2026. Government Proof of Claim due by 12/7/2026. (Schmidt, Erin)" },
    ]
  },
  {
    district: "W.D. Tex. (T7 Enterprises)",
    expect: { deadlines: ["meeting341","proofOfClaimDue","dischargeObjectionDue"] },
    entries: [
      { id: 13, entry_number: 13, description: "341 Meeting of Creditors Subchapter V of Chapter 11 (F) Set For 7/7/2026 at 02:00 PM via Via Phone: (888)330-1716; Code: 7659325; Objections to Dischargeability due by 9/8/2026- Proofs of Claim Due 8/18/2026 (Turner, Blayne)" },
    ]
  },
  {
    district: "N.D. Cal. (Atelaite Tangimausia Kava)",
    expect: { deadlines: ["planDue"] },
    entries: [
      { id: 1, entry_number: 1, description: "Chapter 11 Voluntary Petition for Individual, Fee Amount $1738, Filed by Atelaite Tangimausia Kava. Order Meeting of Creditors due by 07/22/2026. Chapter 11 Small Business Subchapter V Plan Due by 10/13/2026. (Metzger, Matthew) (Entered: 07/15/2026)" },
    ]
  },
  {
    district: "W.D. Wash. (Gesualdo, LLC)",
    expect: { debtorAttorney: "Richard L Pope Jr", deadlines: ["planDue"] },
    entries: [
      { id: 1, entry_number: 1, description: "Chapter 11 Subchapter V Voluntary Petition, Non-Individual. Schedule A/B due 07/30/2026. Statement of Financial Affairs due 07/30/2026. Chapter 11 Statement of Your Current Monthly Income, Form 122B Due 07/30/2026. Incomplete Filings due by 07/30/2026. Ch 11 Small Business Plan Subchapter V due by 10/13/2026, Filed by Richard L Pope Jr of Lake Hills Legal Services, P.C. on behalf of GESUALDO, LLC (Pope, Richard) (Entered: 07/15/2026)" },
    ]
  },
  {
    district: "D.N.J. (292 7th Street, LLC)",
    expect: { debtorAttorney: "Steven D. Pertuz", deadlines: ["planDue"] },
    entries: [
      { id: 1, entry_number: 1, description: "Chapter 11 Voluntary Petition Filed by Steven D. Pertuz on behalf of 292 7th Street, LLC. Chapter 11 Plan Subchapter V Due by 10/13/2026. (Pertuz, Steven) (Entered: 07/15/2026)" },
    ]
  },
];

let pass = 0, fail = 0;

for (const fx of FIXTURES) {
  console.log("\n═══ " + fx.district + " ═══");
  const r = parseDocketEntries(fx.entries);

  console.log("  Trustee:   ", r.trustee ? `${r.trustee.name} [${r.trustee.confidence}]` : "—");
  r.attorneys.forEach(a => console.log(`  Attorney:   ${a.name} (${a.role}) representing: ${a.representing}`));
  Object.entries(r.deadlines).forEach(([k, v]) =>
    console.log(`  Deadline:   ${k} = ${v.dateIso}${v.time ? " " + v.time : ""}`)
  );
  r.filerSignatures.forEach(s => console.log(`  Signature:  ${s.name}`));

  // Assertions
  const problems = [];
  if (fx.expect.trustee) {
    const got = (r.trustee?.name || "").toLowerCase();
    if (!got.includes(fx.expect.trustee.toLowerCase().split(" ").pop()))
      problems.push(`expected trustee "${fx.expect.trustee}", got "${r.trustee?.name || "none"}"`);
  }
  if (fx.expect.debtorAttorney) {
    const lastNames = r.attorneys.filter(a => a.role === "debtor_attorney").map(a => a.name.toLowerCase());
    const want = fx.expect.debtorAttorney.toLowerCase();
    if (!lastNames.some(n => n.includes(want.split(" ").pop()) || want.includes(n.split(" ").pop())))
      problems.push(`expected debtor attorney "${fx.expect.debtorAttorney}", got [${lastNames.join(", ") || "none"}]`);
  }
  for (const d of (fx.expect.deadlines || [])) {
    if (!r.deadlines[d]) problems.push(`expected deadline "${d}" not found`);
  }
  if (fx.expect.ustAttorney) {
    const asDebtor = r.attorneys.find(a => a.role === "debtor_attorney" && a.name.toLowerCase().includes(fx.expect.ustAttorney.toLowerCase().split(" ").pop()));
    if (asDebtor) problems.push(`"${fx.expect.ustAttorney}" is a UST attorney but was classified debtor_attorney`);
  }
  // Negative check: UST attorneys must never be classified as debtor attorneys
  const ustAsDebtor = r.attorneys.find(a => a.role === "debtor_attorney" && /trustee|region/i.test(a.representing || ""));
  if (ustAsDebtor) problems.push(`UST attorney misclassified as debtor attorney: ${ustAsDebtor.name}`);

  if (problems.length) {
    fail++;
    console.log("  ❌ FAIL: " + problems.join(" | "));
  } else {
    pass++;
    console.log("  ✅ PASS");
  }
}

console.log(`\n${pass} passed, ${fail} failed across ${FIXTURES.length} districts.\n`);
process.exit(fail ? 1 : 0);
