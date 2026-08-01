const test = require("node:test");
const assert = require("node:assert/strict");
const { detectCancelIntent, looksLikePlausibleAnswer, classifyFieldReply, answerDigression } = require("../lib/digressionHandler");

test("detectCancelIntent: recognizes common cancel phrases", () => {
  for (const msg of ["cancel", "Cancel", "stop", "never mind", "nevermind", "forget it", "forget this", "quit", "exit", "not now", "nvm", "  cancel  ", "cancel."]) {
    assert.equal(detectCancelIntent(msg), true, `expected "${msg}" to be detected as cancel`);
  }
});

test("detectCancelIntent: does not misfire on real answers that happen to contain a similar word", () => {
  // A real name/notes answer shouldn't accidentally match — these aren't
  // exact cancel phrases, just messages a paranoid regex might misfire on.
  for (const msg of ["Stopford", "My name is Cancel Smith", "I want to stop by your office", "Please cancel my old appointment and book a new one for Friday"]) {
    assert.equal(detectCancelIntent(msg), false, `expected "${msg}" NOT to be detected as cancel`);
  }
});

test("looksLikePlausibleAnswer: a question mark always fails the heuristic, regardless of field", () => {
  assert.equal(looksLikePlausibleAnswer("What's your refund policy?", { key: "name" }), false);
  assert.equal(looksLikePlausibleAnswer("test@example.com?", { key: "email" }), false);
});

test("looksLikePlausibleAnswer: email field requires an actual email shape", () => {
  assert.equal(looksLikePlausibleAnswer("jane@example.com", { key: "email" }), true);
  assert.equal(looksLikePlausibleAnswer("not an email", { key: "email" }), false);
  assert.equal(looksLikePlausibleAnswer("wait, why do you need my email", { key: "email" }), false); // no @ present at all
});

test("looksLikePlausibleAnswer: phone field requires enough digits", () => {
  assert.equal(looksLikePlausibleAnswer("+1 (555) 123-4567", { key: "phone" }), true);
  assert.equal(looksLikePlausibleAnswer("call me later", { key: "phone" }), false);
});

test("looksLikePlausibleAnswer: generic fields (name, notes, etc.) pass with no question mark", () => {
  assert.equal(looksLikePlausibleAnswer("Ali Raza", { key: "name" }), true);
  assert.equal(looksLikePlausibleAnswer("Tuesday afternoon works best", { key: "preferredTime" }), true);
});

test("looksLikePlausibleAnswer: statement-form digressions with no '?' are NOT treated as answers", () => {
  // This is the exact bug this regression test guards against: a reply
  // that redirects the conversation without ever using a question mark
  // was previously accepted as the field's literal answer, silently
  // corrupting it and skipping straight to the next question.
  assert.equal(looksLikePlausibleAnswer("actually can I ask about pricing first", { key: "name" }), false);
  assert.equal(looksLikePlausibleAnswer("wait I want to know about refunds", { key: "name" }), false);
  assert.equal(looksLikePlausibleAnswer("by the way do you offer discounts", { key: "notes" }), false);
  assert.equal(looksLikePlausibleAnswer("before that, what documents do I need", { key: "preferredTime" }), false);
});

test("looksLikePlausibleAnswer: an unusually long generic-field reply is treated as uncertain, not auto-accepted", () => {
  const ramble =
    "so I was thinking about this for a while and I am not totally sure yet but maybe next week could work depending on stuff";
  assert.equal(looksLikePlausibleAnswer(ramble, { key: "preferredTime" }), false);
});

test("looksLikePlausibleAnswer: empty/whitespace-only input is never plausible", () => {
  assert.equal(looksLikePlausibleAnswer("", { key: "name" }), false);
  assert.equal(looksLikePlausibleAnswer("   ", { key: "name" }), false);
});

// --- classifyFieldReply — LLM fallback via mocked global.fetch ---------

function fakeChatCompletion(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
}

test("classifyFieldReply: fails open to ANSWER when no internal provider is configured", async () => {
  const tenant = { internalProviderChain: [], providerChain: [] };
  const result = await classifyFieldReply(tenant, { key: "name", label: "Full name" }, "hmm");
  assert.equal(result, "ANSWER");
});

test("classifyFieldReply: returns CANCEL when the model says so", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeChatCompletion("CANCEL");
  try {
    const tenant = { internalProviderChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }] };
    const result = await classifyFieldReply(tenant, { key: "email", label: "Email" }, "actually forget the whole thing");
    assert.equal(result, "CANCEL");
  } finally {
    global.fetch = originalFetch;
  }
});

