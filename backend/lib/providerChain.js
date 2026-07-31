/**
 * lib/providerChain.js — resolves each tenant's provider config, enforces
 * a per-provider-key concurrency cap (KeyedSemaphore), and streams a chat
 * completion across a tenant's provider chain with automatic failover to
 * the next provider on a pre-stream failure. Extracted out of server.js's
 * original single-file monolith.
 *
 * Concurrency control caps how many requests are in flight AT ONCE against
 * the SAME provider key. Without this, N simultaneous users across one or
 * many tenants sharing a key can all fire at once, each individually
 * retrying across the fallback chain, and burst straight through the
 * free-tier rate limit together — which looks like "the API stops
 * responding" even though no single request did anything wrong. Extra
 * requests queue briefly instead of firing all at once; if the queue wait
 * itself times out, that provider entry is treated as busy and we move to
 * the next one in the chain.
 *
 * This module owns no tenant/request state beyond the semaphore singleton
 * below, which is intentionally process-local (see the NOTE in the
 * KeyedSemaphore comment: this does NOT become distributed just because
 * REDIS_URL is set — kv.js's simple get/set/list primitives can't express
 * atomic acquire/release. Running multiple instances gives each its own
 * independent concurrency cap, not a shared one — size
 * MAX_CONCURRENT_PER_PROVIDER_KEY with that in mind if you scale out).
 */

function resolveProviderEntry(raw, globalDefaults) {
  const apiUrl = raw.apiUrl || globalDefaults.apiUrl;
  const apiKey = raw.apiKeyEnv ? process.env[raw.apiKeyEnv] : globalDefaults.apiKey;
  const models = Array.isArray(raw.models) && raw.models.length ? raw.models : [globalDefaults.model];
  return { apiUrl, apiKey, models, apiKeyEnvName: raw.apiKeyEnv || "OPENROUTER_API_KEY (global)" };
}

const MAX_CONCURRENT_PER_KEY = Number(process.env.MAX_CONCURRENT_PER_PROVIDER_KEY) || 3;
const MAX_QUEUE_WAIT_MS = Number(process.env.MAX_PROVIDER_QUEUE_WAIT_MS) || 8000;

// NOTE on multi-instance deployments: unlike the rate limiter and admin
// sessions (both backed by kv.js, which uses real Redis when REDIS_URL is
// set), this semaphore is ALWAYS per-process in-memory — a plain JS Map,
// not something kv.js's simple get/set/list primitives can express (a real
// distributed semaphore needs atomic acquire/release, e.g. a Lua script or
// Redis's WAIT/BLPOP primitives — not implemented here). Setting REDIS_URL
// does NOT make this distributed: running N instances gives you N times
// MAX_CONCURRENT_PER_KEY actual concurrency against each provider key, not
// a shared cap of MAX_CONCURRENT_PER_KEY total. Fine for a single instance;
// account for instance count when sizing MAX_CONCURRENT_PER_PROVIDER_KEY
// (or your upstream provider's own rate limits) if you scale out.
class KeyedSemaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = new Map(); // key -> count
    this.waiters = new Map(); // key -> [{resolve, reject, timer}]
  }
  acquire(key) {
    const active = this.active.get(key) || 0;
    if (active < this.limit) {
      this.active.set(key, active + 1);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const q = this.waiters.get(key) || [];
        const idx = q.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) q.splice(idx, 1);
        reject(new Error("Timed out waiting for provider capacity (too many concurrent requests)"));
      }, MAX_QUEUE_WAIT_MS);
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key).push({ resolve, reject, timer });
    });
  }
  release(key) {
    const q = this.waiters.get(key) || [];
    if (q.length > 0) {
      const next = q.shift();
      clearTimeout(next.timer);
      next.resolve(); // hand the slot directly to the next waiter — active count unchanged
      return;
    }
    const active = this.active.get(key) || 0;
    this.active.set(key, Math.max(0, active - 1));
  }
}
const providerSemaphore = new KeyedSemaphore(MAX_CONCURRENT_PER_KEY);

