// Apply the reference schema (db/schema.sql) to the configured database.
// Idempotent: schema.sql uses CREATE TABLE/INDEX IF NOT EXISTS.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "../../db/schema.sql");

async function main() {
  const config = loadConfig();
  const sql = await readFile(schemaPath, "utf8");
  const pool = createPool(config.databaseUrl);
  try {
    await pool.query(sql);
    console.log(`[migrate] applied ${path.relative(process.cwd(), schemaPath)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
