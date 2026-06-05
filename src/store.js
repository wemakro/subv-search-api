// In-memory store — replace with Postgres/Supabase/Airtable in phase 2
const casesByDocketId = new Map();
const rawEvents       = [];

function saveDiscoveredCase(discovered) {
  const id = String(discovered.docketId);
  if (!casesByDocketId.has(id)) {
    casesByDocketId.set(id, { ...discovered, hydrated: false, hydratedAt: null });
  }
  rawEvents.push({ type: "discovered", docketId: id, at: new Date().toISOString() });
}

function saveHydratedCase(hydrated) {
  const id = String(hydrated.docketId);
  const existing = casesByDocketId.get(id) || {};
  casesByDocketId.set(id, { ...existing, ...hydrated, hydrated: true, hydratedAt: new Date().toISOString() });
  rawEvents.push({ type: "hydrated", docketId: id, at: new Date().toISOString() });
}

function getCase(docketId) {
  return casesByDocketId.get(String(docketId)) || null;
}

function listCases({ hydratedOnly = false } = {}) {
  const all = [...casesByDocketId.values()];
  return hydratedOnly ? all.filter(c => c.hydrated) : all;
}

module.exports = { saveDiscoveredCase, saveHydratedCase, getCase, listCases, rawEvents };