async function streamFromProviderChain(providerChain, payloadMessagesBuilder, res, clientAbortSignal) {
  let lastError = null;
  // One entry per provider actually attempted (skips don't count — a
  // provider with no apiKey never made a request). Lets the caller log
  // exactly how many providers were tried for this one client response,
  // how long each attempt took, and why the earlier ones didn't stick —
  // previously this was invisible: only the last, winning attempt's own
  // stats made it into the conversation log.
  const attempts = [];

  for (let i = 0; i < providerChain.length; i++) {
    const provider = providerChain[i];
    if (!provider.apiKey) {
      lastError = new Error(`No API key configured for provider ${i} (${provider.apiKeyEnvName})`);
      continue; // not a real attempt — never left the ground, nothing to time
    }

    const attemptStartedAt = Date.now();
    const recordAttempt = (outcome, extra = {}) => {
      attempts.push({ providerIndex: i, model: provider.models[0], outcome, durationMs: Date.now() - attemptStartedAt, ...extra });
    };

    const semaphoreKey = provider.apiKeyEnvName + "|" + provider.apiUrl;
    try {
      await providerSemaphore.acquire(semaphoreKey);
    } catch (queueErr) {
      lastError = queueErr; // this provider is saturated — try the next one instead of waiting forever
      recordAttempt("queue_timeout", { error: queueErr.message });
      continue;
    }

    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    if (clientAbortSignal) clientAbortSignal.addEventListener("abort", onClientAbort);
    const timeout = setTimeout(() => controller.abort(), 55000);

    let fullResponseText = "";
    let finishReason = null;
    let usage = null;
    let actualModel = null;
    let startedStreamingToClient = false;
    let midStreamError = null;

    try {
      const upstream = await fetch(provider.apiUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.apiKey}`,
          "HTTP-Referer": "http://localhost",
          "X-Title": "Insight Bot Survey Chatbot",
        },
        body: JSON.stringify({
          models: provider.models, // OpenRouter native in-request model fallback
          max_tokens: 16000,
          messages: payloadMessagesBuilder(),
          stream: true,
          stream_options: { include_usage: true }, // asks for a final chunk with real prompt/completion token counts
          // Reasoning-capable models (Gemini 2.5, Nemotron 3 Ultra,
          // DeepSeek-R1, and others) stream their internal "thinking" in a
          // separate reasoning_content field that this code never reads —
          // only delta.content is captured below. If a reasoning model
          // spends its whole token budget thinking before emitting real
          // content, fullResponseText stays empty and the whole attempt
          // gets reported as "returned no content", even though the
          // request itself succeeded. This is a grounded Q&A chatbot, not
          // a task that benefits from visible-to-us reasoning, so turn it
          // off unconditionally rather than trying to pattern-match model
          // names — OpenRouter ignores this param on models that don't
          // support it, so it's harmless to send everywhere.
          reasoning: { max_tokens: 0 },
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "Unknown upstream error");
        lastError = new Error(`Provider ${i} (${provider.apiUrl}) returned ${upstream.status}: ${errText}`);
        clearTimeout(timeout);
        recordAttempt("http_error", { error: lastError.message, status: upstream.status });
        continue; // try next provider — nothing sent to client yet
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const event = JSON.parse(payload);
            const delta = event.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              if (!startedStreamingToClient) {
                startedStreamingToClient = true;
              }
              res.write(delta);
              fullResponseText += delta;
            }
            if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason;
            if (event.usage) usage = event.usage; // present on the final chunk only
            if (event.model) actualModel = event.model;
            if (event.error) {
              midStreamError = new Error(event.error?.message || "Unknown streaming error");
              lastError = midStreamError;
              if (!startedStreamingToClient) continue; // nothing sent yet — safe to fall through and retry a fresh provider below
              // Real content already reached the client on THIS provider's
              // stream — we're committed. Falling through to another
              // provider here used to mean its full answer got appended
              // onto this one's leftover fragment in the same HTTP
              // response, with no boundary between them, while only the
              // winning provider's own stats got logged (so the log's
              // response length/tokens silently undercounted what the
              // client actually received). Stop reading and return what
              // was actually streamed instead.
              break readLoop;
            }
          } catch {
            // ignore malformed SSE fragments
          }
        }
      }

      clearTimeout(timeout);
      if (clientAbortSignal) clientAbortSignal.removeEventListener("abort", onClientAbort);

      if (!startedStreamingToClient && fullResponseText.length === 0) {
        // Nothing usable came back at all — treat as a failure and try the next provider.
        lastError = lastError || new Error(`Provider ${i} returned no content`);
        recordAttempt("no_content", { error: lastError.message });
        continue;
      }

      if (midStreamError && startedStreamingToClient) {
        // Degraded success: real (partial) content is already on the wire.
        // Report it honestly rather than silently trying another provider.
        recordAttempt("truncated_mid_stream", { error: midStreamError.message, charsStreamed: fullResponseText.length });
        return { ok: true, usedProviderIndex: i, model: actualModel || provider.models[0], fullResponseText, finishReason, usage, truncatedMidStream: true, attempts };
      }

      recordAttempt("success", { charsStreamed: fullResponseText.length });
      return { ok: true, usedProviderIndex: i, model: actualModel || provider.models[0], fullResponseText, finishReason, usage, truncatedMidStream: false, attempts };
    } catch (err) {
      clearTimeout(timeout);
      if (clientAbortSignal) clientAbortSignal.removeEventListener("abort", onClientAbort);
      if (err.name === "AbortError" && clientAbortSignal && clientAbortSignal.aborted) {
        // The client hit the stop button — not a provider failure, propagate immediately.
        throw err;
      }
      lastError = err;
      if (startedStreamingToClient) {
        // Same reasoning as the mid-stream event.error case above: real
        // content already reached the client on this attempt, so return it
        // honestly instead of letting another provider's output land on
        // top of it.
        recordAttempt("network_error_after_partial", { error: err.message, charsStreamed: fullResponseText.length });
        return { ok: true, usedProviderIndex: i, model: actualModel || provider.models[0], fullResponseText, finishReason, usage, truncatedMidStream: true, attempts };
      }
      recordAttempt("network_error", { error: err.message });
      continue;
    } finally {
      // Guaranteed to run whether we returned, continued to the next provider, or threw —
      // so a slot is never leaked and the next queued request can proceed.
      providerSemaphore.release(semaphoreKey);
    }
  }

  const finalError = lastError || new Error("All providers failed");
  finalError.attempts = attempts; // let the caller log what was tried even on total failure
  throw finalError;
}

module.exports = { resolveProviderEntry, streamFromProviderChain, providerSemaphore, KeyedSemaphore };
