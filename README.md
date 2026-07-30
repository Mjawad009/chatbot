# Insight Bot — Multi-Tenant AI Survey Chatbot

A cost-effective, open-source, **multi-tenant** AI chatbot that answers questions
**strictly** from a per-tenant survey dataset, rendering Markdown tables/bullets and
interactive Chart.js visualizations inline in a floating chat widget.

**Single deployment model:** you deploy the `backend/` folder once. Every tenant site
embeds one `<script>` tag pointing at it — no separate frontend to host, build, or deploy.

```
survey-chatbot/
├── backend/
│   ├── server.js                    # Express API + static file server (route handlers, tenant loading, auth)
│   ├── lib/
│   │   ├── systemPrompts.js         # per-tenant system prompt builders + engagement-signal detector
│   │   ├── providerChain.js         # provider failover streaming + per-key concurrency semaphore
│   │   ├── sanitizeMessages.js      # input sanitization (caps, control-char stripping)
│   │   ├── modelPricing.js          # cost-per-conversation estimates (overridable via data/model-pricing.json)
│   │   ├── kbClient.js              # HTTP client for the KB Service below
│   │   └── ...                      # automations, intent classification, notifiers, tenant store, kv (Redis/in-memory), etc.
│   ├── test/                        # node:test unit tests — run with `npm test`
│   ├── package.json
│   ├── .env.example
│   ├── data/
│   │   ├── tenants/
│   │   │   ├── default.json         # one JSON file per tenant = one survey dataset + config
│   │   │   ├── acme-retail.json     # second example tenant, proves isolation works
│   │   │   └── edu-consultancy-demo.json
│   │   └── model-pricing.json       # auto-created; overrides lib/modelPricing.js without a redeploy
│   ├── admin/                       # admin panel (tenant config, knowledge base, analytics, automations)
│   ├── public/
│   │   ├── widget.js                # THE frontend — self-mounting, single-file
│   │   ├── demo-default.html
│   │   └── demo-acme-retail.html
│   └── logs/                        # gitignored, created at runtime
└── kb-service/                      # optional FastAPI + Qdrant retrieval service — see section 6
    ├── app.py                       # HTTP surface: /ingest, /ingest-batch, /search, /tenants/*/files, /health
    ├── ingestion.py                 # chunking, embedding, Qdrant upsert/search, tenant+country+category isolation
    ├── jobs.py                      # ingestion job tracking, persisted per-tenant so history survives restarts
    └── config.py
```

## 1. What's in this build

This build addresses two rounds of requirements. Most recent round first:

**Round 3 — security, KB-service scale, retrieval design, conversion, ops, code health,
tests**

- **XSS fix in the widget's Markdown rendering.** AI-generated responses were rendered
  via `marked.parse()` straight into `innerHTML` with no sanitization — a successful
  prompt injection that got the model to emit raw HTML or a `javascript:` link could
  have executed in a real site visitor's browser. Now sanitized through DOMPurify before
  insertion, with an explicit `http(s)`-only allowlist on rendered links as a second
  layer, and a fail-safe to plain text if DOMPurify doesn't load. **This was the highest-
  priority fix in this round.**
- **Origin-allowlist visibility.** A tenant with no `allowedOrigins` set was previously
  only flagged with a boot-time console warning. The admin overview now surfaces an
  explicit `unprotectedOrigin` flag per tenant, shown as a red "⚠ unprotected" badge plus
  a persistent banner at the top of the tenant list — this doesn't change the (deliberate)
  default of leaving it open for local dev/demos, it just makes an unprotected production
  tenant impossible to miss in the admin panel.
