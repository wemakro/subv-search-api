"use strict";
const { Pool } = require("pg");
const logger   = require("../logger");

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  "";

if (!connectionString) {
  logger.warn("DATABASE_URL not set — database features will be unavailable");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("render.com") || connectionString.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", function(err) {
  logger.error("Unexpected PostgreSQL pool error:", err.message);
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

async function getClient() {
  return await pool.connect();
}

async function testConnection() {
  try {
    const result = await query("SELECT NOW() AS now");
    logger.info("PostgreSQL connected — server time: " + result.rows[0].now);
    return true;
  } catch(e) {
    logger.error("PostgreSQL connection failed:", e.message);
    return false;
  }
}

module.exports = { query, getClient, testConnection, pool };
