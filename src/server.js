require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const routes   = require("./routes");
const logger   = require("./logger");
const { pool } = require("./db/connection");

const app  = express();
const PORT = process.env.PORT || 3000;

async function runMigrations() {
  const candidates = [
    path.join(__dirname, "db/migrations"),
    path.join(__dirname, "../src/db/migrations"),
    path.join(process.cwd(), "src/db/migrations"),
    path.join(process.cwd(), "db/migrations"),
  ];
  logger.info("__dirname: " + __dirname);
  logger.info("process.cwd(): " + process.cwd());
  let dir = null;
  for (const candidate of candidates) {
    const exists = fs.existsSync(candidate);
    logger.info(`Checking migrations path: ${candidate} — ${exists ? "FOUND" : "not found"}`);
    if (exists && !dir) dir = candidate;
  }
  if (!dir) {
    logger.error("No migrations directory found — skipping migrations");
    return;
  }
  logger.info(`Using migrations directory: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  logger.info(`Found ${files.length} migration files: ${files.join(", ")}`);
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const applied    = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
    const appliedSet = new Set(applied.rows.map(r => r.filename));
    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      logger.info(`Applying migration: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info(`Migration applied: ${file}`);
        ran++;
      } catch(e) {
        await client.query("ROLLBACK");
        logger.error(`Migration failed: ${file} — ${e.message}`);
        throw e;
      }
    }
    if (ran === 0) logger.info("All migrations already applied");
    else           logger.info(`Applied ${ran} migration(s)`);
  } finally {
    client.release();
  }
}

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","Accept","x-cron-secret"] }));
app.options("*", cors());

// Increased body size limit for large imports like trustee directory
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.static(path.join(__dirname, "../public")));

app.get("/status", (req, res) => {
  res.json({
    status:  "ok",
    service: "Sub-V Search API v3",
    token:   process.env.COURTLISTENER_TOKEN ? "set" : "missing",
    version: "3.0.0"
  });
});

app.use("/", routes);

app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err.message || err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

runMigrations()
  .then(() => {
    app.listen(PORT, () => logger.info(`Sub-V Search API v3 running on port ${PORT}`));
  })
  .catch(e => {
    logger.error("Migration failed on startup — server will not start:", e.message);
    process.exit(1);
  });
