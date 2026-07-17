"use strict";
// Run with: npm test  (node --test test/)
// No external test framework — uses Node's built-in node:test (Node 18+).

const { test } = require("node:test");
const assert   = require("node:assert");

const {
  buildAllEmails,
  filterEmailsForContact,
} = require("../src/integrations/closeIntegration");

// ── buildAllEmails: existing behavior (regression pins) ────────────────────

test("buildAllEmails: info@ guess from website is labeled guessed", () => {
  const emails = buildAllEmails(null, { website: "https://www.frogstore.com" });
  const info = emails.find(e => e.email === "info@frogstore.com");
  assert.ok(info, "info@ guess should be generated");
  assert.strictEqual(info._confidence, "guessed");
});

test("buildAllEmails: scraped website emails are labeled confirmed", () => {
  const emails = buildAllEmails(null, { emails: ["owner@frogstore.com"] });
  const scraped = emails.find(e => e.email === "owner@frogstore.com");
  assert.ok(scraped);
  assert.strictEqual(scraped._confidence, "confirmed");
});

test("buildAllEmails: Claude ownerEmails keep their own confidence label", () => {
  const emails = buildAllEmails(null, {
    ownerEmails: [
      { email: "jane@frogstore.com", type: "direct", confidence: "confirmed" },
      { email: "jane.doe@frogstore.com", type: "direct", confidence: "guessed" },
    ],
  });
  assert.strictEqual(emails.find(e => e.email === "jane@frogstore.com")._confidence, "confirmed");
  assert.strictEqual(emails.find(e => e.email === "jane.doe@frogstore.com")._confidence, "guessed");
});

test("buildAllEmails: DB contact primary_email is labeled confirmed", () => {
  const emails = buildAllEmails({ primary_email: "atty@lawfirm.com" }, null);
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0]._confidence, "confirmed");
});

test("buildAllEmails: dedupes and rejects junk addresses", () => {
  const emails = buildAllEmails(
    { primary_email: "owner@frogstore.com" },
    { emails: ["owner@frogstore.com", "noreply@frogstore.com", "not-an-email"] }
  );
  assert.strictEqual(emails.filter(e => e.email === "owner@frogstore.com").length, 1);
  assert.ok(!emails.some(e => /noreply/.test(e.email)));
});

// ── filterEmailsForContact: the new gate ───────────────────────────────────

const MIXED = [
  { email: "info@frogstore.com",     type: "office", _confidence: "guessed"   },
  { email: "jane@frogstore.com",     type: "direct", _confidence: "confirmed" },
  { email: "jane.doe@frogstore.com", type: "direct", _confidence: "guessed"   },
];

test("filterEmailsForContact: strips guessed emails by default (flag off)", () => {
  // Explicit allowGuessed=false mirrors the default (env var unset in this process)
  const out = filterEmailsForContact(MIXED, false);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].email, "jane@frogstore.com");
});

test("filterEmailsForContact: env default in this process is OFF", () => {
  // GUESSED_EMAILS_ON_CONTACTS is not set when tests run, so the module-level
  // default must filter. If this fails, the default changed — that is a
  // deliberate decision, not an accident.
  assert.strictEqual(process.env.GUESSED_EMAILS_ON_CONTACTS, undefined);
  const out = filterEmailsForContact(MIXED);
  assert.deepStrictEqual(out.map(e => e.email), ["jane@frogstore.com"]);
});

test("filterEmailsForContact: allowGuessed=true passes everything through", () => {
  const out = filterEmailsForContact(MIXED, true);
  assert.strictEqual(out.length, 3);
});

test("filterEmailsForContact: contact with ONLY guessed emails gets none (goes to Needs Research, not a bad send)", () => {
  const onlyGuessed = [{ email: "info@frogstore.com", type: "office", _confidence: "guessed" }];
  const out = filterEmailsForContact(onlyGuessed, false);
  assert.strictEqual(out.length, 0);
});

test("filterEmailsForContact: handles null/empty input safely", () => {
  assert.deepStrictEqual(filterEmailsForContact(null, false), []);
  assert.deepStrictEqual(filterEmailsForContact([], true), []);
});

// ── Flag defaults documented ───────────────────────────────────────────────

test("AUTO_CREATE_OPPORTUNITY defaults off in this process", () => {
  // The flag is read at module load; unset env means opportunities are NOT
  // auto-created. This test documents the default.
  assert.notStrictEqual(process.env.AUTO_CREATE_OPPORTUNITY, "true");
});