- **KB Service — the README previously said this "populates Qdrant but isn't wired into
  `/api/chat` yet." That was stale; it *is* wired in** (`kbClient.search()` is called on
  every chat turn when `KB_SERVICE_URL` is configured, 6s timeout, silent fallback to
  answering from the system prompt alone on failure). What changed this round:
  - **`tenant_meta.useKbOnly: true`** — for a tenant with a KB too large to inject in
    full (e.g. a dataset covering 100+ countries), this skips the full-dataset dump in
    the system prompt and relies solely on per-turn retrieval, with a wider `topK` and
    louder logging if retrieval fails for such a tenant (previously, full injection and
    retrieval always ran together, unreconciled, even when one made the other redundant).
  - **`category` now filters alongside `country`** end-to-end (Qdrant payload index,
    ingestion, `/ingest`, `/ingest-batch`, `/search`, delete/reindex, the admin
    knowledge-base UI) — for a tenant uploading e.g. a study-visa/work-visa/immigration-
    visa file per country, this lets retrieval scope to content type independently of
    destination country. Tagged at ingestion time now even where `/api/chat` doesn't
    pass a category filter yet, so this doesn't require re-ingesting existing files later.
  - **`POST /ingest-batch`** — accepts multiple files (+ an optional filename→country
    JSON map) in one call; each file gets its own job id, so one bad file doesn't block
    the rest of a large bulk upload.
  - **Ingestion job history now persists to disk per-tenant** (`kb-service/storage/jobs/`)
    instead of an in-memory list capped at 200 — a 300+ file bulk-ingest run no longer
    silently loses its audit trail partway through.
  - **Silent TOC-detection fallback is now surfaced.** When a file's Table of Contents
    doesn't cleanly match its body headings, ingestion previously fell back to treating
    the whole file as one chunk with no visible signal. This is now returned as
    `tocDetected: false`, logged, and shown as a "⚠ no TOC split" badge in the admin
    ingestion history — important for a batch of files expected to share a similar
    structure (e.g. one visa-type template repeated per country), where this usually
    means one file's formatting drifted enough to break section-splitting.
  - The per-tenant document registry is now cached in memory (mirroring the existing
    docstore cache) instead of being re-read and re-parsed from disk on every single
    ingest call — removes the redundant I/O for large bulk-ingest runs. The full-file
    *write* on every save is still inherent to the flat-JSON-registry design; a
    SQLite/Postgres-backed registry is the real fix if a tenant's file count grows large,
    and remains a follow-up, not something this round changed.
- **Conversion-aware follow-ups for consultancy tenants.** Previously, follow-up
  suggestions were purely data-answerable, with no mechanism to nudge toward booking
  beyond a tenant explicitly saying "book a call." Now, once a conversation shows
  buying signals (3+ user messages, or a repeated eligibility/fee/timeline question), an
  `[ENGAGEMENT SIGNAL]` marker is injected and the consultancy system prompt is
  instructed to make one follow-up suggestion specifically about booking. The demo
  consultancy tenant's starter chips now also include a booking question directly.
- **Logo support in the widget theme.** `tenant_meta.branding.theme` previously covered
  7 colors only — no way to show a tenant's actual brand mark. Added `theme.imageUrl`
  (https-only, fails quiet on a bad/dead URL rather than showing a broken-image icon),
  rendered in the widget header, with a matching field in the admin theme editor.
- **Documented (not yet fixed) — the provider-concurrency semaphore doesn't distribute
  across instances even when Redis is configured.** Unlike rate limiting and admin
  sessions (both genuinely Redis-backed via `lib/kv.js` when `REDIS_URL` is set), the
  `KeyedSemaphore` capping per-provider-key concurrency is always in-process — a real
  distributed semaphore needs atomic acquire/release primitives `kv.js`'s simple
  get/set/list interface doesn't provide. Now documented explicitly in code and flagged
  in a boot-time console warning when `REDIS_URL` is set, so this isn't silently assumed
  to be covered when scaling to multiple instances.
- **Model pricing is now overridable without a redeploy.** `lib/modelPricing.js`'s
  cost-per-1M-token table previously could only be updated by editing code. It now
  merges `data/model-pricing.json` (auto-created, same pattern as tenant configs) on top
  of the built-in defaults, tracks a `lastVerified` date, and that date is surfaced next
  to the cost-per-conversation figure in the admin analytics dashboard — so a stale
  estimate is visible as stale, not silently wrong.
