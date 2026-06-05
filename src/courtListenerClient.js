const logger = require("./logger");

const CL_BASE  = "https://www.courtlistener.com";
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || "";

const RETRY_STATUSES  = new Set([429, 500, 502, 503, 504]);
const NO_RETRY_STATUS = new Set([400, 401, 403, 404]);
const MAX_RETRIES     = 4;
const TIMEOUT_MS      = 15000;

function buildUrl(pathOrFull, params = {}) {
  const base = pathOrFull.startsWith("http") ? pathOrFull : CL_BASE + pathOrFull;
  const u = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  });
  return u.toString();
}

async function clGetJson(pathOrFull, params = {}, retryCount = 0) {
  const url = buildUrl(pathOrFull, params);
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let status, raw;
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept":        "application/json",
        "Authorization": `Token ${CL_TOKEN}`,
      },
    });
    status = resp.status;
    raw    = await resp.text();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw { clError: true, status: 0, message: "Request timed out", url };
    throw { clError: true, status: 0, message: e.message, url };
  }
  clearTimeout(timer);

  const ms = Date.now() - start;
  logger.debug(`CL ${status} ${ms}ms retry=${retryCount} ${url.replace(CL_TOKEN,"[token]")}`);

  // Retry logic
  if (RETRY_STATUSES.has(status) && retryCount < MAX_RETRIES) {
    const wait = Math.min(1000 * 2 ** retryCount, 16000);
    logger.warn(`Retrying ${status} in ${wait}ms (attempt ${retryCount + 1})`);
    await new Promise(r => setTimeout(r, wait));
    return clGetJson(pathOrFull, params, retryCount + 1);
  }

  if (NO_RETRY_STATUS.has(status)) {
    return { _clStatus: status, _clError: true, _preview: raw.slice(0, 200) };
  }

  let body;
  try { body = JSON.parse(raw); }
  catch(e) {
    throw { clError: true, status, message: "Non-JSON response", preview: raw.slice(0, 300), url };
  }

  return { ...body, _clStatus: status };
}

async function getAllPages(pathOrFull, params = {}, { maxPages = 5 } = {}) {
  const results = [];
  let url = buildUrl(pathOrFull, params);
  let page = 0;

  while (url && page < maxPages) {
    const data = await clGetJson(url);
    if (data._clError) break;
    (data.results || []).forEach(r => results.push(r));
    url = data.next || null;
    page++;
  }
  return results;
}

module.exports = { clGetJson, getAllPages, buildUrl };
