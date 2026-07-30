#!/usr/bin/env node
// One-time migration: data/tenants/*.json -> Postgres.
// Usage: DATABASE_URL=postgres://... node scripts/migrate-tenants-to-db.js
//
// Safe to re-run — saveTenant() upserts the tenants row and replaces
// (delete+reinsert) the child tables, so running this twice on the same
// files just re-writes the same data (and adds one more tenant_versions
// snapshot per run, which is fine — that's the audit trail doing its job).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const tenantStore = require("../lib/tenantStore");
const db = require("../lib/db");

const TENANTS_DIR = path.join(__dirname, "..", "data", "tenants");

async function main() {
  if (!db.isConfigured()) {
    console.error("❌ DATABASE_URL is not set — nothing to migrate to.");
    process.exit(1);
  }

  const files = fs.readdirSync(TENANTS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No tenant JSON files found — nothing to migrate.");
    return;
  }

  console.log(`Found ${files.length} tenant file(s): ${files.join(", ")}`);
  let ok = 0;
  let failed = 0;
  for (const file of files) {
    const tenantId = path.basename(file, ".json");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TENANTS_DIR, file), "utf-8"));
      await tenantStore.saveTenant(tenantId, raw, "migration-script");
      console.log(`  ✅ ${tenantId}`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${tenantId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} migrated, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Migration crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = db.getPool();
    if (pool) await pool.end();
  });
