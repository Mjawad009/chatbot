/**
 * automationFields.js — LLM calls that turn conversation content into
 * structured fields, using whatever `fields` array is passed in (an
 * automation's configured Required Input Fields — could be booking's
 * [name, email, preferredTime], or a brand-new "Visa Status" automation's
 * [applicationId, email], or anything an admin defines). Generic by
 * design: it doesn't know or care what any field MEANS, just pulls out
 * whatever the caller asked for.
 *
 * (Formerly bookingStructurer.js, hardcoded to tenant.bookingFields — this
 * is the generalized version every automation type shares, per the
 * Automations framework.)
 *
 * Used two ways:
 *  1. Pre-ask: extract from conversation HISTORY alone, so anything the
 *     customer already mentioned earlier doesn't get asked again.
 *  2. Post-reply: extract from the customer's reply (with history as
 *     context), then mergeStructured() combines it with what was already
 *     known — the reply wins on any field it actually addresses.
 *
 * Never blocks on failure — falls back to every field null, with raw text
 * kept in `notes`. An automation should never lose a customer's input just
 * because structuring didn't work.
 */

function historyToText(historyMessages, maxMessages = 12) {
  if (!Array.isArray(historyMessages)) return "";
  return historyMessages
    .slice(-maxMessages)
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n");
}

async function extractFields(tenant, fields, { historyMessages, replyText }) {
  const keys = (fields || []).map((f) => f.key);

  function emptyResult() {
    const out = {};
    for (const k of keys) out[k] = null;
    return out;
  }

  if (keys.length === 0) return emptyResult();

  const provider = tenant.internalProviderChain?.[0] || tenant.providerChain?.[0];
  if (!provider?.apiUrl || !provider?.apiKey || !provider?.models?.length) return emptyResult();

  const fieldList = fields.map((f) => `- ${f.key}: ${f.label}${f.required ? " (required)" : ""}`).join("\n");
  const historyText = historyToText(historyMessages);

  const prompt = `Extract the following fields from the conversation below. Respond with ONLY a JSON object with exactly these keys: ${JSON.stringify(keys)}. Use null for any field not mentioned anywhere or unclear — never guess.${
    replyText ? " Give the customer's most recent message the most weight, but also use earlier conversation context." : " Use only what's mentioned in the conversation so far — the customer hasn't been asked directly yet."
  } No other text, no markdown formatting, just the JSON object.

Fields to extract:
${fieldList}

Conversation so far:
${historyText || "(none yet)"}
${replyText ? `\nCustomer's most recent message:\n"""${replyText}"""` : ""}`;

  try {
    const res = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.models[0],
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return emptyResult();

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);

    const out = {};
    for (const k of keys) out[k] = typeof parsed[k] === "string" ? parsed[k].trim() || null : parsed[k] ?? null;
    return out;
  } catch (err) {
    console.error("❌ Automation field extraction failed, treating as unknown:", err.message);
    return emptyResult();
  }
}

async function extractKnownFields(tenant, fields, historyMessages) {
  return extractFields(tenant, fields, { historyMessages, replyText: null });
}

async function structureFieldAnswers(tenant, fields, replyText, historyMessages) {
  const keys = (fields || []).map((f) => f.key);
  const extracted = await extractFields(tenant, fields, { historyMessages, replyText });
  const anyFound = keys.some((k) => extracted[k]);
  return { ...extracted, notes: replyText, _structured: anyFound };
}

function mergeStructured(known, fresh) {
  const merged = { ...known };
  for (const [k, v] of Object.entries(fresh)) {
    if (k === "notes" || k === "_structured") continue;
    if (v !== null && v !== undefined) merged[k] = v;
  }
  merged.notes = fresh.notes;
  merged._structured = fresh._structured || Object.values(known).some((v) => v);
  return merged;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_REGEX = /(\+?\d[\d\s-]{7,14}\d)/;
const FILLER_PREFIX = /^\s*(it'?s|it is|that'?s|sure,?|yes,?|my [a-z ]+ is)\s*/i;

// One-field-at-a-time collection — deliberately NOT an LLM call (that would
// mean one extra round trip per field). The question just asked is specific
// enough that the reply is almost always just the answer; this cleans up
// common phrasing ("it's ali@example.com") without needing to understand
// the sentence.
function cleanFieldAnswer(rawText, field) {
  const trimmed = (rawText || "").trim();
  const looksLikeEmail = /email/i.test(field?.key || "") || /email/i.test(field?.label || "");
  const looksLikePhone = /phone|whatsapp|mobile|contact number/i.test(field?.key || "") || /phone|whatsapp|mobile|contact number/i.test(field?.label || "");

  if (looksLikeEmail) {
    const match = trimmed.match(EMAIL_REGEX);
    if (match) return match[0];
  }
  if (looksLikePhone) {
    const match = trimmed.match(PHONE_REGEX);
    if (match) return match[0].trim();
  }
  return trimmed.replace(FILLER_PREFIX, "").trim() || trimmed;
}

module.exports = { extractKnownFields, structureFieldAnswers, mergeStructured, cleanFieldAnswer };
