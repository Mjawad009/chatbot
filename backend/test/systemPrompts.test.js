const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSystemPrompt, detectEngagementSignal } = require("../lib/systemPrompts");

test("buildSystemPrompt: dispatches to the survey template by default", () => {
  const prompt = buildSystemPrompt({ survey_meta: { title: "X" } }, null, "survey", null, false);
  assert.match(prompt, /survey data analyst/i);
});

test("buildSystemPrompt: dispatches to the consultancy template when vertical is 'consultancy'", () => {
  const prompt = buildSystemPrompt({}, null, "consultancy", null, false);
  assert.match(prompt, /ELIGIBILITY BOUNDARY/);
  assert.doesNotMatch(prompt, /survey data analyst/i);
});

test("buildSystemPrompt: a masterPrompt overrides the vertical template entirely, but keeps the technical contract", () => {
  const prompt = buildSystemPrompt({ foo: "bar" }, null, "consultancy", "You are Bob, a friendly pirate.", false);
  assert.match(prompt, /You are Bob, a friendly pirate\./);
  // The required technical contract (anti-injection instruction + followups
  // block) must survive regardless of what the tenant's custom prompt says —
  // this is the platform's non-negotiable wiring underneath admin content.
  assert.match(prompt, /REQUIRED TECHNICAL CONTRACT/);
  assert.match(prompt, /"followups"/);
  assert.doesNotMatch(prompt, /ELIGIBILITY BOUNDARY/); // consultancy-specific content should NOT leak in
});

test("buildSystemPrompt: tenant isolation — two different payloads never leak into each other's prompt", () => {
  const tenantA = { survey_meta: { title: "Tenant A Survey" }, secretMarkerA: "AAA-only-visible-here" };
  const tenantB = { survey_meta: { title: "Tenant B Survey" }, secretMarkerB: "BBB-only-visible-here" };

  const promptA = buildSystemPrompt(tenantA, null, "survey", null, false);
  const promptB = buildSystemPrompt(tenantB, null, "survey", null, false);

  assert.match(promptA, /AAA-only-visible-here/);
  assert.doesNotMatch(promptA, /BBB-only-visible-here/);
  assert.match(promptB, /BBB-only-visible-here/);
  assert.doesNotMatch(promptB, /AAA-only-visible-here/);
});

test("buildSystemPrompt: useKbOnly=true excludes the full dataset dump from the prompt", () => {
  const bigPayload = { secretField: "this-should-not-appear-in-the-prompt-text", items: new Array(500).fill("x") };
  const prompt = buildSystemPrompt(bigPayload, null, "survey", null, true);
  assert.doesNotMatch(prompt, /this-should-not-appear-in-the-prompt-text/);
  assert.match(prompt, /NOT embedded above/);
});

test("buildSystemPrompt: useKbOnly=false (default) DOES embed the full dataset", () => {
  const payload = { markerField: "marker-should-appear-here" };
  const prompt = buildSystemPrompt(payload, null, "survey", null, false);
  assert.match(prompt, /marker-should-appear-here/);
});

test("buildSystemPrompt: persona text is included when provided", () => {
  const prompt = buildSystemPrompt({}, "Speak like a pirate, always say arr.", "survey", null, false);
  assert.match(prompt, /Speak like a pirate, always say arr\./);
});

test("detectEngagementSignal: false for a short, low-signal conversation", () => {
  const messages = [{ role: "user", content: "What documents do I need?" }];
  assert.equal(detectEngagementSignal(messages), false);
});

test("detectEngagementSignal: true once the user has sent 3+ messages, regardless of topic", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "what documents do I need" },
    { role: "assistant", content: "..." },
    { role: "user", content: "thanks" },
  ];
  assert.equal(detectEngagementSignal(messages), true);
});

test("detectEngagementSignal: true when a buying-signal topic is raised twice, even in a short conversation", () => {
  const messages = [
    { role: "user", content: "How much does the program cost?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "And what's the total fee including registration?" },
  ];
  assert.equal(detectEngagementSignal(messages), true);
});

test("detectEngagementSignal: false when a buying-signal topic is raised only once", () => {
  const messages = [{ role: "user", content: "How much does the program cost?" }];
  assert.equal(detectEngagementSignal(messages), false);
});

test("detectEngagementSignal: only counts user messages toward the 3-message threshold, not assistant replies", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello, how can I help" },
    { role: "assistant", content: "(a second assistant message, e.g. after a tool call)" },
  ];
  // Only 1 real user message — should NOT trigger despite 3 total messages.
  assert.equal(detectEngagementSignal(messages), false);
});
