/**
 * Insight Bot — Multi-Tenant Survey Chatbot Backend
 * ---------------------------------------------------
 * Single Express service that:
 *   1. Loads one JSON dataset per tenant from data/tenants/*.json at boot,
 *      including an optional per-tenant provider/model/API-key chain.
 *   2. Builds a rigid, tenant-specific system prompt per request.
 *   3. Streams a response from an OpenAI-compatible chat completions API
 *      straight through to the browser as plain text chunks, with automatic
 *      failover across a configurable provider chain.
 *   4. Serves the embeddable widget itself (public/widget.js) plus demo tenant
 *      pages — this is now the ONLY thing that needs to be deployed.
 *
 * Failover design: each provider entry gets OpenRouter's own native `models`
 * array (in-request fallback across models on the SAME provider — handles
 * rate limits/downtime/moderation in one HTTP call). If that whole provider
 * fails outright (network error, auth failure, or a non-2xx before any bytes
 * were streamed back), we move to the next configured provider entry. Once
 * bytes have started streaming to the client we do NOT switch providers
 * mid-response — that's handled by the client's own retry-on-failure logic.
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
require("dotenv").config();

const { classifyIntent, isAffirmative } = require("./lib/intent");
const { getAutomations, matchAutomation, getAutomationById } = require("./lib/automations");
const automationState = require("./lib/automationState");
const { extractKnownFields, structureFieldAnswers, mergeStructured, cleanFieldAnswer } = require("./lib/automationFields");
const { detectCancelIntent, looksLikePlausibleAnswer, classifyFieldReply, answerDigression } = require("./lib/digressionHandler");
const { fieldQuestionText, looksLikeTimeField, confirmationSummary, executeAutomation } = require("./lib/automationExecutor");
const { generateAvailableSlots } = require("./lib/availability");
const { estimateCostUsd, getPricingMeta } = require("./lib/modelPricing");
const { dispatchLead } = require("./lib/notifiers");
const { kvGet, kvSet, kvDelete, kvAppendAndCountRecent, kvCountRecent, isRedisActive } = require("./lib/kv");
const kbClient = require("./lib/kbClient");
const tenantStore = require("./lib/tenantStore");
const activityStore = require("./lib/activityStore");
const { resolveProviderEntry, streamFromProviderChain, providerSemaphore } = require("./lib/providerChain");
const { sanitizeMessages } = require("./lib/sanitizeMessages");

const app = express();
app.set("trust proxy", 1); // Railway (and most PaaS) sit behind a proxy — without this, req.ip is
                            // always the proxy's address and every visitor shares one rate-limit bucket.
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
// The fallback tenant used when a request omits tenantId (mainly a dev/test
// convenience — real widget embeds always pass their own tenantId via
// data-tenant). Was "default" back when that was a placeholder demo tenant;
// repointed to a real tenant now that both actual tenants are real clients.
const DEFAULT_TENANT = "edu-consultancy-demo";

// ---------------------------------------------------------------------------
// Logging — append-only JSONL files, one line per event.
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "logs");
const CONVERSATION_LOG = path.join(LOG_DIR, "conversations.log");
const ERROR_LOG = path.join(LOG_DIR, "errors.log");
const LEAD_LOG = path.join(LOG_DIR, "leads.log");
const SECURITY_LOG = path.join(LOG_DIR, "security.log");
const FEEDBACK_LOG = path.join(LOG_DIR, "feedback.log");
const AUTOMATION_LOG = path.join(LOG_DIR, "automation_executions.log");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error("❌ Could not create logs directory:", err.message);
}

function appendLog(filePath, entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFile(filePath, line, (err) => {
    if (err) console.error(`❌ Failed to write log (${filePath}):`, err.message);
  });
}
function logConversation(entry) {
  appendLog(CONVERSATION_LOG, entry);
  if (activityStore.isConfigured() && (entry.userMessage || entry.assistantResponse)) {
    // Resolve the tenant to check for a dedicated database (data
    // residency) — see lib/activityStore.js's dedicatedDatabaseUrl param.
    // Falls through to the shared pool for tenants without one, and for
    // the (should-never-happen) case of an unknown tenantId slipping
    // through to here.
    const tenant = getTenant(entry.tenantId);
    activityStore
      .recordConversationTurn(
        {
          tenantId: entry.tenantId,
          sessionId: entry.sessionId,
          userMessage: entry.userMessage,
          assistantResponse: entry.assistantResponse,
        },
        tenant?.dataResidency?.databaseUrl
      )
      .catch((err) => console.error("❌ DB conversation write failed (file log still succeeded):", err.message));
  }
}
// logError writes FULL technical detail to disk + stderr only. Nothing from
// here is ever sent verbatim to the browser — see FRIENDLY_ERROR_MESSAGES below.
function logError(entry) {
  appendLog(ERROR_LOG, entry);
  console.error(`[${entry.context || "error"}]`, entry.message || entry);
}
// Escalation hand-offs (a visitor asked for a human + left an email).
// Local log write always happens (same-request-cycle backup); additionally
// fans out to whichever channels this tenant has enabled (email, WhatsApp,
// a generic webhook) — see lib/notifiers/. Fire-and-forget: a slow or
// failing notifier should never delay or break the chat response.
function logLead(entry, tenant) {
  appendLog(LEAD_LOG, entry);
  if (activityStore.isConfigured()) {
    const { tenantId, sessionId, ...fields } = entry;
    activityStore
      .recordLead({ tenantId, sessionId, fields }, tenant?.dataResidency?.databaseUrl)
      .catch((err) => console.error("❌ DB lead write failed (file log still succeeded):", err.message));
  }
  if (tenant) {
    dispatchLead(tenant, entry, { logSecurity }).catch((err) => {
      console.error("❌ dispatchLead failed unexpectedly:", err.message);
    });
  }
}
// Every automation run (booking, escalation, or any admin-defined n8n/API
// automation), regardless of whether it's lead-worthy. Deliberately
// separate from leads.log — a routine "check my order status" run isn't a
// sales lead and shouldn't be mixed into that log or fire notifications
// unless the automation explicitly opts in (automation.notifyOnExecution).
function logExecution(entry) {
  appendLog(AUTOMATION_LOG, entry);
}
// Guardrail trips — prompt-injection attempts caught before reaching the LLM.
// Kept separate from errors.log so it can be monitored/alerted on independently.
function logSecurity(entry) {
  appendLog(SECURITY_LOG, entry);
  console.warn(`[security:${entry.context || "guardrail"}]`, entry.message || "");
}
function logFeedback(entry) {
  appendLog(FEEDBACK_LOG, entry);
}

// User-facing messages — deliberately generic. Real detail only ever goes to logs.
const FRIENDLY_ERROR_MESSAGES = {
  validation: "That request didn't look quite right. Please try rephrasing your question.",
  upstream: "I'm having trouble reaching the AI service right now. Please try again in a moment.",
  timeout: "That took longer than expected. Please try again — shorter questions usually respond faster.",
  exception: "Something went wrong on my end. Please try again in a moment.",
  config: "This assistant isn't fully configured yet. Please let the site owner know.",
  all_providers_failed: "I'm temporarily unable to reach the AI service. Please try again shortly.",
};

// ---------------------------------------------------------------------------
// 1. Load every tenant's dataset + provider chain from data/tenants/*.json.
// ---------------------------------------------------------------------------
const TENANTS_DIR = path.join(__dirname, "data", "tenants");
let tenants = new Map(); // reassigned wholesale on reload — see reloadTenants() below

// System-prompt construction and the engagement-signal detector now live in
// lib/systemPrompts.js (extracted out of this file's original monolith —
// both are pure functions with no dependency on the tenants Map or
// request/response state).
const { buildSystemPrompt, detectEngagementSignal } = require("./lib/systemPrompts");

async function buildTenantsMap() {
  const globalDefaults = {
    apiUrl: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
    // Used for background/internal work (booking field extraction, etc.) —
    // never user-facing, so a free-tier model is the right default: no
    // reason to spend Gemini-tier cost on a task the customer never reads
    // the raw output of. Override per-tenant via tenant_meta.internalProvider.
    internalModel: process.env.OPENROUTER_INTERNAL_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
  };

  const next = new Map();

  // DB-first, file-fallback — see lib/tenantStore.js. Unset DATABASE_URL
  // keeps this on the original file-based path with zero behavior change;
  // once it's set, run scripts/migrate-tenants-to-db.js once and every
  // reload after that reads from Postgres instead.
  let rawTenants;
  if (tenantStore.isConfigured()) {
    rawTenants = await tenantStore.loadAllTenants();
    if (rawTenants.length === 0) {
      throw new Error("No tenants found in the database — run scripts/migrate-tenants-to-db.js, or add one via the admin panel.");
    }
  } else {
    let files = [];
    try {
      files = fs.readdirSync(TENANTS_DIR).filter((f) => f.endsWith(".json"));
    } catch (err) {
      throw new Error(`Could not read tenants directory (${TENANTS_DIR}): ${err.message}`);
    }
    if (files.length === 0) {
      throw new Error(`No tenant JSON files found in ${TENANTS_DIR}`);
    }
    rawTenants = files.map((file) => ({
      id: path.basename(file, ".json"),
      raw: JSON.parse(fs.readFileSync(path.join(TENANTS_DIR, file), "utf-8")),
    }));
  }

  for (const { id: tenantId, raw } of rawTenants) {
    try {
      const { tenant_meta = {}, suggested_questions = [], ...surveyPayload } = raw;

      // Provider chain: tenant's own "provider" (primary) + optional "fallbackProviders" (tried
      // in order only if the primary provider fails outright), then a built-in generic
      // free-model safety net so a tenant with zero config still gets *some* resilience.
      const providerConfigs = [];
      if (tenant_meta.provider) providerConfigs.push(tenant_meta.provider);
      if (Array.isArray(tenant_meta.fallbackProviders)) providerConfigs.push(...tenant_meta.fallbackProviders);
      if (providerConfigs.length === 0) providerConfigs.push({}); // pure global defaults

      const providerChain = providerConfigs.map((p) => resolveProviderEntry(p, globalDefaults));

      // Separate, cheaper provider for internal/background work (currently:
      // booking field extraction). Defaults to a free model regardless of
      // what the primary chat provider is — falls back to the primary
      // provider's API key/URL if the tenant hasn't set one explicitly.
      const internalProviderRaw = tenant_meta.internalProvider || {};
      const internalProvider = resolveProviderEntry(
        { ...internalProviderRaw, models: internalProviderRaw.models || [globalDefaults.internalModel] },
        { apiUrl: globalDefaults.apiUrl, apiKey: providerChain[0]?.apiKey || globalDefaults.apiKey, model: globalDefaults.internalModel }
      );

      // Always append one more safety-net models array on the primary provider's own apiUrl/key,
      // widening OpenRouter's own in-request fallback without needing tenant config.
      if (providerChain[0] && providerChain[0].apiUrl === globalDefaults.apiUrl) {
        const extras = ["deepseek/deepseek-r1:free", "qwen/qwen-2.5-72b-instruct:free"].filter(
          (m) => !providerChain[0].models.includes(m)
        );
        providerChain[0].models = [...providerChain[0].models, ...extras];
      }

      if (tenant_meta.useKbOnly && !kbClient.isConfigured()) {
        console.warn(`⚠️  Tenant "${tenantId}" has useKbOnly:true but the KB service isn't configured (KB_SERVICE_URL unset) — this tenant's system prompt will have NO content injected at all until either is fixed.`);
      }

      next.set(tenantId, {
        title: tenant_meta.widget_title || "Insight Bot",
        subtitle: tenant_meta.widget_subtitle || "Survey Data Analyst",
        suggestedQuestions: Array.isArray(suggested_questions) ? suggested_questions : [],
        systemPrompt: buildSystemPrompt(surveyPayload, tenant_meta.persona, tenant_meta.vertical, tenant_meta.masterPrompt, !!tenant_meta.useKbOnly),
        useKbOnly: !!tenant_meta.useKbOnly,
        meta: surveyPayload.survey_meta || {},
        providerChain,
        internalProviderChain: [internalProvider],
        // Optional. If set, /api/chat rejects browser requests whose Origin
        // header isn't in this list. Leave unset during local dev; set it
        // to the tenant's real site domain(s) before pointing production
        // traffic at this backend.
        allowedOrigins: Array.isArray(tenant_meta.allowedOrigins) ? tenant_meta.allowedOrigins : null,
        // Per-tenant public-widget auth token — see isWidgetKeyValid() below.
        // null = not configured = open (same convention as allowedOrigins).
        widgetKey: typeof tenant_meta.widgetKey === "string" && tenant_meta.widgetKey ? tenant_meta.widgetKey : null,
        // Optional dedicated infra for this tenant's END-USER data (leads,
        // conversation transcripts) — NOT their config, which always stays
        // in the shared platform DB. See db/schema-tenant-dedicated.sql.
        dataResidency: tenant_meta.dataResidency && typeof tenant_meta.dataResidency === "object" ? tenant_meta.dataResidency : {},
        // Per-tenant notifier config — see lib/notifiers/. Each key (email,
        // whatsapp, webhook) is independently enable-able with its own
        // credentials. Admin-panel-editable; see /api/admin/tenant/:id.
        integrations: tenant_meta.integrations && typeof tenant_meta.integrations === "object" ? tenant_meta.integrations : {},
        vertical: tenant_meta.vertical === "consultancy" ? "consultancy" : "survey",
        // Optional — weekly business-hours schedule used to suggest concrete
        // time slots during booking-like automations. See lib/availability.js
        // for defaults and shape. Falls back to sensible defaults if unset.
        bookingAvailability: tenant_meta.booking?.availability && typeof tenant_meta.booking.availability === "object"
          ? tenant_meta.booking.availability
          : {},
        // The Automations framework — booking/escalation are now just the
        // two default automations here (see lib/automations.js), not
        // special-cased branches. A tenant's tenant_meta.automations array
        // can disable them, change their triggers, or add entirely new
        // ones (n8n/API-backed) without any code change.
        automations: getAutomations(tenant_meta),
        // Optional — hex colors overriding the widget's default palette.
        // Admin-panel-editable via tenant_meta.branding.theme. See
        // public/widget.js's applyTheme() for exactly what this can and
        // can't re-color (documented there — not full coverage yet).
        theme: tenant_meta.branding?.theme && typeof tenant_meta.branding.theme === "object" ? tenant_meta.branding.theme : null,
      });

      if (!Array.isArray(tenant_meta.allowedOrigins) || tenant_meta.allowedOrigins.length === 0) {
        console.warn(`⚠️  Tenant "${tenantId}" has no tenant_meta.allowedOrigins set — /api/chat is open to requests from any origin. Fine for local dev; set this before going live.`);
      }

      console.log(`✅ Loaded tenant "${tenantId}": "${surveyPayload.survey_meta?.title || "(untitled)"}" — ${providerChain.length} provider(s), primary models: [${providerChain[0].models.join(", ")}]`);
    } catch (err) {
      console.error(`❌ Failed to load tenant "${tenantId}":`, err.message);
    }
  }

  if (!next.has(DEFAULT_TENANT)) {
    throw new Error(`No tenant named "${DEFAULT_TENANT}" found (checked ${tenantStore.isConfigured() ? "the database" : "data/tenants/*.json"}) — at least one tenant with this id is required as the fallback for requests that omit tenantId.`);
  }

  return next;
}

// Boot: a bad tenants directory/DB should fail loudly and stop the process
// — you want this in Railway's boot logs, not a half-started server.
(async () => {
  try {
    tenants = await buildTenantsMap();
    startServer();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
})();

// Hot reload (used by the admin panel below): re-reads tenants from the DB
// (or data/tenants/*.json, if no DATABASE_URL) without a restart.
// Deliberately builds into a fresh Map and only swaps it in on full success
// — a bad edit to one tenant can never take down tenants that were already
// serving traffic.
async function reloadTenants() {
  const next = await buildTenantsMap(); // throws on fatal — caller decides how to report it
  tenants = next;
  return { tenantIds: [...tenants.keys()] };
}

function getTenant(tenantId) {
  return tenants.get(tenantId) || null;
}

// ---------------------------------------------------------------------------
// 2. Static file serving — the widget + demo tenant pages.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// 3. Health check + tenant listing
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    redis: isRedisActive() ? "connected" : "in-memory fallback",
    tenants: [...tenants.entries()].map(([id, t]) => ({
      tenantId: id,
      title: t.meta.title || t.title,
      providersConfigured: t.providerChain.length,
      apiKeyConfigured: t.providerChain.every((p) => Boolean(p.apiKey)),
    })),
  });
});

app.get("/api/tenant-config", (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId ? req.query.tenantId : DEFAULT_TENANT;
  const tenant = getTenant(tenantId);
  if (!tenant) {
    return res.status(404).json({ error: `Unknown tenantId "${tenantId}". Available: ${[...tenants.keys()].join(", ")}` });
  }
  if (!isWidgetKeyValid(tenant, req.headers["x-widget-key"])) {
    logSecurity({ context: "widget_key_invalid", tenantId, message: "Missing or incorrect X-Widget-Key on /api/tenant-config" });
    return res.status(403).json({ error: "Not authorized for this tenant." });
  }
  res.json({
    tenantId,
    title: tenant.title,
    subtitle: tenant.subtitle,
    suggestedQuestions: tenant.suggestedQuestions,
    theme: tenant.theme,
  });
});

// ---------------------------------------------------------------------------
// Feedback — thumbs up/down on a bot response. Purely additive: logs to
// feedback.log, never throws in a way that could break the chat UI.
// ---------------------------------------------------------------------------
app.post("/api/feedback", (req, res) => {
  const { sessionId, tenantId, rating, messageExcerpt, comment } = req.body || {};
  const sid = typeof sessionId === "string" && sessionId ? sessionId : "unknown";
  const tid = typeof tenantId === "string" && tenantId ? tenantId : DEFAULT_TENANT;

  const tenant = getTenant(tid);
  if (tenant && !isWidgetKeyValid(tenant, req.headers["x-widget-key"])) {
    logSecurity({ context: "widget_key_invalid", sessionId: sid, tenantId: tid, message: "Missing or incorrect X-Widget-Key on /api/feedback" });
    return res.status(403).json({ error: "Not authorized for this tenant." });
  }

  if (rating !== "up" && rating !== "down") {
    return res.status(400).json({ error: "rating must be 'up' or 'down'" });
  }

  logFeedback({
    sessionId: sid,
    tenantId: tid,
    rating,
    messageExcerpt: typeof messageExcerpt === "string" ? messageExcerpt.slice(0, 500) : undefined,
    comment: typeof comment === "string" ? comment.slice(0, 1000) : undefined,
  });

  res.json({ ok: true });
});

function readLastLines(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch {
    return [];
  }
}
// ---------------------------------------------------------------------------
// Admin auth — real session-based login instead of the browser's native
// Basic Auth popup. Basic Auth has no logout, doesn't survive cleanly
// across tabs/redeploys, and re-sends credentials on every single request —
// none of which is how any actual admin panel (Django admin, Retool,
// Supabase Studio) does it. This is the same shape they use, just without
// pulling in a session-store dependency: a random token, held server-side
// with a TTL, referenced by a signed httpOnly cookie.
//
// Still deliberately single-operator: one shared ADMIN_USERNAME/PASSWORD,
// no per-user accounts. That's a real limitation if this ever needs more
// than one admin — worth revisiting then, not now.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "insightbot_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// ^ If unset, a random secret is generated at boot — fine for a single
// instance, but it means every restart invalidates existing sessions (you
// just get asked to log in again, nothing breaks). Set ADMIN_SESSION_SECRET
// in Railway once you're running multiple instances or want sessions to
// survive a restart.

function signToken(token) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

const ADMIN_LOCKOUT_THRESHOLD = 5;
const ADMIN_LOCKOUT_WINDOW_SECONDS = 5 * 60;

app.post("/api/admin/login", async (req, res) => {
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return res.status(503).json({ error: "Admin panel not configured — set ADMIN_USERNAME and ADMIN_PASSWORD." });
  }

  // Lockout is checked BEFORE credentials are even looked at — a correct
  // password submitted during an active lockout still gets rejected. This
  // is deliberate (verified behavior from before the Redis migration): an
  // attacker who's burned their attempts doesn't get a "just guess right
  // once more" loophole.
  const recentFailures = await kvCountRecent(`adminfail:${req.ip}`, ADMIN_LOCKOUT_WINDOW_SECONDS);
  if (recentFailures >= ADMIN_LOCKOUT_THRESHOLD) {
    logSecurity({ context: "admin_lockout", message: `IP ${req.ip} locked out after ${recentFailures} failed admin login attempts` });
    return res.status(429).json({ error: "Too many failed attempts — try again in a few minutes." });
  }

  const { username, password } = req.body || {};
  if (username === user && password === pass) {
    const token = crypto.randomBytes(24).toString("hex");
    await kvSet(`adminsession:${token}`, { createdAt: Date.now() }, SESSION_TTL_MS / 1000);
    const signature = signToken(token);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}.${signature}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${req.secure ? "; Secure" : ""}`
    );
    return res.json({ ok: true });
  }

  await kvAppendAndCountRecent(`adminfail:${req.ip}`, ADMIN_LOCKOUT_WINDOW_SECONDS);
  logSecurity({ context: "admin_login_failed", message: `Failed admin login from IP ${req.ip}` });
  return res.status(401).json({ error: "Invalid username or password." });
});

app.post("/api/admin/logout", async (req, res) => {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE] || "";
  const [token] = raw.split(".");
  if (token) await kvDelete(`adminsession:${token}`);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

async function adminAuth(req, res, next) {
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return res.status(503).json({ error: "Admin panel not configured — set ADMIN_USERNAME and ADMIN_PASSWORD." });
  }

  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE] || "";
  const [token, signature] = raw.split(".");
  if (token && signature && signature === signToken(token)) {
    const entry = await kvGet(`adminsession:${token}`);
    if (entry) return next();
  }

  return res.status(401).json({ error: "Not logged in or session expired." });
}

app.get("/api/logs/summary", adminAuth, (req, res) => {
  const n = Math.min(Number(req.query.n) || 10, 100);
  res.json({
    recentConversations: readLastLines(CONVERSATION_LOG, n),
    recentErrors: readLastLines(ERROR_LOG, n),
  });
});

// ---------------------------------------------------------------------------
// Admin panel — internal use only (you, not tenants). /admin/login is public
// (that's the login form itself); everything else requires a valid session.
// ---------------------------------------------------------------------------
app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "login.html"));
});

async function adminPageAuth(req, res, next) {
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return res.status(503).send("Admin panel not configured — set ADMIN_USERNAME and ADMIN_PASSWORD.");
  }
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE] || "";
  const [token, signature] = raw.split(".");
  const entry = token && signature === signToken(token) ? await kvGet(`adminsession:${token}`) : null;
  if (!entry) {
    return res.redirect("/admin/login");
  }
  next();
}

app.get("/admin", adminPageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});

app.get("/admin/analytics", adminPageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "analytics.html"));
});

app.get("/admin/knowledge", adminPageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "knowledge.html"));
});

app.get("/admin/automations", adminPageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "automations.html"));
});


const { computeAnalytics } = require("./lib/analytics");

// Powers the sidebar status rail in the admin UI — a quick honest read of
// which optional infra is actually configured/reachable right now, since
// this app is designed to run fine with any subset of DB/Redis/KB Service
// present. isRedisActive/kbClient.health() are cheap; the DB check is a
// trivial SELECT 1, not a full round-trip through tenantStore.
app.get("/api/admin/status", adminAuth, async (req, res) => {
  const status = { db: "unconfigured", redis: "unconfigured", kbService: "unconfigured" };

  if (tenantStore.isConfigured()) {
    try {
      await require("./lib/db").query("SELECT 1");
      status.db = "connected";
    } catch {
      status.db = "error";
    }
  }
  status.redis = isRedisActive() ? "connected" : "unconfigured";
  if (kbClient.isConfigured()) {
    const health = await kbClient.health();
    status.kbService = health.ok ? "connected" : "error";
  }

  res.json({ status, tenantCount: tenants.size });
});

app.get("/api/admin/overview", adminAuth, (req, res) => {
  const tenantList = [...tenants.entries()].map(([id, t]) => ({
    id,
    title: t.title,
    subtitle: t.subtitle,
    surveyTitle: t.meta?.title || null,
    providerCount: t.providerChain.length,
    primaryModels: t.providerChain[0]?.models || [],
    suggestedQuestionCount: t.suggestedQuestions.length,
    allowedOrigins: t.allowedOrigins, // null = open to any origin
    unprotectedOrigin: !Array.isArray(t.allowedOrigins) || t.allowedOrigins.length === 0,
    enabledIntegrations: Object.entries(t.integrations || {}).filter(([, c]) => c?.enabled).map(([name]) => name),
    widgetKey: t.widgetKey, // shown so the admin panel can render the real embed snippet; this route is adminAuth-gated
    dataResidency: {
      dedicatedDatabase: !!t.dataResidency?.databaseUrl,
      dedicatedVectorDb: !!t.dataResidency?.qdrantUrl,
    },
  }));
  res.json({
    tenantCount: tenants.size,
    tenants: tenantList,
    rateLimitPerMinute: RATE_LIMIT_MAX,
  });
});

app.get("/api/admin/analytics", adminAuth, (req, res) => {
  const tenantId = req.query.tenantId || "all";
  if (tenantId !== "all" && !tenants.has(tenantId)) {
    return res.status(400).json({ error: `Unknown tenantId "${tenantId}"` });
  }
  const daysParam = req.query.days;
  const days = daysParam === "all" ? null : Number(daysParam) || 30;

  const result = computeAnalytics({
    logPaths: { conversations: CONVERSATION_LOG, leads: LEAD_LOG, feedback: FEEDBACK_LOG, security: SECURITY_LOG },
    tenantId,
    days,
  });
  res.json({ ...result, costEstimatePricing: getPricingMeta() });
});

const ADMIN_LOG_FILES = {
  conversations: CONVERSATION_LOG,
  errors: ERROR_LOG,
  leads: LEAD_LOG,
  security: SECURITY_LOG,
  feedback: FEEDBACK_LOG,
  automation_executions: AUTOMATION_LOG,
};

app.get("/api/admin/logs", adminAuth, async (req, res) => {
  const type = req.query.type || "conversations";
  const file = ADMIN_LOG_FILES[type];
  if (!file) {
    return res.status(400).json({ error: `Unknown log type. Use one of: ${Object.keys(ADMIN_LOG_FILES).join(", ")}` });
  }
  const n = Math.min(Number(req.query.n) || 25, 200);
  const tenantId = req.query.tenantId;

  // Leads specifically are DB-backed once configured (see activityStore) —
  // durable across redeploys. Other log types (conversations, errors,
  // security, feedback, automation runs) stay file-based for now; the DB
  // only captures role/content for conversations, not the full metrics
  // (tokens, cost, duration) the file log line has, so reading from DB
  // there would silently lose columns the table already shows.
  if (type === "leads" && activityStore.isConfigured()) {
    try {
      // A specific tenant with a dedicated database (data residency) has
      // their leads there, not in the shared pool — route to it. An "all
      // tenants" or unfiltered view only queries the shared pool; see
      // activityStore.js's listLeads comment for why this doesn't fan out
      // across every dedicated database automatically.
      const targetTenant = tenantId && tenantId !== "all" ? getTenant(tenantId) : null;
      const entries = await activityStore.listLeads(tenantId, n, targetTenant?.dataResidency?.databaseUrl);
      if (entries !== null) return res.json({ type, entries, source: "db" });
    } catch (err) {
      console.error("❌ DB lead read failed, falling back to file:", err.message);
    }
  }

  if (req.query.sessionId) {
    // A single session's transcript, read chronologically (oldest first) —
    // this is for the conversation viewer (Section: rendered as chat
    // bubbles, not a log table), so it needs to read top-to-bottom the way
    // the conversation actually happened, unlike every other log view here
    // which is newest-first. Same full-file-scan tradeoff as the tenantId
    // filter below — fine at this log volume, revisit if it ever isn't.
    if (!fs.existsSync(file)) return res.json({ type, entries: [] });
    const all = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => e.sessionId === req.query.sessionId);
    return res.json({ type, entries: all }); // already in file (= chronological) order
  }

  if (tenantId && tenantId !== "all") {
    // Filtering by tenant needs the full file (a tail of the raw file could
    // miss that tenant's entries entirely if other tenants are noisier) —
    // same tradeoff analytics.js already accepts at this log volume.
    if (!fs.existsSync(file)) return res.json({ type, entries: [] });
    const all = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => e.tenantId === tenantId);
    return res.json({ type, entries: all.slice(-n).reverse() });
  }

  res.json({ type, entries: readLastLines(file, n).reverse() }); // newest first for the dashboard
});

app.post("/api/admin/reload-tenants", adminAuth, async (req, res) => {
  try {
    const result = await reloadTenants();
    console.log(`🔄 Tenants hot-reloaded via admin panel: [${result.tenantIds.join(", ")}]`);
    res.json({ ok: true, ...result });
  } catch (err) {
    // Reload failed — the PREVIOUS tenants map is still live and untouched,
    // so the service keeps serving existing traffic normally.
    console.error(`❌ Tenant reload failed (previous config still active): ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tenant file editor — lets the admin panel add a brand-new tenant or edit
// an existing one's raw JSON (master prompt/persona, branding, integrations,
// everything) without touching the filesystem by hand. Every write is
// JSON-validated BEFORE it touches disk, and every write triggers the same
// safe hot-reload used by the button above — an invalid save never corrupts
// a working tenant file, and a bad tenant never takes down the others.
// ---------------------------------------------------------------------------
const SAFE_TENANT_ID = /^[a-z0-9][a-z0-9-_]{1,63}$/i;

function tenantFilePath(tenantId) {
  if (!SAFE_TENANT_ID.test(tenantId)) return null;
  return path.join(TENANTS_DIR, `${tenantId}.json`);
}

// ---------------------------------------------------------------------------
// KB Service proxy — the browser only ever talks to these routes, never to
// the KB Service directly. kbClient.js attaches KB_SERVICE_API_KEY
// server-side; it never appears in any response below. Every route degrades
// gracefully (503 + clear message) if the KB Service is unreachable rather
// than throwing a raw error.
// ---------------------------------------------------------------------------
const kbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.get("/api/admin/kb/health", adminAuth, async (req, res) => {
  if (!kbClient.isConfigured()) {
    return res.json({ configured: false, status: "not configured" });
  }
  const result = await kbClient.health();
  res.json({ configured: true, status: result.ok ? "connected" : "unreachable", detail: result.ok ? result.data : result.error });
});

app.post("/api/admin/kb/:tenantId/upload", adminAuth, kbUpload.single("file"), async (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) {
    return res.status(400).json({ error: `Unknown tenantId "${req.params.tenantId}"` });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file provided (expected multipart field 'file')" });
  }
  const country = typeof req.body?.country === "string" && req.body.country.trim() ? req.body.country.trim() : undefined;
  const category = typeof req.body?.category === "string" && req.body.category.trim() ? req.body.category.trim() : undefined;
  const result = await kbClient.uploadFile(req.params.tenantId, req.file.buffer, req.file.originalname, req.file.mimetype, country, category, tenant.dataResidency);
  if (!result.ok) {
    return res.status(result.status === 503 ? 503 : 502).json({ error: result.error });
  }
  res.json(result.data);
});

app.get("/api/admin/kb/:tenantId/files", adminAuth, async (req, res) => {
  const result = await kbClient.listFiles(req.params.tenantId);
  if (!result.ok) return res.status(result.status === 503 ? 503 : 502).json({ error: result.error });
  res.json(result.data);
});

app.delete("/api/admin/kb/:tenantId/files/:filename", adminAuth, async (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  const country = typeof req.query.country === "string" && req.query.country.trim() ? req.query.country.trim() : undefined;
  const category = typeof req.query.category === "string" && req.query.category.trim() ? req.query.category.trim() : undefined;
  const result = await kbClient.deleteFile(req.params.tenantId, req.params.filename, country, category, tenant?.dataResidency);
  if (!result.ok) return res.status(result.status === 503 ? 503 : result.status === 404 ? 404 : 502).json({ error: result.error });
  res.json(result.data);
});

app.post("/api/admin/kb/:tenantId/files/:filename/reindex", adminAuth, async (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  const country = typeof req.query.country === "string" && req.query.country.trim() ? req.query.country.trim() : undefined;
  const category = typeof req.query.category === "string" && req.query.category.trim() ? req.query.category.trim() : undefined;
  const result = await kbClient.reindexFile(req.params.tenantId, req.params.filename, country, category, tenant?.dataResidency);
  if (!result.ok) return res.status(result.status === 503 ? 503 : result.status === 404 ? 404 : 502).json({ error: result.error });
  res.json(result.data);
});

app.get("/api/admin/kb/jobs/:jobId", adminAuth, async (req, res) => {
  const result = await kbClient.getJob(req.params.jobId);
  if (!result.ok) return res.status(result.status === 503 ? 503 : result.status === 404 ? 404 : 502).json({ error: result.error });
  res.json(result.data);
});

app.get("/api/admin/kb/:tenantId/jobs", adminAuth, async (req, res) => {
  const result = await kbClient.listJobs(req.params.tenantId, Number(req.query.limit) || 50);
  if (!result.ok) return res.status(result.status === 503 ? 503 : 502).json({ error: result.error });
  res.json(result.data);
});

app.get("/api/admin/tenant-files", adminAuth, (req, res) => {
  // Sourced from the already-loaded in-memory map, not disk/DB directly —
  // works the same whether tenants are file- or DB-backed, and reflects
  // whatever's actually live right now rather than a possibly-stale reload.
  res.json({ tenantIds: [...tenants.keys()] });
});

app.get("/api/admin/tenant/:id", adminAuth, async (req, res) => {
  if (tenantStore.isConfigured()) {
    const found = await tenantStore.getRawTenant(req.params.id);
    if (!found) return res.status(404).json({ error: "Tenant not found" });
    return res.json({ id: req.params.id, content: JSON.stringify(found.raw, null, 2) });
  }
  const filePath = tenantFilePath(req.params.id);
  if (!filePath) return res.status(400).json({ error: "Invalid tenant id" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Tenant file not found" });
  res.json({ id: req.params.id, content: fs.readFileSync(filePath, "utf-8") });
});

app.put("/api/admin/tenant/:id", adminAuth, async (req, res) => {
  const tenantId = req.params.id;
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
    return res.status(400).json({ error: "Invalid tenant id — use letters, numbers, - and _ only" });
  }

  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "Body must include { content: '<json string>' }" });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return res.status(400).json({ error: `Invalid JSON — not saved: ${err.message}` });
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return res.status(400).json({ error: "Tenant config must be a JSON object — not saved" });
  }

  let isNew;
  try {
    if (tenantStore.isConfigured()) {
      isNew = !(await tenantStore.tenantExists(tenantId));
      // Single-admin-user auth (see adminAuth) — no per-user session identity
      // to record beyond the one configured admin username.
      await tenantStore.saveTenant(tenantId, parsed, process.env.ADMIN_USERNAME || "admin-panel");
    } else {
      const filePath = tenantFilePath(tenantId);
      isNew = !fs.existsSync(filePath);
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    }
  } catch (err) {
    return res.status(500).json({ error: `Save failed: ${err.message}` });
  }

  try {
    const result = await reloadTenants();
    console.log(`💾 Tenant "${tenantId}" ${isNew ? "created" : "updated"} via admin panel and reloaded.`);
    res.json({ ok: true, created: isNew, ...result });
  } catch (err) {
    // Saved but reload failed (e.g. this write broke the ONLY "default"
    // tenant, or some other fatal condition) — say so clearly. Previous
    // in-memory tenants map is still what's actually serving traffic.
    res.status(400).json({ ok: false, created: isNew, error: `Saved, but reload failed: ${err.message}` });
  }
});

app.post("/api/admin/tenant/:id/regenerate-widget-key", adminAuth, async (req, res) => {
  if (!tenantStore.isConfigured()) {
    return res.status(400).json({ error: "Widget key rotation requires DATABASE_URL — in file mode, edit tenant_meta.widgetKey in the tenant's JSON file directly." });
  }
  if (!(await tenantStore.tenantExists(req.params.id))) {
    return res.status(404).json({ error: `Unknown tenant "${req.params.id}"` });
  }
  const newKey = await tenantStore.regenerateWidgetKey(req.params.id);
  try {
    await reloadTenants(); // so the new key takes effect immediately, not after the next unrelated reload
  } catch (err) {
    return res.status(500).json({ error: `Key rotated, but reload failed: ${err.message}` });
  }
  res.json({ ok: true, widgetKey: newKey });
});

// ---------------------------------------------------------------------------
// 4. Input sanitization
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Origin allowlist — the actual security boundary for tenant isolation.
// CORS response headers alone don't stop a non-browser caller (curl, a
// script) from hitting this endpoint directly; only a server-side check
// does. Real widget traffic always carries an Origin header (browsers set
// it on cross-origin fetches); we only block when one is present and not on
// the tenant's list, so non-browser tooling / same-origin demo pages during
// local dev still work.
// ---------------------------------------------------------------------------
function isOriginAllowed(tenant, origin) {
  if (!tenant.allowedOrigins || tenant.allowedOrigins.length === 0) return true;
  if (!origin) return true;
  return tenant.allowedOrigins.includes(origin);
}

// Widget key: see db/schema.sql's widget_key column comment for what this
// is and isn't — a per-tenant token the embedded widget sends on every
// public request, NOT a true secret (it's visible in the tenant's page
// source). Its real value is per-tenant rate-limit/abuse granularity and
// revocation — you can rotate ONE tenant's key after it's been scraped
// without touching any other tenant, unlike allowedOrigins which a
// scripted (non-browser) request can bypass entirely by simply omitting
// the Origin header.
//
// Timing-safe comparison because this is still a credential check, even
// though the "secret" is public-visible — cheap to do correctly, no
// reason not to. crypto.timingSafeEqual throws on mismatched buffer
// lengths rather than returning false, so that's checked first.
function isWidgetKeyValid(tenant, providedKey) {
  if (!tenant.widgetKey) return true; // not configured = open, same convention as allowedOrigins
  if (typeof providedKey !== "string" || !providedKey) return false;
  const a = Buffer.from(tenant.widgetKey);
  const b = Buffer.from(providedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Per-visitor rate limiting — independent of the provider-key concurrency
// cap above. That cap protects the shared upstream API key; this protects
// the service itself from one visitor (or one bad actor) hammering it.
// Backed by lib/kv.js: shared across instances via Redis when REDIS_URL is
// set, in-memory per-instance otherwise.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function isRateLimited(ip, tenantId) {
  const key = `ratelimit:${ip}|${tenantId}`;
  const count = await kvAppendAndCountRecent(key, RATE_LIMIT_WINDOW_SECONDS);
  return count > RATE_LIMIT_MAX;
}

// sanitizeMessages now lives in lib/sanitizeMessages.js.

// streamFromProviderChain (with its per-provider-key concurrency semaphore)
// now lives in lib/providerChain.js.

// ---------------------------------------------------------------------------
// 6. Chat endpoint
// ---------------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const { messages, sessionId, tenantId: rawTenantId } = req.body;
  const sid = typeof sessionId === "string" && sessionId ? sessionId : "unknown";
  const tenantId = typeof rawTenantId === "string" && rawTenantId ? rawTenantId : DEFAULT_TENANT;

  const tenant = getTenant(tenantId);
  if (!tenant) {
    logError({ context: "validation", sessionId: sid, tenantId, message: `Unknown tenantId "${tenantId}"` });
    return res.status(400).json({ error: FRIENDLY_ERROR_MESSAGES.validation });
  }

  if (!isOriginAllowed(tenant, req.headers.origin)) {
    logSecurity({ context: "origin_blocked", sessionId: sid, tenantId, message: `Blocked origin: ${req.headers.origin}` });
    return res.status(403).json({ error: FRIENDLY_ERROR_MESSAGES.validation });
  }

  if (!isWidgetKeyValid(tenant, req.headers["x-widget-key"])) {
    logSecurity({ context: "widget_key_invalid", sessionId: sid, tenantId, message: "Missing or incorrect X-Widget-Key" });
    return res.status(403).json({ error: FRIENDLY_ERROR_MESSAGES.validation });
  }

  if (await isRateLimited(req.ip, tenantId)) {
    logSecurity({ context: "rate_limited", sessionId: sid, tenantId, message: `IP ${req.ip} exceeded ${RATE_LIMIT_MAX}/min` });
    return res.status(429).json({ error: "Too many requests — please slow down and try again in a moment." });
  }

  const cleanMessages = sanitizeMessages(messages);
  if (cleanMessages.length === 0) {
    logError({ context: "validation", sessionId: sid, tenantId, message: "Empty or invalid messages array" });
    return res.status(400).json({ error: FRIENDLY_ERROR_MESSAGES.validation });
  }
  if (!tenant.providerChain.some((p) => p.apiKey)) {
    logError({ context: "config", sessionId: sid, tenantId, message: "No provider in this tenant's chain has an API key configured" });
    return res.status(500).json({ error: FRIENDLY_ERROR_MESSAGES.config });
  }

  const lastUserMessage = [...cleanMessages].reverse().find((m) => m.role === "user")?.content || "";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  // ---------------------------------------------------------------------
  // Guardrail pass — runs before any provider call. Writes a complete
  // response (text + trailing followups JSON block, same wire format the
  // LLM path produces) and returns early. This keeps the on-the-wire
  // contract identical for the widget regardless of which path answered.
  // ---------------------------------------------------------------------
  function sendGuardrailResponse(text, followups, logExtra) {
    res.write(text);
    res.write(`\n\n\`\`\`json\n${JSON.stringify({ followups: followups || [] })}\n\`\`\``);
    logConversation({
      sessionId: sid,
      tenantId,
      userMessage: lastUserMessage,
      assistantResponse: text,
      guardrail: true,
      durationMs: 0,
      ...logExtra,
    });
    res.end();
  }

  // tenant.suggestedQuestions is for the START of a conversation only —
  // only the greeting branch below should use it.
  const startFollowups = tenant.suggestedQuestions.slice(0, 3);
  const automations = tenant.automations;

  // --- Automation Router -----------------------------------------------
  // Every message passes through here first. A session mid-flow on some
  // automation is continued regardless of what the new message looks like
  // (a reply like "Ali Raza" or "yes" isn't classifiable on its own —
  // context, i.e. which automation is active, is everything). Otherwise,
  // the message is matched against every ENABLED automation's triggers,
  // in tenant-configured order. No match -> falls through to the normal
  // Knowledge Chat / LLM flow below.
  const activeAutomationId = await automationState.getActivePointer(sid);
  if (activeAutomationId) {
    const automation = getAutomationById(automations, activeAutomationId);
    if (automation && automation.enabled) {
      if (await automationState.isConfirming(automation.id, sid)) {
        const state = await automationState.getState(automation.id, sid);

        if (isAffirmative(lastUserMessage)) {
          await automationState.clear(automation.id, sid);
          await automationState.clearActivePointer(sid);
          const result = await executeAutomation(automation, { tenant, tenantId, sessionId: sid, collected: state.collected, logLead, logExecution });
          return sendGuardrailResponse(result.message || "Done.", [], { intent: `${automation.id}_captured` });
        }

        // Not affirmative — treat as a correction. Genuinely needs an LLM
        // call (parsing "actually my email is X" needs understanding, not
        // regex) — the one place in this flow that isn't instant.
        const fresh = await structureFieldAnswers(tenant, automation.fields, lastUserMessage, cleanMessages);
        const merged = mergeStructured(state.collected, fresh);
        const { notes, _structured, ...correctedFields } = merged;
        await automationState.startConfirming(automation.id, sid, tenantId, correctedFields);
        return sendGuardrailResponse(confirmationSummary(automation.fields, correctedFields), [], { intent: `${automation.id}_correction` });
      }

      if (await automationState.isCollecting(automation.id, sid)) {
        const state = await automationState.getState(automation.id, sid);
        const field = automation.fields.find((f) => f.key === state.currentKey);

        // Heuristic-first, LLM-fallback: is this reply actually answering
        // `field`, or a cancel request, or an unrelated question/comment?
        // Without this, ANY reply here got silently recorded as the raw
        // field value — "cancel", "wait what's your refund policy?", etc.
        // See lib/digressionHandler.js for the tiered cost reasoning.
        if (detectCancelIntent(lastUserMessage)) {
          await automationState.clear(automation.id, sid);
          await automationState.clearActivePointer(sid);
          return sendGuardrailResponse(
            "No problem — I've cancelled that. Let me know if you'd like to start again anytime.",
            [],
            { intent: `${automation.id}_cancelled` }
          );
        }

        if (!looksLikePlausibleAnswer(lastUserMessage, field)) {
          const classification = await classifyFieldReply(tenant, field, lastUserMessage);

          if (classification === "CANCEL") {
            await automationState.clear(automation.id, sid);
            await automationState.clearActivePointer(sid);
            return sendGuardrailResponse(
              "No problem — I've cancelled that. Let me know if you'd like to start again anytime.",
              [],
              { intent: `${automation.id}_cancelled` }
            );
          }

          if (classification === "DIGRESSION") {
            // Deliberately does NOT record a value and does NOT clear
            // automationState — the flow stays paused exactly where it
            // was, so their NEXT reply still targets this same field.
            const digression = await answerDigression(tenant, lastUserMessage, cleanMessages);
            const reminder = `\n\n(Back to your ${automation.name || automation.id} — ${fieldQuestionText(field, false)})`;
            return sendGuardrailResponse(
              (digression?.text || "I don't have a good answer for that right now.") + reminder,
              digression?.followups || [],
              { intent: `${automation.id}_digression` }
            );
          }
          // classification === "ANSWER" — heuristic was wrong, fall through
          // to recording it exactly like the confident-heuristic path below.
        }

        const value = cleanFieldAnswer(lastUserMessage, field);
        const result = await automationState.recordAnswerAndAdvance(automation.id, sid, value);

        if (result.done) {
          return sendGuardrailResponse(confirmationSummary(automation.fields, result.collected), [], { intent: `${automation.id}_confirming` });
        }
        const nextField = automation.fields.find((f) => f.key === result.nextKey);
        const slots = looksLikeTimeField(nextField) ? generateAvailableSlots(tenant) : [];
        const suffix = slots.length ? " Here are some times that could work, or suggest your own:" : "";
        return sendGuardrailResponse(fieldQuestionText(nextField, false) + suffix, slots.map((s) => s.label), { intent: `${automation.id}_collecting` });
      }
    }
    // Stale or disabled-mid-flow pointer — drop it and fall through to
    // normal handling of whatever they actually sent.
    await automationState.clearActivePointer(sid);
  }

  const intent = classifyIntent(lastUserMessage);

  if (intent === "injection") {
    logSecurity({ context: "prompt_injection", sessionId: sid, tenantId, message: lastUserMessage.slice(0, 300) });
    const topicWord = tenant.vertical === "consultancy" ? "our programs and process" : "this survey's data";
    return sendGuardrailResponse(
      `I can only help with questions about ${topicWord} — I'm not able to change how I behave based on instructions in a message. What would you like to know?`,
      [],
      { intent: "injection" }
    );
  }

  const matchedAutomation = matchAutomation(automations, lastUserMessage);
  if (matchedAutomation) {
    // Check conversation history first — anything already mentioned
    // earlier gets pre-filled so we don't ask for it again.
    const knownFields = await extractKnownFields(tenant, matchedAutomation.fields, cleanMessages);
    const missingFields = matchedAutomation.fields.filter((f) => !knownFields[f.key]);

    if (missingFields.length === 0) {
      if (matchedAutomation.fields.length === 0) {
        // No input needed at all — just run it (e.g. a zero-field human
        // handover automation).
        const result = await executeAutomation(matchedAutomation, { tenant, tenantId, sessionId: sid, collected: {}, logLead, logExecution });
        return sendGuardrailResponse(result.message || "Done.", [], { intent: `${matchedAutomation.id}_executed` });
      }
      await automationState.startConfirming(matchedAutomation.id, sid, tenantId, knownFields);
      await automationState.setActivePointer(sid, matchedAutomation.id);
      return sendGuardrailResponse(confirmationSummary(matchedAutomation.fields, knownFields), [], { intent: `${matchedAutomation.id}_confirming` });
    }

    const firstField = missingFields[0];
    const startIndex = matchedAutomation.fields.findIndex((f) => f.key === firstField.key);
    const remainingKeys = matchedAutomation.fields
      .slice(startIndex)
      .map((f) => f.key)
      .filter((k) => missingFields.some((f) => f.key === k));
    await automationState.startCollecting(matchedAutomation.id, sid, tenantId, knownFields, remainingKeys);
    await automationState.setActivePointer(sid, matchedAutomation.id);

    const slots = looksLikeTimeField(firstField) ? generateAvailableSlots(tenant) : [];
    const suffix = slots.length ? " Here are some times that could work, or suggest your own:" : "";
    return sendGuardrailResponse(fieldQuestionText(firstField, true) + suffix, slots.map((s) => s.label), { intent: `${matchedAutomation.id}_requested` });
  }

  if (intent === "greeting") {
    const topic = tenant.vertical === "consultancy" ? (tenant.meta?.title || "our programs and process") : (tenant.meta?.title || "this survey's data");
    return sendGuardrailResponse(
      `Hi! Ask me anything about ${topic} — here are a few places to start.`,
      startFollowups,
      { intent: "greeting" }
    );
  }
  // No automation matched, not a greeting or injection — falls through to
  // the normal Knowledge Chat / LLM flow below (today: answers from the
  // tenant's configured data; KB Service retrieval integration is the
  // still-pending next step for true RAG).

  // Let the client cancel via the stop button — propagates to whichever
  // provider request is currently in flight. IMPORTANT: we track our own
  // "did we finish normally" flag rather than trusting res.writableEnded at
  // the moment 'close' fires, because req.on('close') can fire as soon as the
  // request BODY finishes being read — unrelated to the client disconnecting —
  // and res 'close' can race with our own res.end() call.
  let responseFinished = false;
  const clientAbortController = new AbortController();
  res.on("close", () => {
    if (!responseFinished) clientAbortController.abort();
  });

  const startedAt = Date.now();

  // Cap history sent to the model — this was previously unbounded (the
  // entire conversation, forever), which is fine on a free model but a
  // real, growing cost on a paid one. Last 12 messages (~6 turns) keeps
  // enough context for follow-up questions without re-billing the whole
  // conversation on every single turn.
  const HISTORY_MESSAGES_TO_LLM = 12;
  const trimmedHistory = cleanMessages.slice(-HISTORY_MESSAGES_TO_LLM);

  // --- Knowledge Base retrieval ------------------------------------------
  // Live, per-turn call to the KB Service (not a precomputed/cached
  // step) — retrieval has to reflect the actual question just asked, and
  // number-form normalization ("20%" vs "twenty percent") happens on the
  // KB Service side of this call, inline in its /search handler. A KB
  // Service outage or empty result set must never break the chat — it
  // just falls back to answering from the system prompt alone.
  const kbMessages = [];
  let kbSearchMs = 0;
  if (kbClient.isConfigured()) {
    // fast: true — a slow/unreachable KB Service gets one ~6s attempt, no
    // retries, then chat proceeds without KB context rather than stalling
    // the user's response for the full default retry budget.
    const kbStartedAt = Date.now();
    const kbResult = await kbClient.search(tenantId, lastUserMessage, tenant.useKbOnly ? 8 : 5, { fast: true, vectorDb: tenant.dataResidency });
    kbSearchMs = Date.now() - kbStartedAt;
    if (kbResult.ok && Array.isArray(kbResult.data?.results) && kbResult.data.results.length > 0) {
      const context = kbResult.data.results
        .map((r, i) => {
          const tag = r.country ? ` — ${r.country}` : "";
          return `[${i + 1}] (source: ${r.sourceFile || "unknown"}${tag})\n${r.text}`;
        })
        .join("\n\n");
      kbMessages.push({
        role: "system",
        content:
          `Here is knowledge base context retrieved for the user's latest message. Each item's source may be tagged ` +
          `with a country — if so, that content applies specifically to that destination country, not others. ` +
          `Use it if relevant to answer accurately; if it doesn't contain the answer, ` +
          `say so rather than guessing — do not mention "knowledge base" or "retrieved context" to the user.\n\n${context}`,
      });
    } else if (!kbResult.ok) {
      logError({ context: "kb_search_failed", sessionId: sid, tenantId, message: kbResult.error });
      if (tenant.useKbOnly) {
        // This tenant has no full-context fallback baked into its system
        // prompt — a failed KB search here means the model is answering
        // with effectively zero tenant content, not a degraded version.
        logSecurity({ context: "kb_only_tenant_search_failed", sessionId: sid, tenantId, message: `useKbOnly tenant's KB search failed: ${kbResult.error}` });
      }
    }
  }

  if (tenant.vertical === "consultancy" && detectEngagementSignal(cleanMessages)) {
    kbMessages.push({
      role: "system",
      content: "[ENGAGEMENT SIGNAL] This visitor has asked several questions or repeated a buying-signal topic (eligibility/fees/timeline) — per rule 8, make one of your follow-up suggestions specifically about booking a consultation.",
    });
  }

  const llmStartedAt = Date.now();
  try {
    const result = await streamFromProviderChain(
      tenant.providerChain,
      () => [{ role: "system", content: tenant.systemPrompt }, ...kbMessages, ...trimmedHistory],
      res,
      clientAbortController.signal
    );
    const llmDurationMs = Date.now() - llmStartedAt;

    if (result.finishReason === "length") {
      res.write("\n\n_⚠️ Response was cut short at the length limit — ask \"continue\" or ask for a shorter summary._");
    }
    if (result.truncatedMidStream) {
      res.write("\n\n_⚠️ Response was interrupted partway through — ask me to continue._");
    }

    const promptTokens = result.usage?.prompt_tokens ?? null;
    const completionTokens = result.usage?.completion_tokens ?? null;
    const estimatedCostUsd =
      promptTokens !== null && completionTokens !== null
        ? estimateCostUsd(result.model, promptTokens, completionTokens)
        : null;

    logConversation({
      sessionId: sid,
      tenantId,
      providerIndex: result.usedProviderIndex,
      model: result.model,
      userMessage: lastUserMessage,
      assistantResponse: result.fullResponseText,
      responseLength: result.fullResponseText.length,
      finishReason: result.finishReason,
      truncatedMidStream: result.truncatedMidStream || false,
      durationMs: Date.now() - startedAt,
      kbSearchMs,
      llmDurationMs,
      attemptsCount: result.attempts.length,
      attempts: result.attempts, // [{providerIndex, model, outcome, durationMs, ...}] — every provider tried, not just the winner
      promptTokens,
      completionTokens,
      estimatedCostUsd,
    });

    responseFinished = true;
    res.end();
  } catch (err) {
    if (err.name === "AbortError" && clientAbortController.signal.aborted) {
      // Client hit stop — not an error, just end quietly.
      logConversation({
        sessionId: sid,
        tenantId,
        userMessage: lastUserMessage,
        assistantResponse: "(stopped by user)",
        stopped: true,
        durationMs: Date.now() - startedAt,
        kbSearchMs,
        llmDurationMs: Date.now() - llmStartedAt,
      });
      responseFinished = true;
      return res.end();
    }

    logError({
      context: "all_providers_failed",
      sessionId: sid,
      tenantId,
      message: err.message,
      durationMs: Date.now() - startedAt,
      kbSearchMs,
      llmDurationMs: Date.now() - llmStartedAt,
      attemptsCount: Array.isArray(err.attempts) ? err.attempts.length : 0,
      attempts: err.attempts || [],
    });
    if (!res.headersSent) res.status(502);
    // Only the generic friendly message reaches the client — never err.message.
    res.write(FRIENDLY_ERROR_MESSAGES.all_providers_failed);
    responseFinished = true;
    res.end();
  }
});

function startServer() {
  app.listen(PORT, () => {
    console.log(`🚀 Insight Bot backend running at http://localhost:${PORT}`);
    console.log(`   Tenants loaded: ${[...tenants.keys()].join(", ")}`);
    console.log(`   Widget embed script: http://localhost:${PORT}/widget.js`);
    if (process.env.REDIS_URL) {
      console.log(`   ℹ️  REDIS_URL set — rate limiting and admin sessions are shared across instances. Provider-concurrency limits (MAX_CONCURRENT_PER_PROVIDER_KEY) are NOT — each instance enforces its own cap independently. See the KeyedSemaphore comment in lib/providerChain.js if running more than one instance.`);
    }
  });
}