- **Partial `server.js` decomposition.** The system-prompt builders, the provider
  failover/streaming logic + concurrency semaphore, and input sanitization have been
  extracted into `lib/systemPrompts.js`, `lib/providerChain.js`, and
  `lib/sanitizeMessages.js` respectively — each is now a pure, side-effect-free module
  with no dependency on the tenants Map or request/response state, and each is covered
  by real unit tests (see below). `server.js` shrank from ~1,530 to ~1,190 lines.
  **This is not the full split** — route handlers (chat, admin, tenant CRUD, KB proxy),
  tenant loading, auth, and rate limiting still live in `server.js`; a `routes/chat.js` /
  `routes/admin.js` / `routes/public.js` split remains a follow-up.
- **A real, runnable test suite exists now.** `npm test` (Node's built-in test runner,
  no new dependency) covers `sanitizeMessages` (caps, control-char stripping, role
  filtering), `buildSystemPrompt` (vertical dispatch, masterPrompt override with the
  technical contract preserved, **tenant isolation** — two tenants' payloads never leak
  into each other's prompt — and `useKbOnly` behavior), `detectEngagementSignal`,
  `resolveProviderEntry`, `KeyedSemaphore` (concurrency cap + queueing + independent
  keys, with real timing assertions), `streamFromProviderChain` failover (via a mocked
  `fetch` — confirms a first-provider failure correctly falls over to the second, a
  keyless provider is skipped without a network call, and an all-providers-failed chain
  throws), and `classifyIntent`/`isAffirmative`/`extractEmail`. 44 tests, all passing as
  of this round. This doesn't cover the route handlers still in `server.js` (see the
  decomposition note above) — extending coverage there is a natural next step once
  they're split out into testable modules.

**Round 2 — response depth, follow-up relevance, UI polish, concurrency**
- **Fuller, more informative answers** — the system prompt's conciseness rule was
  rebalanced: it previously pushed the model toward one-line replies, now it explicitly
  asks for a complete answer (relevant numbers + brief context + related figures) while
  still capping bullets and avoiding padding/repetition — aiming for "short paragraph or
  table plus a sentence of framing," not a single bare sentence or a multi-page essay.
- **Follow-ups actually relevant to what was just asked** — three layers now: (1) the
  model's own dynamically-generated follow-ups (unchanged, still preferred when present);
  (2) if missing, word-overlap scoring against the tenant's `suggested_questions`
  (tokenizer broadened to catch more real matches); (3) if *that* finds nothing, the
  fallback now extracts real entities (e.g. "Downtown Flagship", "Healthcare") from the
  answer text itself and synthesizes "Tell me more about X" questions from them, instead
  of falling back to a fully arbitrary random pick. Verified with unit tests including
  a case with zero topical overlap in the suggested-questions pool.
- **Modernized, responsive UI** — new CSS-variable-driven design (soft gradients, refined
  shadows, rounded corners, subtle hover/press micro-interactions) replacing the earlier
  flatter look. **Fixed a real bug**: the maximize button previously kept a fixed
  `bottom: 92px` offset while growing the panel's height, which could push its top edge
  above the visible viewport on shorter screens. Maximize now anchors both `top` and
  `bottom` (`height: auto`), so it always fits the viewport regardless of size. Added
  matching breakpoints for narrow and short viewports.
- **Animations** — panel open/close now fades and scales in rather than snapping via
  `display: none`/`flex`; new messages, chips, and charts fade/slide in on arrival; the
  launcher does a gentle pulse-ring until first opened (then stops); buttons get subtle
  hover/press feedback.
- **Concurrency protection** — added a keyed semaphore capping how many requests can be
  in flight at once against any single provider API key (default 3, configurable via
  `MAX_CONCURRENT_PER_PROVIDER_KEY`). Without this, many simultaneous users (single-tenant
  or across tenants sharing a key) could all burst through OpenRouter's free-tier rate
  limit together, which looks like "the API stopped responding" even though no individual
  request did anything wrong — extra requests now queue briefly (a request that can't get
  a slot within `MAX_PROVIDER_QUEUE_WAIT_MS`, default 8s, is treated as busy and the chain
  moves to the next provider instead of hanging indefinitely). **Verified with a real
  concurrency test**: 10 truly simultaneous requests against a mock provider that tracks
  its own peak concurrent connections — confirmed capped at exactly 3, all 10 still
  succeeded (staggered), none dropped.

