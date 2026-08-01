/**
 * digressionHandler.js — detects when a reply during automation field
 * collection (booking, escalation, or any custom automation) ISN'T
 * actually answering the question being asked.
 *
 * Without this, server.js's field-collection branch takes whatever the
 * user typed as the raw answer, unconditionally — so "cancel", "wait,
 * what's your refund policy?", or any other off-topic reply gets stored
 * as if it were their name/email/whatever, silently corrupting the
 * automation instead of helping them.
 *
 * Two-tier by design, cheapest checks first:
 *  1. Cancel detection — pure regex, zero cost, checked on every reply.
 *  2. Plausible-answer heuristic — pure regex/shape check (does this look
 *     like a real email/phone/etc, or does it contain a "?"). Most real
 *     answers pass this instantly with no LLM call — this is the fast
 *     path that has to stay fast, since it runs on every single reply
 *     during every collection.
 *  3. LLM classification — ONLY when the heuristic is unsure. Uses the
 *     cheap internal provider (same one structureFieldAnswers uses),
 *     fails open (treats an LLM failure as "it's an answer") so a flaky
 *     provider degrades to old behavior rather than blocking the flow.
 */

const CANCEL_RE = /^\s*(cancel|stop|never\s*mind|forget (it|this)|quit|exit|not now|nvm)\s*[.!]?\s*$/i;

function detectCancelIntent(message) {
  return CANCEL_RE.test((message || "").trim());
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// Common ways people redirect mid-flow WITHOUT ever using a "?" —
// "actually, can I ask about pricing first" reads exactly like a real
// answer to a shape-only check (non-empty, no "?"), which is how this bug
// showed up in practice: a genuine digression got silently stored as the
// field's value and the flow moved straight to the next question. This
// isn't trying to be exhaustive — it's a cheap net for the common phrasings
// people actually use to interrupt a flow, backstopped by the LLM
// classifier below for anything it misses.
const DIGRESSION_SIGNAL_RE =
  /\b(actually|wait|hold on|before (that|i|we)|by the way|btw|one (sec|second|moment)|quick question|can i ask|also,? (i|can|do|is|does|what)|what about|tell me about|instead|never ?mind that|forget that)\b/i;

// Pure shape check — no LLM. True = "confidently looks like a real
// answer, skip the LLM classifier entirely." False = "uncertain, worth a
// classifier call before assuming this is the field's value."
function looksLikePlausibleAnswer(message, field) {
  const text = (message || "").trim();
  if (!text) return false;
  // A question mark is a strong signal this is NOT a direct answer,
  // regardless of field type — genuine answers essentially never end in
  // "?", but "wait, why do you need that?" always will.
  if (text.includes("?")) return false;
  if (DIGRESSION_SIGNAL_RE.test(text)) return false;

  const key = (field?.key || "").toLowerCase();
  if (key.includes("email")) return EMAIL_RE.test(text);
  if (key.includes("phone")) return (text.replace(/[^\d]/g, "").length >= 7);
  // Generic fields (name, notes, preferredTime, custom fields, etc.) — no
  // "?", no digression phrase, and short enough to plausibly BE a name/
  // time/short note rather than a redirect or a ramble. A real answer to
  // "what's your name?" or "what time works?" is essentially never more
  // than a handful of words; anything longer is worth the one cheap
  // classifier call rather than risking silent corruption. Being lenient
  // under that length is still deliberate: false negatives just cost one
  // extra classification call, false positives mean genuine short answers
  // routinely getting second-guessed, which is worse UX.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount <= 12;
}

// LLM fallback — only reached when looksLikePlausibleAnswer() returned
// false. Uses the tenant's cheap internal provider, same pattern as
// automationFields.js's structureFieldAnswers, since this is a small
// classification task, not a user-facing answer.
async function classifyFieldReply(tenant, field, message) {
  const provider = tenant.internalProviderChain?.[0] || tenant.providerChain?.[0];
  if (!provider?.apiUrl || !provider?.apiKey || !provider?.models?.length) {
    return "ANSWER"; // fail open — no internal provider configured, don't block the flow
  }
  try {
    const res = await fetch(provider.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.models[0],
        messages: [
          {
            role: "user",
            content:
              `A user is being asked: "${field.label}". They replied: "${message}".\n\n` +
              `Is their reply (a) an attempt to answer that question — even if oddly phrased, incomplete, or a correction — ` +
              `(b) an unrelated question or comment that should be addressed separately before continuing, or ` +
              `(c) a request to cancel or stop the current process?\n\n` +
              `Respond with EXACTLY one word: ANSWER, DIGRESSION, or CANCEL. No other text.`,
          },
        ],
        max_tokens: 10,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(6_000), // this runs on the hot chat path — fail open fast, don't make someone wait on a classifier
    });
    if (!res.ok) return "ANSWER";
    const data = await res.json();
    const word = (data?.choices?.[0]?.message?.content || "").trim().toUpperCase();
    if (word.includes("CANCEL")) return "CANCEL";
    if (word.includes("DIGRESSION")) return "DIGRESSION";
    return "ANSWER";
  } catch {
    return "ANSWER"; // fail open — same reasoning as automationFields.js
  }
}

