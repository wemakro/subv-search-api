const { clGetJson } = require("./courtListenerClient");
const logger = require("./logger");
const https  = require("https");

async function fetchPdfBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "subv-crm/3.0" } }, (resp) => {
      if (resp.statusCode !== 200) return reject(new Error(`PDF fetch status ${resp.statusCode}`));
      const chunks = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function extractPdfText(url) {
  try {
    let pdfParse;
    try { pdfParse = require("pdf-parse"); }
    catch(e) {
      logger.warn("pdf-parse not available — skipping PDF extraction");
      return { text: "", method: "pdf_failed", warning: "pdf-parse not installed" };
    }
    const buf = await fetchPdfBuffer(url);
    const result = await pdfParse(buf);
    return { text: result.text || "", method: "pdf_text" };
  } catch(e) {
    logger.warn(`PDF extraction failed for ${url}: ${e.message}`);
    return { text: "", method: "pdf_failed", warning: e.message };
  }
}

async function getRecapDocumentText(recapDocumentId) {
  if (!recapDocumentId) {
    return {
      recapDocumentId: null,
      available: false,
      text: "", textPreview: "", sourceUrl: null,
      documentType: null,
      extractionMethod: "not_available",
      warnings: ["No recapDocumentId provided."],
      nextBestAction: "Manual review of CourtListener docket recommended."
    };
  }

  let doc;
  try {
    doc = await clGetJson(`/api/rest/v4/recap-documents/${recapDocumentId}/`);
  } catch(e) {
    return {
      recapDocumentId,
      available: false,
      text: "", textPreview: "", sourceUrl: null,
      documentType: null,
      extractionMethod: "not_available",
      warnings: [`Failed to fetch RECAP document: ${e.message || JSON.stringify(e).slice(0,100)}`],
      nextBestAction: "Document may be sealed, unavailable, or not in RECAP."
    };
  }

  if (!doc || doc._clError) {
    return {
      recapDocumentId,
      available: false,
      text: "", textPreview: "", sourceUrl: null,
      documentType: null,
      extractionMethod: "not_available",
      warnings: [`CourtListener returned status ${doc?._clStatus} for recap document.`],
      nextBestAction: "Controlled PACER fetch may be needed for this document."
    };
  }

  const sourceUrl = doc.absolute_url
    ? `https://www.courtlistener.com${doc.absolute_url}` : null;
  const documentType = doc.document_type || null;
  const warnings = [];

  // 1. Plain text available
  if (doc.plain_text && doc.plain_text.length > 50) {
    return {
      recapDocumentId,
      available: true,
      text: doc.plain_text,
      textPreview: doc.plain_text.slice(0, 500),
      sourceUrl,
      documentType,
      extractionMethod: "plain_text",
      warnings: []
    };
  }

  // 2. OCR text
  if (doc.ocr_status === 3 && doc.plain_text) {
    return {
      recapDocumentId,
      available: true,
      text: doc.plain_text,
      textPreview: doc.plain_text.slice(0, 500),
      sourceUrl,
      documentType,
      extractionMethod: "ocr_text",
      warnings: ["Text extracted via OCR — may contain errors."]
    };
  }

  // 3. PDF URL — attempt extraction
  const pdfUrl = doc.filepath_local
    ? `https://storage.courtlistener.com/${doc.filepath_local}`
    : doc.filepath_ia || null;

  if (pdfUrl) {
    const { text, method, warning } = await extractPdfText(pdfUrl);
    if (text.length > 50) {
      return {
        recapDocumentId,
        available: true,
        text,
        textPreview: text.slice(0, 500),
        sourceUrl,
        documentType,
        extractionMethod: method,
        warnings: warning ? [warning] : []
      };
    }
    warnings.push("PDF found but text extraction returned empty content.");
  }

  // Nothing available
  warnings.push("No plain text, OCR text, or accessible PDF found for this RECAP document.");
  return {
    recapDocumentId,
    available: false,
    text: "", textPreview: "", sourceUrl,
    documentType,
    extractionMethod: "not_available",
    warnings,
    nextBestAction: "Manual review or controlled PACER fetch may be needed."
  };
}

module.exports = { getRecapDocumentText };
