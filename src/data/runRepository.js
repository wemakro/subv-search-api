"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

async function createRun(opts = {}) {
  const result = await query(
    `INSERT INTO automation_runs
       (run_type, status, search_start_date, search_end_date, triggered_by, dry_run)
     VALUES ($1, 'queued', $2, $3, $4, $5)
     RETURNING *`,
    [
      opts.runType     || "daily",
      opts.startDate   || null,
      opts.endDate     || null,
      opts.triggeredBy || "manual",
      opts.dryRun      || false,
    ]
  );
  return result.rows[0];
}

async function startRun(runId) {
  const result = await query(
    `UPDATE automation_runs
     SET status = 'running', started_at = NOW()
     WHERE id = $1 RETURNING *`,
    [runId]
  );
  return result.rows[0];
}

async function completeRun(runId, stats = {}) {
  const hasErrors = (stats.cases_failed || 0) > 0;
  const result = await query(
    `UPDATE automation_runs SET
       status                 = $1,
       completed_at           = NOW(),
       cases_found            = $2,
       new_cases_created      = $3,
       existing_cases_updated = $4,
       contacts_created       = $5,
       contacts_updated       = $6,
       cases_failed           = $7,
       error_summary          = $8
     WHERE id = $9 RETURNING *`,
    [
      hasErrors ? "completed_with_errors" : "completed",
      stats.cases_found            || 0,
      stats.new_cases_created      || 0,
      stats.existing_cases_updated || 0,
      stats.contacts_created       || 0,
      stats.contacts_updated       || 0,
      stats.cases_failed           || 0,
      stats.error_summary ? JSON.stringify(stats.error_summary) : null,
      runId,
    ]
  );
  return result.rows[0];
}

async function failRun(runId, errorMessage) {
  const result = await query(
    `UPDATE automation_runs SET
       status = 'failed', completed_at = NOW(),
       error_summary = $1
     WHERE id = $2 RETURNING *`,
    [JSON.stringify({ error: errorMessage }), runId]
  );
  return result.rows[0];
}

async function getActiveRun() {
  const result = await query(
    `SELECT * FROM automation_runs
     WHERE status IN ('queued','running')
     ORDER BY started_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function getLastSuccessfulRun() {
  const result = await query(
    `SELECT * FROM automation_runs
     WHERE status IN ('completed','completed_with_errors')
     ORDER BY completed_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function listRuns(limit = 20) {
  const result = await query(
    `SELECT * FROM automation_runs
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  createRun,
  startRun,
  completeRun,
  failRun,
  getActiveRun,
  getLastSuccessfulRun,
  listRuns,
};
