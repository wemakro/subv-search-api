"use strict";

/**
 * attorneyContactParser.js
 *
 * Parses a CourtListener attorney `contact_raw` block into structured fields:
 * firm name, firm domain, email, phone, fax, and mailing address.
 *
 * WHY THIS EXISTS
 * ---------------
 * CourtListener's attorney records store the address block exactly as the
 * attorney filed it with the court, in a single free-text field. That block
 * almost always contains the law firm name, but nothing in the API breaks it
 * out. Current code only regex-scrapes an email and a phone from it and throws
 * the rest away, which is why most leads show an attorney name and nothing else.
 *
 * This module is PURE — no network, no database, no side effects. It can be
 * deployed and unit-tested in isolation before anything is wired to it.
 *
 * IT NEVER GUESSES AN EMAIL. If contact_raw has no email address, `email` is
 * null. Pattern-guessed addresses are the caller's decision, not this module's.
 *
 * Usage:
 *   const { parseContactBlock } = require("./attorneyContactParser");
 *   const parsed = parseContactBlock(a.contact_raw, a.name, { email: a.email, phone: a.phone });
 */

// ── PATTERNS ────────────────────────────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}/;
const ZIP_RE   = /\b\d{5}(?:-\d{4})?\b/;
const CSZ_RE   = /^(.+?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/; // "Houston, TX 77002"

// Line-leading labels we strip before analysis.
// Unambiguous labels may omit the separator ("Fax 713-555-1213").
// Ambiguous ones REQUIRE a separator, so "Office of the United States Trustee"
// and "Main Street Legal Group" are left intact.
const LABEL_STRICT_RE = /^\s*(?:e[-\s]?mail|email|tel(?:ephone)?|phone|ph|fax|facsimile)\s*[:.\-]?\s*/i;
const LABEL_LOOSE_RE  = /^\s*(?:direct|dir|mobile|cell|main|office|attn|attention)\s*[:\-]\s*/i;

const FAX_LINE_RE = /^\s*(?:fax|facsimile)\s*[:.\-]?\s*\(?\d/i;

// Address indicators
const ADDRESS_HINT_RE = /\b(?:suite|ste\.?|floor|fl\.?|room|rm\.?|unit|apt\.?|p\.?\s?o\.?\s+box|post office box|street|st\.|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|plaza|parkway|pkwy\.?|highway|hwy\.?|circle|cir\.?|terrace|building|bldg\.?|tower|square|turnpike|tpke)\b/i;
const LEADING_NUMBER_RE = /^\d+[\w-]*\s+\S/;

// Firm indicators
const FIRM_SUFFIX_RE = /(?:^|[\s,])(?:l\.?\s?l\.?\s?p|l\.?\s?l\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c|p\.?\s?c|p\.?\s?a|s\.?\s?c|ltd|chartered|inc)\b\.?/i;
const FIRM_WORD_RE   = /\b(?:law|laws|lawyer|lawyers|attorney|attorneys|counsel|counsellors?|counselors?|legal|firm|offices?|group|associates|partners|advocates|solicitors)\b/i;
const AMPERSAND_RE   = /\s&\s|\s&$/;

// United States Trustee / DOJ markers — these are NEVER outreach targets
const UST_TEXT_RE   = /(?:united\s+states\s+trustee|u\.?\s?s\.?\s+trustee|office\s+of\s+the\s+u\.?\s?s\.?\s+trustee|us\s+dept\.?\s+of\s+justice|department\s+of\s+justice|executive\s+office\s+for\s+u)/i;
const UST_DOMAIN_RE = /@(?:[\w-]+\.)*(?:usdoj\.gov|justice\.gov|uscourts\.gov)$/i;

// Generic mailbox prefixes — real, but not a person. Flag, don't discard.
const GENERIC_MAILBOX_RE = /^(?:info|contact|admin|office|mail|inbox|reception|hello|support|filings?|ecf|notice|bankruptcy|clerk)@/i;

// ── HELPERS ─────────────────────────────────────────────────────────────────

function splitLines(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length > 0);
}

function stripLabel(line) {
  return line.replace(LABEL_STRICT_RE, "").replace(LABEL_LOOSE_RE, "").trim();
}

/** Normalize a human name to comparable tokens: lowercase, no punctuation, no suffixes/initials. */
function nameTokens(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|esq|esquire|md|phd|cpa)\b/g, " ")
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1); // drops middle initials
}

