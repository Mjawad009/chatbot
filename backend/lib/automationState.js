/**
 * automationState.js — the session state machine ANY automation uses:
 * built-in ones (booking, escalation) and admin-configured n8n/API ones
 * alike. This used to be booking-specific (booking.js); generalizing it
 * is what lets a tenant define a brand new automation from the admin
 * panel and get the exact same reliable one-field-at-a-time collection
 * + confirmation flow booking already had, with zero new state-machine
 * code per automation.
 *
 * Two phases:
 *  1. "collecting" — ask for missing required fields ONE AT A TIME.
 *  2. "confirming" — show a summary, wait for confirmation (or a
 *     correction) before actually executing the automation.
 *
 * Keyed by `automation:{automationId}:{sessionId}` — a session can only
 * be mid-flow on ONE automation at a time (starting a new one implicitly
 * abandons an incomplete one, same as it always could with booking).
 *
 * Backed by lib/kv.js: Redis-shared-across-instances if REDIS_URL is set,
 * in-memory (single instance, wiped on restart) otherwise.
 */
const { kvGet, kvSet, kvDelete } = require("./kv");

const TTL_SECONDS = 30 * 60; // 30 minutes

function key(automationId, sessionId) {
  return `automation:${automationId}:${sessionId}`;
}

async function startCollecting(automationId, sessionId, tenantId, collected, remainingKeys) {
  const currentKey = remainingKeys[0];
  await kvSet(
    key(automationId, sessionId),
    { automationId, state: "collecting", tenantId, collected, remainingKeys: remainingKeys.slice(1), currentKey },
    TTL_SECONDS
  );
  return currentKey;
}

async function startConfirming(automationId, sessionId, tenantId, collected) {
  await kvSet(key(automationId, sessionId), { automationId, state: "confirming", tenantId, collected }, TTL_SECONDS);
}

async function getState(automationId, sessionId) {
  return kvGet(key(automationId, sessionId));
}

async function isCollecting(automationId, sessionId) {
  const entry = await getState(automationId, sessionId);
  return Boolean(entry && entry.state === "collecting");
}

async function isConfirming(automationId, sessionId) {
  const entry = await getState(automationId, sessionId);
  return Boolean(entry && entry.state === "confirming");
}

async function recordAnswerAndAdvance(automationId, sessionId, value) {
  const entry = await getState(automationId, sessionId);
  if (!entry || entry.state !== "collecting") return null;
  const collected = { ...entry.collected, [entry.currentKey]: value };
  if (entry.remainingKeys.length === 0) {
    await startConfirming(automationId, sessionId, entry.tenantId, collected);
    return { done: true, collected };
  }
  const nextKey = await startCollecting(automationId, sessionId, entry.tenantId, collected, entry.remainingKeys);
  return { done: false, nextKey, collected };
}

async function clear(automationId, sessionId) {
  await kvDelete(key(automationId, sessionId));
}

// A session can only be mid-flow on one automation — this finds it WITHOUT
// the caller needing to already know which automationId to check. Backed
// by a small pointer key so we don't have to scan every automation on
// every message (cheap even with many automations configured).
async function getActivePointer(sessionId) {
  return kvGet(`automation-active:${sessionId}`);
}
async function setActivePointer(sessionId, automationId) {
  await kvSet(`automation-active:${sessionId}`, automationId, TTL_SECONDS);
}
async function clearActivePointer(sessionId) {
  await kvDelete(`automation-active:${sessionId}`);
}

module.exports = {
  startCollecting,
  startConfirming,
  getState,
  isCollecting,
  isConfirming,
  recordAnswerAndAdvance,
  clear,
  getActivePointer,
  setActivePointer,
  clearActivePointer,
};