// Finds the LAST ```json fence in a raw model response, parses it, and —
// if it's a well-formed {"followups": [...]} block — returns the text
// with that fence removed plus the extracted array. Mirrors the parsing
// widget.js already does client-side for the main streaming chat path;
// this is the server-side equivalent, needed here because
// sendGuardrailResponse() always appends its OWN trailing followups
// fence after whatever text it's given. Without this, the widget sees
// two followups fences on the wire (the model's real one from
// answerDigression, then sendGuardrailResponse's hardcoded empty one)
// and — since its parser takes whichever fence it sees LAST, not a
// merge — the empty one always won, silently discarding every
// suggestion the model actually generated.
function extractTrailingFollowups(rawText) {
  const text = (rawText || "").trim();
  const fenceStart = text.lastIndexOf("```json");
  if (fenceStart === -1) return { text, followups: [] };
  const fenceEnd = text.indexOf("```", fenceStart + 7);
  if (fenceEnd === -1) return { text, followups: [] }; // unterminated fence — leave text as-is, nothing to extract

  const fenceBody = text.slice(fenceStart + 7, fenceEnd).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(fenceBody);
  } catch {
    return { text, followups: [] }; // not valid JSON — leave the fence in place rather than guess
  }

  if (!parsed || !Array.isArray(parsed.followups)) return { text, followups: [] };
  const followups = parsed.followups.filter((q) => typeof q === "string" && q.trim());
  const withoutFence = (text.slice(0, fenceStart) + text.slice(fenceEnd + 3)).trim();
  return { text: withoutFence, followups };
}

// Answers a confirmed digression for real, using the tenant's actual
// system prompt and PRIMARY provider chain — unlike classifyFieldReply
// above, this IS a real user-facing answer, so it deserves real answer
// quality, not the cheap internal model. Non-streaming (the caller needs
// the complete text to append a "back to your booking" reminder after
// it), tried across the whole provider chain like a normal chat turn.
//
// historyMessages: same trimmed {role, content} array the main chat path
// sends — without it, a digression that references something said
// earlier in the conversation ("does that also apply to the one I asked
// about?") has no way to know what "that" or "the one" refers to.
//
// Returns { text, followups }, or null if every provider failed — caller
// falls back gracefully either way.
async function answerDigression(tenant, message, historyMessages) {
  const history = Array.isArray(historyMessages) ? historyMessages : [];
  for (const provider of tenant.providerChain || []) {
    for (const model of provider.models || []) {
      try {
        const res = await fetch(provider.apiUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: tenant.systemPrompt },
              ...history,
              { role: "user", content: message },
            ],
            max_tokens: 500, // was 400 — a little headroom since the trailing followups block eats into the same budget
            temperature: 0.3,
            stream: false,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (raw && raw.trim()) return extractTrailingFollowups(raw);
      } catch {
        continue; // try the next model/provider in the chain
      }
    }
  }
  return null;
}

module.exports = { detectCancelIntent, looksLikePlausibleAnswer, classifyFieldReply, answerDigression };