**Round 1 — see the rest of this section below for stop button, tenant isolation,
per-tenant providers/failover, sanitization, error handling, minimize/maximize, chat
history, copy buttons, and smart auto-scroll.**

**Reliability / infra (`server.js`)**
- **Stop generating** — client sends an abort signal; the server detects a genuine
  client disconnect (not just "request body finished reading" — that's a real gotcha
  with Node's `req.on('close')` that this code avoids) and cancels the upstream call
  immediately, logging it as `stopped: true`, not as an error.
- **Never a dead end** — system prompt instructs the model to offer the closest
  relevant data instead of refusing when the exact figure isn't available.
- **Never expose technical errors** — every user-facing error is one of a small set of
  generic, friendly strings (`FRIENDLY_ERROR_MESSAGES`). Full technical detail (stack,
  upstream response body, provider used) is only ever written to `logs/errors.log`.
  Verified: a real "all providers failed" scenario returns the friendly string to the
  client while the log captures the actual `fetch failed` detail.
- **Prompt sanitization** — input is capped (4000 chars/message, 40 messages/request),
  control characters stripped, and the system prompt explicitly instructs the model to
  treat all user content as a question to answer, never as instructions to follow.
- **Tenant isolation** — every request re-resolves its tenant's own system prompt,
  provider chain, and log entries fresh; nothing is cached or shared mutable state
  across tenants. Verified with a mock upstream that echoes back which tenant's data
  it received.
- **Per-tenant provider/API key** — each tenant's JSON can set its own `provider`
  (`apiUrl`, `apiKeyEnv`, `models`) so different tenants can bill to different
  OpenRouter (or any OpenAI-compatible) accounts. See section 3.
- **Automatic failover** — two layers: (1) OpenRouter's own native `models` array is
  sent on every request, so OpenRouter itself fails over between models in one HTTP
  call on rate-limit/downtime; (2) if a whole provider fails outright before any bytes
  are streamed back, the server moves to the next configured provider entry. Verified
  with a mock "always-429" provider + a mock "always-succeeds" fallback provider — the
  log confirms `providerIndex: 1` was used.

**Frontend (`public/widget.js`)**
- **Stop button** — the send button turns into a ■ stop button while a response is
  streaming; clicking it aborts the fetch immediately and keeps whatever text had
  already arrived.
- **Minimize / Maximize** — header buttons collapse the panel to just its title bar, or
  expand it to a larger size, independent of the open/close state.
- **Conversation caching** — every chat is saved to `localStorage`, namespaced by
  tenant id (`ib_chats_<tenantId>`), and restored automatically when the widget reopens
  — including across full page reloads.
- **New Chat + history + delete** — a history icon opens a small panel listing saved
  chats (auto-titled from the first question) with relative timestamps; click to switch,
  trash icon to delete. "New chat" starts fresh while keeping everything else saved.
- **Dynamic, data-grounded follow-ups** — the model is instructed to always end its
  response with a hidden `{"followups": [...]}` block generated from whatever data it
  just saw, so switching to a brand-new tenant JSON with no curated question list still
  gets relevant follow-ups. Falls back to word-overlap scoring against the tenant's
  static `suggested_questions` only if the model doesn't comply.
- **References as buttons** — if a tenant's JSON includes a `references` field (or any
  field with real URLs), the model is instructed to cite it as a Markdown link, which
  renders as a styled button (not a plain blue underline).