/** True if `line` appears to be a restatement of the attorney's own name. */
function isLikelyPersonNameOf(line, attorneyName) {
  const lt = nameTokens(line);
  const at = nameTokens(attorneyName);
  if (!lt.length || !at.length) return false;
  if (lt.length > 5) return false;
  const overlap = at.filter(t => lt.includes(t));
  // Require at least two shared tokens (typically first + last), or a single
  // shared token when the name itself is only one token long.
  return overlap.length >= Math.min(2, at.length);
}

function isAddressLine(line) {
  if (CSZ_RE.test(line)) return true;
  if (ZIP_RE.test(line) && /[A-Za-z]/.test(line)) return true;
  if (LEADING_NUMBER_RE.test(line) && ADDRESS_HINT_RE.test(line)) return true;
  if (LEADING_NUMBER_RE.test(line) && line.split(" ").length >= 3) return true;
  if (/^p\.?\s?o\.?\s+box/i.test(line)) return true;
  if (/^(?:suite|ste\.?|floor|fl\.?|unit|room|rm\.?)\b/i.test(line)) return true;
  return false;
}

function firmScore(line) {
  let score = 0;
  const reasons = [];
  if (FIRM_SUFFIX_RE.test(line)) { score += 3; reasons.push("entity suffix (LLP/LLC/PC/PA)"); }
  if (FIRM_WORD_RE.test(line))   { score += 2; reasons.push("firm keyword"); }
  if (AMPERSAND_RE.test(line))   { score += 2; reasons.push("ampersand (partner names)"); }
  if (/,\s*(?:p\.?\s?c|p\.?\s?a|l\.?\s?l\.?\s?p)\b/i.test(line)) { score += 1; reasons.push("comma-suffix form"); }
  return { score, reasons };
}

function domainFromEmail(email) {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase() || null;
}

/**
 * Stable dedup key for a firm. Prefers the email domain (highly reliable),
 * falls back to a normalized firm name.
 */
