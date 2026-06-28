"use strict";
// Legacy in-memory store — kept for backward compatibility during transition
// New code should use src/data/ repositories directly
const logger = require("./logger");
const { upsertCase, getCaseByDocketId, listCases } = require("./data/caseRepository");

// Thin wrappers that call the database
async function saveDiscoveredCase(discovered) {
  try {
    await upsertCase(discovered);
  } catch(e) {
    logger.warn("saveDiscoveredCase DB error:", e.message);
  }
}

async function saveHydratedCase(hydrated) {
  try {
    await upsertCase(hydrated);
  } catch(e) {
    logger.warn("saveHydratedCase DB error:", e.message);
  }
}

async function getCase(docketId) {
  try {
    return await getCaseByDocketId(docketId);
  } catch(e) {
    logger.warn("getCase DB error:", e.message);
    return null;
  }
}

async function listCasesLegacy(opts = {}) {
  try {
    return await listCases({ limit: 200 });
  } catch(e) {
    logger.warn("listCases DB error:", e.message);
    return [];
  }
}

module.exports = {
  saveDiscoveredCase,
  saveHydratedCase,
  getCase,
  listCases: listCasesLegacy,
  rawEvents: [],
};
