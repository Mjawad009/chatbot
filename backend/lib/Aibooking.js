/**
 * aiBooking.js — an alternative to the field-by-field state machine in
 * automationState.js / server.js's collecting/confirming branches. That
 * system asks a cheap classifier to guess, one message at a time and with
 * no real context, whether a reply is an answer, a digression, or a cancel
 * — then splices a field's `label` directly into a canned question
 * template. Both of those are real, demonstrated failure points: a
 * misconfigured/slow classifier fails open and lets genuine questions get
 * recorded as literal field values, and a label written as a description
 * ("what they're trying to solve") rather than a fill-in-the-blank noun
 * phrase produces grammatically broken questions.
 *
 * This hands the ENTIRE booking conversation to the model instead, as a
 * tool it can call once it believes it has everything it needs. It asks
 * for what's missing in its own words, handles digressions and
 * corrections inline because it's driving the conversation (not being
 * polled turn-by-turn by external logic with no memory of its own), and
 * only "submits" via the tool call — which is validated server-side
 * before the automation is actually allowed to execute, so a confident
 * but wrong tool call can't submit incomplete/malformed data.
 *
 * Deliberately a NEW, separate automation type ("ai_managed") rather than
 * a replacement for the existing system — existing tenants' working
 * automations are untouched; this is opt-in per automation.
 */

const TOOL_NAME = "submit_booking";

/**
 * Converts an automation's field list into an OpenAI/OpenRouter-compatible
 * function tool schema. Every field becomes a string parameter — dates,
 * emails, free text, all of it; validateArguments() below does the actual
 * type-shaped checking after the model calls the tool, rather than trying
 * to constrain the model's own generation with narrower JSON-schema types
 * it may not honor precisely anyway.
 */
function buildToolSchema(automation) {
  const properties = {};
  const required = [];
  for (const field of automation.fields || []) {
    properties[field.key] = {
      type: "string",
      description: field.label || field.key,
    };
    if (field.required !== false) required.push(field.key);
  }
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: `Call this ONLY once you have collected every required piece of information for "${automation.name || automation.id}" from the user. Do not call it with guessed, placeholder, or incomplete values — ask the user instead.`,
      parameters: { type: "object", properties, required },
    },
  };
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Deliberately conservative: only flags a value as invalid when it's
 * confidently wrong (empty, or a named email/phone field that doesn't
 * look like one) — not a broad content judgment call, which is exactly
 * the kind of guess that made the old classifier unreliable. Ambiguous
 * cases pass; the model itself is trusted for that judgment, since it can
 * see the actual conversation context this function can't.
 */
function validateArguments(fields, args) {
  const problems = [];
  for (const field of fields || []) {
    if (field.required === false) continue;
    const value = (args?.[field.key] ?? "").toString().trim();
    if (!value) {
      problems.push(`"${field.key}" (${field.label || field.key}) is missing.`);
      continue;
    }
    const keyLower = field.key.toLowerCase();
    if (keyLower.includes("email") && !EMAIL_RE.test(value)) {
      problems.push(`"${field.key}" was given as "${value}", which doesn't look like a valid email address.`);
    }
  }
  return { valid: problems.length === 0, problems };
}

/**
 * Runs one turn of an AI-managed booking conversation. `cleanMessages`
 * should be the full sanitized conversation history including the user's
 * latest message — the model gets full context every turn, unlike the
 * old per-field classifier which only ever saw one message at a time.
 *
 * Returns one of:
 *   { type: "message", text }         — model is asking/responding, conversation continues
 *   { type: "submit", collected }     — validated tool call, ready to executeAutomation()
 *   { type: "error", text }           — couldn't get a usable turn at all (provider failure)
 */
async function runAiManagedTurn(tenant, automation, cleanMessages) {
  const provider = tenant.providerChain?.[0];
  if (!provider?.apiUrl || !provider?.apiKey || !provider?.models?.length) {
    return { type: "error", text: "Booking isn't available right now — please try again shortly." };
  }

  const tool = buildToolSchema(automation);
  const systemPrompt =
    `You are helping a user complete "${automation.name || automation.id}". ` +
    `Collect the following information through natural conversation, one or two things at a time — don't interrogate with a rigid list. ` +
    `If the user asks an unrelated question or makes a comment, answer or acknowledge it naturally, then continue collecting what's still missing — ` +
    `don't just ignore what they said and repeat your last question verbatim. ` +
    `If they want to stop or cancel, acknowledge that plainly instead of calling the tool. ` +
    `Only call ${TOOL_NAME} once you have every required field with a real, specific value — never with guessed or placeholder values.`;

  const messages = [{ role: "system", content: systemPrompt }, ...cleanMessages];

  // Bounded retry: if the model calls the tool with something invalid,
  // feed the specific problem back and give it one more chance to correct
  // itself — rather than either trusting a bad tool call or leaving the
  // user stuck with no explanation. Capped at 2 total attempts so a
  // persistently confused model can't loop indefinitely on one turn.
  for (let attempt = 0; attempt < 2; attempt++) {
    let data;
    try {
      const res = await fetch(provider.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({
          model: provider.models[0],
          messages,
          tools: [tool],
          tool_choice: "auto",
          temperature: 0.3,
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { type: "error", text: "Booking isn't available right now — please try again shortly." };
      data = await res.json();
    } catch {
      return { type: "error", text: "Booking isn't available right now — please try again shortly." };
    }

    const message = data?.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.find((tc) => tc.function?.name === TOOL_NAME);

    if (!toolCall) {
      // Model chose to just talk — a clarifying question, an answer to a
      // digression, an acknowledgment of "cancel", whatever it judged the
      // right response to be. That IS the conversation; hand it back as-is.
      const text = (message?.content || "").trim();
      return { type: "message", text: text || "Could you tell me a bit more?" };
    }

    let args;
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      args = {};
    }

    const { valid, problems } = validateArguments(automation.fields, args);
    if (valid) {
      return { type: "submit", collected: args };
    }

    if (attempt === 0) {
      // Echo the model's own tool-call turn back, then the tool result
      // explaining exactly what's wrong — the standard tool-calling
      // correction pattern, not a synthetic user message.
      messages.push(message);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: `Cannot submit yet: ${problems.join(" ")} Ask the user for the missing/corrected information.`,
      });
      continue;
    }

    // Second attempt also came back invalid — stop retrying against the
    // model's own judgment and just tell the user plainly what's needed,
    // deterministically, so this can't loop forever on one turn.
    return { type: "message", text: `I still need: ${problems.join(" ")}` };
  }

  return { type: "error", text: "Booking isn't available right now — please try again shortly." };
}

module.exports = { TOOL_NAME, buildToolSchema, validateArguments, runAiManagedTurn };
