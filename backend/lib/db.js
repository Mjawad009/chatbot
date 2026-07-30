// Thin Postgres pool wrapper. Follows the same "unconfigured = feature
// off, not a crash" convention as lib/kv.js and lib/kbClient.js elsewhere
// in this codebase — if DATABASE_URL isn't set, isConfigured() returns
// false and callers (tenantStore) fall back to the legacy JSON-file store,
// so this can roll out gradually without a hard cutover.
const { Pool } = require("pg");

let pool = null;

function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isConfigured()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
    pool.on("error", (err) => {
      // A dropped idle connection must not crash the process — pg's Pool
      // emits 'error' for that instead of throwing, and the docs are
      // explicit that you must handle it or the whole app dies.
      console.error("⚠️  Postgres pool error (idle client):", err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error("Database is not configured (DATABASE_URL unset).");
  return p.query(text, params);
}

// Runs `fn` inside a transaction, passing it a client to use for every
// query. Commits on success, rolls back on any thrown error — callers
// (tenantStore.saveTenant) rely on this so a save either fully succeeds
// (all tables + version snapshot) or leaves nothing partially written.
async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error("Database is not configured (DATABASE_URL unset).");
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Data residency: optional per-tenant dedicated database -----------
// Most tenants share the one pool above. A tenant with
// tenant_meta.dataResidency.databaseUrl set gets queries for
// leads/conversation_messages routed to THEIR OWN Postgres instead (see
// lib/activityStore.js) — everything else (tenant config itself) always
// stays in the shared pool; see db/schema-tenant-dedicated.sql for why.
//
// Pools are cached by connection string so repeated calls for the same
// tenant reuse one pool rather than opening a fresh connection per query
// — the same reason the shared pool above is a singleton, just keyed
// instead of global.
const dedicatedPools = new Map(); // connectionString -> Pool

function getTenantPool(connectionString) {
  if (!connectionString) return null;
  if (!dedicatedPools.has(connectionString)) {
    const p = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 5), // smaller default than the shared pool — one tenant's traffic, not everyone's
    });
    p.on("error", (err) => {
      console.error("⚠️  Postgres pool error on a dedicated tenant database:", err.message);
    });
    dedicatedPools.set(connectionString, p);
  }
  return dedicatedPools.get(connectionString);
}

// Resolves which pool a query should use: the tenant's dedicated one if
// they have `dataResidency.databaseUrl` configured, the shared default
// otherwise. This is the one function activityStore.js calls instead of
// deciding shared-vs-dedicated itself in multiple places.
function poolFor(dedicatedUrl) {
  return dedicatedUrl ? getTenantPool(dedicatedUrl) : getPool();
}

async function queryOn(dedicatedUrl, text, params) {
  const p = poolFor(dedicatedUrl);
  if (!p) throw new Error("Database is not configured.");
  return p.query(text, params);
}

module.exports = { isConfigured, getPool, query, withTransaction, getTenantPool, poolFor, queryOn };