function firmKeyFrom(firmName, domain) {
  if (domain) return "domain:" + domain;
  if (!firmName) return null;
  const norm = String(firmName)
    .toLowerCase()
    .replace(/[.,'"]/g, "")
    .replace(/\b(?:llp|llc|pllc|pc|pa|sc|ltd|chartered|inc|the)\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return norm ? "name:" + norm : null;
}

// ── MAIN ────────────────────────────────────────────────────────────────────

/**
 * @param {string|null} contactRaw   CourtListener attorney.contact_raw
 * @param {string|null} attorneyName CourtListener attorney.name
 * @param {object}      fallback     { email, phone } from the attorney record's own fields
 * @returns {object} structured, confidence-scored contact record
 */
function parseContactBlock(contactRaw, attorneyName, fallback) {
  fallback = fallback || {};

  const out = {
    firmName:        null,
    firmKey:         null,
    firmNameSource:  null,
    firmConfidence:  "NONE",       // HIGH | MEDIUM | LOW | NONE
    domain:          null,
    email:           null,
    emailSource:     null,         // "contact_raw" | "attorney_record"
    emailConfidence: "NONE",       // CONFIRMED (from court filing) | NONE
    emailIsGeneric:  false,
    phone:           null,
    fax:             null,
    addressLines:    [],
    addressFull:     null,
    city:            null,
    state:           null,
    zip:             null,
    isUstOffice:     false,
    parseConfidence: "NONE",
    unparsedLines:   [],
    warnings:        []
  };

  const lines = splitLines(contactRaw);

  if (!lines.length) {
    out.warnings.push("contact_raw is empty — no firm or address available from CourtListener.");
  }

  // ── Pass 1: pull typed values off the lines ──────────────────────────────
  const remaining = [];

  for (const rawLine of lines) {
    const isFaxLine = FAX_LINE_RE.test(rawLine);
    const line = stripLabel(rawLine);

    const emailMatch = line.match(EMAIL_RE);
    if (emailMatch && !out.email) {
      out.email = emailMatch[0].toLowerCase();
      out.emailSource = "contact_raw";
      out.emailConfidence = "CONFIRMED";
      const residue = line.replace(emailMatch[0], "").replace(/[,;|]/g, " ").trim();
      if (residue.length > 3) remaining.push(residue);
      continue;
    }

    const phoneMatch = line.match(PHONE_RE);
    // Only treat as a phone line if the digits dominate the line — avoids
    // eating "1000 Louisiana St" style address numbers.
    if (phoneMatch && line.replace(phoneMatch[0], "").replace(/[^a-z]/gi, "").length <= 6) {
      if (isFaxLine) {
        if (!out.fax) out.fax = phoneMatch[0].trim();
      } else if (!out.phone) {
        out.phone = phoneMatch[0].trim();
      }
      continue;
    }

    remaining.push(line);
  }

  // Fall back to the attorney record's own email/phone fields when the block had none
  if (!out.email && fallback.email && EMAIL_RE.test(String(fallback.email))) {
    out.email = String(fallback.email).toLowerCase();
    out.emailSource = "attorney_record";
    out.emailConfidence = "CONFIRMED";
  }
  if (!out.phone && fallback.phone) {
    const m = String(fallback.phone).match(PHONE_RE);
    if (m) out.phone = m[0].trim();
  }

  out.domain = domainFromEmail(out.email);
  if (out.email) out.emailIsGeneric = GENERIC_MAILBOX_RE.test(out.email);

  // ── Pass 2: UST / DOJ detection (hard exclusion signal) ──────────────────
  const fullText = [attorneyName || "", contactRaw || ""].join(" ");
  if (UST_TEXT_RE.test(fullText) || (out.email && UST_DOMAIN_RE.test(out.email))) {
    out.isUstOffice = true;
    out.warnings.push("Matches United States Trustee / DOJ. Exclude from all outreach.");
  }

  // ── Pass 3: separate address lines from candidate firm lines ─────────────
  const addressLines = [];
  const nonAddress   = [];

  for (const line of remaining) {
    if (isAddressLine(line)) addressLines.push(line);
    else nonAddress.push(line);
  }

  out.addressLines = addressLines;
  if (addressLines.length) out.addressFull = addressLines.join(", ");

  for (const line of addressLines) {
    const m = line.match(CSZ_RE);
    if (m) {
      out.city  = m[1].trim();
      out.state = m[2].toUpperCase();
      out.zip   = m[3];
      break;
    }
  }

  // ── Pass 4: pick the firm name ───────────────────────────────────────────
  // IMPORTANT: firm scoring runs BEFORE the attorney-name check, so solo
  // practices like "Law Office of Jane Smith" are kept as firms.
  let best = null;

  for (const line of nonAddress) {
    if (line.length < 3 || line.length > 120) continue;
    const { score, reasons } = firmScore(line);
    if (score > 0 && (!best || score > best.score)) {
      best = { line, score, reasons };
    }
  }

  if (best) {
    out.firmName       = best.line;
    out.firmNameSource = "contact_raw";
    out.firmConfidence = best.score >= 3 ? "HIGH" : "MEDIUM";
    out.warnings.push("Firm matched on: " + best.reasons.join(", ") + ".");
  } else {
    // No firm keyword anywhere. Take the first non-address line that isn't the
    // attorney's own name — but mark it LOW so it can be filtered before use.
    const candidate = nonAddress.find(
      l => l.length >= 3 && l.length <= 120 && !isLikelyPersonNameOf(l, attorneyName)
    );
    if (candidate) {
      out.firmName       = candidate;
      out.firmNameSource = "contact_raw (unlabeled line)";
      out.firmConfidence = "LOW";
      out.warnings.push("No firm keyword found. Firm name inferred from position — verify before use.");
    } else {
      out.warnings.push("No firm name found in contact_raw. Likely a solo practitioner filing under their own name.");
    }
  }

  out.firmKey = firmKeyFrom(out.firmName, out.domain);

  // ── Leftovers, for tuning the parser on real data ────────────────────────
  out.unparsedLines = nonAddress.filter(l => l !== out.firmName);

  // ── Overall parse confidence ─────────────────────────────────────────────
  if (out.email && out.firmConfidence === "HIGH")        out.parseConfidence = "HIGH";
  else if (out.email || out.firmConfidence === "HIGH")   out.parseConfidence = "MEDIUM";
  else if (out.firmName || out.phone)                    out.parseConfidence = "LOW";
  else                                                   out.parseConfidence = "NONE";

  return out;
}

module.exports = {
  parseContactBlock,
  firmKeyFrom,
  domainFromEmail,
  // exported for unit tests
  _internals: { isAddressLine, isLikelyPersonNameOf, firmScore, splitLines }
};
