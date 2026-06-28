"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

async function upsertCase(caseData) {
  const sql = `
    INSERT INTO cases (
      courtlistener_docket_id, courtlistener_absolute_url,
      case_number, case_name, debtor_name,
      chapter, is_subchapter_v, subchapterv_confidence, subchapterv_reasons,
      court_id, court_name, state,
      petition_date, assigned_judge,
      last_checked_at, raw_hydration_data, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,NOW()
    )
    ON CONFLICT (courtlistener_docket_id) DO UPDATE SET
      case_number             = COALESCE(EXCLUDED.case_number, cases.case_number),
      case_name               = COALESCE(EXCLUDED.case_name, cases.case_name),
      debtor_name             = COALESCE(EXCLUDED.debtor_name, cases.debtor_name),
      chapter                 = COALESCE(EXCLUDED.chapter, cases.chapter),
      is_subchapter_v         = EXCLUDED.is_subchapter_v,
      subchapterv_confidence  = COALESCE(EXCLUDED.subchapterv_confidence, cases.subchapterv_confidence),
      subchapterv_reasons     = COALESCE(EXCLUDED.subchapterv_reasons, cases.subchapterv_reasons),
      court_id                = COALESCE(EXCLUDED.court_id, cases.court_id),
      court_name              = COALESCE(EXCLUDED.court_name, cases.court_name),
      state                   = COALESCE(EXCLUDED.state, cases.state),
      petition_date           = COALESCE(EXCLUDED.petition_date, cases.petition_date),
      assigned_judge          = COALESCE(EXCLUDED.assigned_judge, cases.assigned_judge),
      raw_hydration_data      = COALESCE(EXCLUDED.raw_hydration_data, cases.raw_hydration_data),
      last_checked_at         = NOW(),
      updated_at              = NOW()
    RETURNING *
  `;

  const subvReasons = caseData.subchapterV?.reasons
    ? JSON.stringify(caseData.subchapterV.reasons)
    : null;

  const stateMap = {
    txsb:"TX",txnb:"TX",txeb:"TX",txwb:"TX",
    flsb:"FL",flmb:"FL",flnb:"FL",
    nysb:"NY",nyeb:"NY",nynb:"NY",nywb:"NY",
    caeb:"CA",canb:"CA",cacb:"CA",casb:"CA",
    ilnb:"IL",njb:"NJ",deb:"DE",
    vaeb:"VA",vawb:"VA",ganb:"GA",gamb:"GA",
    paeb:"PA",ohsb:"OH",ohnb:"OH",
    nceb:"NC",ncmb:"NC",mab:"MA",mdb:"MD",
    wawb:"WA",waeb:"WA",azb:"AZ",cob:"CO",
    mnb:"MN",orb:"OR",meb:"ME",ndb:"ND",
    ksb:"KS",kyeb:"KY",kywb:"KY",nvb:"NV",
    ctb:"CT",rib:"RI",hib:"HI",dcb:"DC",
    akb:"AK",utb:"UT",vtb:"VT",mtb:"MT",
    wyb:"WY",sdb:"SD",nebraskab:"NE",nmb:"NM",
    scb:"SC",tneb:"TN",tnmb:"TN",tnwb:"TN",
    innb:"IN",insb:"IN",mieb:"MI",miwb:"MI",
    moeb:"MO",mowb:"MO",laeb:"LA",lamb:"LA",lawb:"LA",
    areb:"AR",arwb:"AR",msnb:"MS",mssb:"MS",
    okeb:"OK",oknb:"OK",okwb:"OK",
    ianb:"IA",iasb:"IA",wvnb:"WV",wvsb:"WV",
    wieb:"WI",wiwb:"WI",idb:"ID",nhb:"NH",
    prb:"PR",
  };

  const params = [
    caseData.docketId || null,
    caseData.absoluteUrl || null,
    caseData.docketNumber || null,
    caseData.caseName || null,
    caseData.debtorName || null,
    caseData.chapter || null,
    caseData.subchapterV?.isLikely === true,
    caseData.subchapterV?.confidence || null,
    subvReasons,
    caseData.courtId || null,
    caseData.courtName || null,
    stateMap[caseData.courtId] || null,
    caseData.dateFiled || null,
    caseData.judge || null,
    caseData.raw_hydration_data
      ? JSON.stringify(caseData.raw_hydration_data)
      : null,
  ];

  try {
    const result = await query(sql, params);
    return result.rows[0];
  } catch(e) {
    logger.error("upsertCase failed:", e.message);
    throw e;
  }
}

async function getCaseByDocketId(docketId) {
  const result = await query(
    "SELECT * FROM cases WHERE courtlistener_docket_id = $1",
    [docketId]
  );
  return result.rows[0] || null;
}

async function getCaseById(id) {
  const result = await query("SELECT * FROM cases WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function listCases({ limit = 100, offset = 0, isSubV, needsReview } = {}) {
  let sql = "SELECT * FROM cases WHERE 1=1";
  const params = [];
  if (isSubV !== undefined) {
    params.push(isSubV);
    sql += ` AND is_subchapter_v = $${params.length}`;
  }
  if (needsReview !== undefined) {
    params.push(needsReview);
    sql += ` AND needs_review = $${params.length}`;
  }
  sql += " ORDER BY petition_date DESC NULLS LAST";
  params.push(limit);   sql += ` LIMIT $${params.length}`;
  params.push(offset);  sql += ` OFFSET $${params.length}`;
  const result = await query(sql, params);
  return result.rows;
}

async function flagForReview(caseId, reason) {
  await query(
    "UPDATE cases SET needs_review = TRUE, review_reason = $1, updated_at = NOW() WHERE id = $2",
    [reason, caseId]
  );
}

async function countCases() {
  const result = await query("SELECT COUNT(*) AS total FROM cases");
  return parseInt(result.rows[0].total, 10);
}

module.exports = {
  upsertCase,
  getCaseByDocketId,
  getCaseById,
  listCases,
  flagForReview,
  countCases,
};