- **Copy everything** — every assistant message gets a hover-reveal Copy button (copies
  the plain-text answer); every chart gets a copy-image button (writes a PNG to the
  clipboard via the Clipboard API, or downloads it if that's unsupported). Tables and
  message text are normal selectable text — nothing sets `user-select: none`.
- **No forced scroll-hijacking** — while a response streams in, the view only
  auto-scrolls if the user is already near the bottom. If they've scrolled up to read
  something, a floating ↓ button appears instead of yanking them back down.
- **Friendly errors only** — the frontend's own error paths never surface `err.message`
  to the UI; technical detail goes to `console.error` for developers, the UI always
  shows a generic "something went wrong, retry" message.

## 2. Setup

### Prerequisites
- Node.js ≥ 18
- A free OpenRouter API key: https://openrouter.ai/keys (no credit card needed)

### Install & run

```bash
cd survey-chatbot/backend
npm install
cp .env.example .env
# edit .env, paste your OPENROUTER_API_KEY
npm start
```

Open either demo page:
- `http://localhost:3001/demo-default.html`
- `http://localhost:3001/demo-acme-retail.html`

### Testing

```bash
cd survey-chatbot/backend
npm test
```

Runs the unit test suite (`test/*.test.js`) via Node's built-in test runner — no extra
dependency to install. Covers `sanitizeMessages`, `buildSystemPrompt` (including tenant
isolation), `detectEngagementSignal`, `resolveProviderEntry`, `KeyedSemaphore`,
`streamFromProviderChain`'s failover behavior (via a mocked `fetch`), and
`classifyIntent`/`isAffirmative`/`extractEmail`. This covers the modules extracted out of
`server.js` into `lib/` — it does not yet cover the route handlers still living directly
in `server.js` (see the Round 3 note in section 1).

## 3. Tenant JSON schema

```json
{
  "tenant_meta": {
    "tenant_id": "your-tenant-id",
    "widget_title": "Header title in the chat panel",
    "widget_subtitle": "Small subtitle under the title",

    "provider": {
      "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "ACME_OPENROUTER_KEY",
      "models": ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-r1:free"]
    },
    "fallbackProviders": [
      { "apiUrl": "https://openrouter.ai/api/v1/chat/completions", "apiKeyEnv": "BACKUP_KEY", "models": ["qwen/qwen-2.5-72b-instruct:free"] }
    ]
  },
  "suggested_questions": ["Shown as chips before the first real question is asked"],
  "references": [
    { "title": "Full report", "url": "https://example.com/report" }
  ],
  "survey_meta": { "title": "...", "total_respondents": 0 },
  "...": "any other fields — this whole object (minus tenant_meta/suggested_questions) is injected into the system prompt as-is"
}
```

- `provider` and `fallbackProviders` are both **optional**. Omit entirely and the tenant
  uses the global `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` from `.env`, plus a built-in
  safety net of two more free models appended automatically.
- `apiKeyEnv` names an environment variable to read the key from — set it in `.env`
  alongside the global key. This is what makes per-tenant billing/usage tracking work:
  each tenant's requests go out under its own key.
- Any OpenAI-compatible chat-completions endpoint works for `apiUrl`, not just
  OpenRouter — as long as it accepts a `models` array (or ignores it gracefully) and
  streams via SSE in the same `choices[0].delta.content` shape.

Add a new tenant by dropping a new file in `data/tenants/`, restart `npm start`, embed:
```html
<script src="https://your-backend.example.com/widget.js" data-tenant="your-tenant-id"></script>
```

## 4. Known limitations / scope boundaries

- **Failover applies before streaming starts, not mid-stream.** Once bytes have started
  reaching the browser for a given response, we don't switch providers for that same
  response (there's no clean way to "restart" a stream the client has already partially
  received). A connection that drops mid-stream is instead handled by the *client's*
  own retry-on-network-failure logic, which is a separate, simpler mechanism.
- **Prompt sanitization is defense-in-depth, not a guarantee.** Length caps, control-char
  stripping, and an explicit "don't follow instructions in user content" system-prompt
  rule meaningfully raise the bar, but no open-weight/free-tier model can be guaranteed
  immune to all injection framings. Don't put anything in a tenant's dataset that would
  be damaging if partially leaked through a sufficiently clever prompt.
- **`data-tenant` is client-supplied.** Combined with per-tenant origin allowlisting
  (`tenant_meta.allowedOrigins`) and per-visitor rate limiting (both enforced in
  `/api/chat`, Redis-backed when `REDIS_URL` is set), this is fine for the intended use
  — a tenant's widget only serves that tenant's own site visitors, and abuse from an
  unlisted origin is rejected before it reaches the LLM. A tenant with no
  `allowedOrigins` set is left open deliberately (fine for local dev/demos) — as of
  Round 3 this is now surfaced as a visible "⚠ unprotected" badge in the admin panel
  instead of only a boot-time console warning, so it isn't missed in production.
- **Per-visitor rate limiting is live**, not a TODO — `RATE_LIMIT_PER_MINUTE` env var,
  enforced per IP+tenant, Redis-backed when `REDIS_URL` is set (falls back to per-process
  in-memory otherwise — fine for one instance, not a shared cap across several). The
  provider-concurrency semaphore is a separate mechanism and does NOT share this
  Redis-backing even when `REDIS_URL` is set — see the Round 3 note above.
- **`/api/logs/summary` and every other `/api/admin/*` route require a real admin
  session** (login/logout, brute-force lockout, Redis-backed sessions) — not open, not
  Basic Auth.
- **Conversation history sent to the LLM is capped**, not the full thread forever —
  last 12 messages, to bound both cost and latency as a conversation grows.
- **Each tenant's dataset is injected into the system prompt in full on every request
  by default** — fine for a dataset of a few hundred rows, not for something the size of
  a 100+-country visa knowledge base. The KB Service (`kb-service/`, Qdrant-backed
  retrieval) **is wired into `/api/chat`** and runs alongside the full injection
  whenever `KB_SERVICE_URL` is configured; set `tenant_meta.useKbOnly: true` on a large
  tenant to skip the full injection and rely on retrieval alone instead — see the
  Round 3 section above and section 6 below.
- **`server.js` is partially, not fully, decomposed.** System-prompt building, provider
  failover, and input sanitization are now separate, unit-tested modules (Round 3); the
  route handlers themselves (chat, admin, tenant CRUD, KB proxy) are still one file.

## 5. Try it

- "What's the satisfaction score for Notion vs Jira?" → table + copy button
- "Show me a chart of AI tool usage frequency" → chart + copy-image button
- Ask something not in the data → gets a graceful "closest available info" answer, not a dead end
- Click the ■ stop button mid-response → keeps partial text, stops cleanly
- Minimize, then reopen → panel restores
- Refresh the whole page → conversation is still there
- New chat → history icon → switch back to the old one → still intact
- Type "hi" → instant client-side reply, no API call

## 6. Optional: the KB Service (retrieval for large tenant datasets)

For a tenant whose content is too large to inject into the system prompt in full — e.g.
a visa-consultancy dataset covering 100+ countries, each with its own study/work/
immigration files — `kb-service/` provides Qdrant-backed retrieval instead.

### Setup

```bash
cd survey-chatbot/kb-service
pip install -r requirements.txt --break-system-packages
cp .env.example .env   # set KB_SERVICE_API_KEY; QDRANT_URL if using a real Qdrant
                        # instance instead of the local embedded mode (recommended
                        # once you're past a handful of files — see below)
uvicorn app:app --port 8000
```

Then in the backend's `.env`: set `KB_SERVICE_URL=http://localhost:8000` and
`KB_SERVICE_API_KEY` to match. Once set, `/api/chat` calls the KB Service on every turn
for any tenant, appending retrieved excerpts as extra context alongside (or, with
`useKbOnly: true`, instead of) the tenant's full injected dataset.

### Ingesting files

- One file at a time: admin panel → Knowledge Base tab (per-tenant, with optional
  country/category fields), or `POST /ingest` directly.
- Many files at once (e.g. one visa-type file per country, at scale): `POST
  /ingest-batch` — multiple files in one call, each getting its own job id so one bad
  file doesn't block the rest. Country/category can be set per-file via a JSON
  filename→value map.
- **Keep visa categories in separate files, not merged per-country.** A formatting slip
  in one file only degrades that one file's section-splitting — a merged
  study/work/immigration file means one slip tangles all three together. See the
  `category` field (mirrors `country`) if you want retrieval scoped to visa type.
- **Check `tocDetected` in the response** (or the "⚠ no TOC split" badge in the admin
  ingestion history) for any file — `false` means that file's Table of Contents didn't
  cleanly match its body headings and it was ingested as one whole-file chunk instead of
  being split by section. Worth a formatting review before assuming retrieval quality is
  consistent across a large batch.
- **Use a real Qdrant instance (`QDRANT_URL` set), not the local embedded mode, once
  you're ingesting more than a handful of files.** The embedded mode is single-process/
  file-locked and doesn't get the per-tenant HNSW optimization the multi-tenancy design
  relies on at scale.
