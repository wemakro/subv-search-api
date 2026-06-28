"use strict";
require("dotenv").config();
const fs     = require("fs");
const path   = require("path");
const { pool } = require("./connection");
const logger   = require("../logger");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function migrate() {
  const client = await pool.connect();
  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const applied = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
    const appliedSet = new Set(applied.rows.map(r => r.filename));

    // Get all migration files sorted
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.info(`Migration already applied: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      logger.info(`Applying migration: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        logger.info(`Migration applied: ${file}`);
        ran++;
      } catch(e) {
        await client.query("ROLLBACK");
        logger.error(`Migration failed: ${file} — ${e.message}`);
        throw e;
      }
    }

    if (ran === 0) {
      logger.info("All migrations already applied — database is up to date");
    } else {
      logger.info(`Applied ${ran} migration(s) successfully`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => {
  logger.error("Migration runner failed:", e.message);
  process.exit(1);
});
