"use strict";
const { query } = require("../db/connection");
const logger    = require("../logger");

// Prevents two pipeline runs from executing simultaneously
// Uses the automation_runs table as the lock mechanism

async function acquireLock(opts = {}) {
  // Check if a run is already in progress
  const active = await query(
    `SELECT id, started_at, triggered_by
     FROM automation_runs
     WHERE status IN ('queued', 'running')
     ORDER BY started_at DESC LIMIT 1`
  );

  if (active.rows.length > 0) {
    const run = active.rows[0];
    const ageMinutes = Math.floor(
      (Date.now() - new Date(run.started_at).getTime()) / 60000
    );
    // If a run has been "running" for more than 60 minutes, it's stale — release it
    if (ageMinutes > 60) {
      logger.warn(`Stale run detected (run ${run.id}, ${ageMinutes} min old) — marking failed and proceeding`);
      await query(
        `UPDATE automation_runs
         SET status = 'failed',
             completed_at = NOW(),
             error_summary = '{"error":"Run timed out and was auto-released"}'
         WHERE id = $1`,
        [run.id]
      );
    } else {
      logger.warn(`Pipeline already running (run ${run.id}, started ${ageMinutes} min ago) — skipping`);
      return null;
    }
  }

  // Create a new run record — this is the lock
  const result = await query(
    `INSERT INTO automation_runs
       (run_type, status, search_start_date, search_end_date, triggered_by, dry_run)
     VALUES ($1, 'running', $2, $3, $4, $5)
     RETURNING *`,
    [
      opts.runType     || "daily",
      opts.startDate   || null,
      opts.endDate     || null,
      opts.triggeredBy || "cron",
      opts.dryRun      || false,
    ]
  );

  logger.info(`Pipeline lock acquired — run ID: ${result.rows[0].id}`);
  return result.rows[0];
}

async function releaseLock(runId, stats = {}) {
  const hasErrors = (stats.cases_failed || 0) > 0;
  const status    = stats.failed
    ? "failed"
    : hasErrors ? "completed_with_errors" : "completed";

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
      status,
      stats.cases_found            || 0,
      stats.new_cases_created      || 0,
      stats.existing_cases_updated || 0,
      stats.contacts_created       || 0,
      stats.contacts_updated       || 0,
      stats.cases_failed           || 0,
      stats.error_summary
        ? JSON.stringify(stats.error_summary)
        : null,
      runId,
    ]
  );

  logger.info(`Pipeline lock released — run ${runId} status: ${status}`);
  return result.rows[0];
}

module.exports = { acquireLock, releaseLock };