test("classifyFieldReply: returns DIGRESSION when the model says so", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeChatCompletion("DIGRESSION");
  try {
    const tenant = { internalProviderChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }] };
    const result = await classifyFieldReply(tenant, { key: "email", label: "Email" }, "what's your refund policy anyway");
    assert.equal(result, "DIGRESSION");
  } finally {
    global.fetch = originalFetch;
  }
});

test("classifyFieldReply: fails open to ANSWER on a provider error", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    const tenant = { internalProviderChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }] };
    const result = await classifyFieldReply(tenant, { key: "name", label: "Full name" }, "hmm");
    assert.equal(result, "ANSWER");
  } finally {
    global.fetch = originalFetch;
  }
});

test("classifyFieldReply: fails open to ANSWER when fetch throws (network error)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network down"); };
  try {
    const tenant = { internalProviderChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }] };
    const result = await classifyFieldReply(tenant, { key: "name", label: "Full name" }, "hmm");
    assert.equal(result, "ANSWER");
  } finally {
    global.fetch = originalFetch;
  }
});

// --- answerDigression — real-answer generation via mocked global.fetch --

test("answerDigression: returns the model's text on success (no followups block present)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeChatCompletion("We offer a full refund within 30 days.");
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }],
    };
    const result = await answerDigression(tenant, "what's your refund policy?");
    assert.equal(result.text, "We offer a full refund within 30 days.");
    assert.deepEqual(result.followups, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("answerDigression: extracts the model's own trailing followups block instead of leaving raw JSON in the text", async () => {
  const originalFetch = global.fetch;
  const raw =
    'We offer a full refund within 30 days.\n\n```json\n{"followups": ["What documents do I need for a refund?", "How long does processing take?"]}\n```';
  global.fetch = async () => fakeChatCompletion(raw);
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }],
    };
    const result = await answerDigression(tenant, "what's your refund policy?");
    assert.equal(result.text, "We offer a full refund within 30 days.");
    assert.equal(result.text.includes("```"), false, "the json fence must not leak into the displayed text");
    assert.deepEqual(result.followups, ["What documents do I need for a refund?", "How long does processing take?"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("answerDigression: forwards conversation history so a context-dependent digression can be resolved", async () => {
  const originalFetch = global.fetch;
  let capturedMessages = null;
  global.fetch = async (url, opts) => {
    capturedMessages = JSON.parse(opts.body).messages;
    return fakeChatCompletion("Yes, the same discount applies to that program.");
  };
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }],
    };
    const history = [
      { role: "user", content: "Tell me about the MBA program" },
      { role: "assistant", content: "The MBA program is 2 years and costs $20,000." },
    ];
    await answerDigression(tenant, "does the early-bird discount apply to that?", history);
    // system prompt, then history in order, then the digression message itself
    assert.equal(capturedMessages[0].role, "system");
    assert.equal(capturedMessages[1].content, "Tell me about the MBA program");
    assert.equal(capturedMessages[2].content, "The MBA program is 2 years and costs $20,000.");
    assert.equal(capturedMessages[3].content, "does the early-bird discount apply to that?");
  } finally {
    global.fetch = originalFetch;
  }
});

test("answerDigression: works fine with no history passed (undefined/omitted)", async () => {
  const originalFetch = global.fetch;
  let capturedMessages = null;
  global.fetch = async (url, opts) => {
    capturedMessages = JSON.parse(opts.body).messages;
    return fakeChatCompletion("Sure, here's an answer.");
  };
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m"] }],
    };
    await answerDigression(tenant, "what's your refund policy?");
    assert.equal(capturedMessages.length, 2); // system + the message, nothing else
  } finally {
    global.fetch = originalFetch;
  }
});

test("answerDigression: falls through to the next model/provider on failure", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500 };
    return fakeChatCompletion("Fallback answer.");
  };
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["broken-model", "working-model"] }],
    };
    const result = await answerDigression(tenant, "what's your refund policy?");
    assert.equal(result.text, "Fallback answer.");
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("answerDigression: returns null when every provider fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("down"); };
  try {
    const tenant = {
      systemPrompt: "You are a helpful assistant.",
      providerChain: [{ apiUrl: "https://fake", apiKey: "k", models: ["m1", "m2"] }],
    };
    const result = await answerDigression(tenant, "what's your refund policy?");
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
});
