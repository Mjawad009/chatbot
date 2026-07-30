/**
 * automationExecutor.js — everything that happens once an automation has
 * either finished collecting its fields or needs none. Two execution
 * paths:
 *
 *  - type "internal": booking/escalation's existing behavior — log a lead,
 *    dispatch to the tenant's configured notifiers (email/WhatsApp/
 *    webhook). No HTTP call to an external system.
 *  - type "n8n" / "api": POST the collected fields to the configured
 *    endpoint, wait for a response, and render the tenant's configured
 *    success/error templates using whatever the endpoint returned. This
 *    is the genuinely new capability — any business workflow n8n (or any
 *    HTTP API) can expose becomes a chatbot automation with zero backend
 *    code, just admin panel configuration.
 *
 * Question/confirmation text generation is automation-agnostic on purpose
 * — it was booking-specific wording before; now any automation (built-in
 * or admin-defined) gets the same one-field-at-a-time + confirm flow with
 * generic phrasing.
 */
const { generateAvailableSlots } = require("./availability");

function fieldQuestionText(field, isFirst) {
  const labelLower = field.label.charAt(0).toLowerCase() + field.label.slice(1);
  return isFirst ? `Happy to help with that — first, what's your ${labelLower}?` : `Thanks! And what's your ${labelLower}?`;
}

function looksLikeTimeField(field) {
  return /time|date|schedule|slot|appointment/i.test(field.key) || /time|date|schedule|slot|appointment/i.test(field.label);
}

function confirmationSummary(fields, collected) {
  const lines = fields.map((f) => `- ${f.label}: ${collected[f.key] || "(not provided)"}`).join("\n");
  return `Let me confirm what I have:\n${lines}\n\nIs this all correct?`;
}

function renderTemplate(template, context) {
  if (!template) return null;
  const rendered = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = context[k];
    return v === undefined || v === null ? "" : String(v);
  });
  return rendered.trim() || null;
}

function defaultSuccessMessage(data) {
  if (data && typeof data === "object" && Object.keys(data).length) {
    return "Done — " + Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(", ");
  }
  return "Done — that's been taken care of.";
}

const DEFAULT_ERROR_MESSAGE = "Sorry, I couldn't complete that right now — please try again shortly or contact our team directly.";

async function executeHttpAutomation(automation, { tenantId, sessionId, collected }) {
  if (!automation.endpoint) {
    return { success: false, message: renderTemplate(automation.errorTemplate, collected) || "This automation isn't fully configured yet — please let the site owner know." };
  }

  const timeoutMs = Number(automation.config?.timeoutMs) || 15_000;
  const retries = 1; // one retry on transient failure, matches the pattern used for KB Service / notifiers
  const payload = { automationId: automation.id, tenantId, sessionId, ...collected };

  let lastErrContext = {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(automation.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...automation.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON response — templates just won't have anything to interpolate beyond `collected`
      }

      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        return { success: false, message: renderTemplate(automation.errorTemplate, { ...collected, ...(data || {}) }) || DEFAULT_ERROR_MESSAGE };
      }

      const context = { ...collected, ...(data || {}) };
      return { success: true, message: renderTemplate(automation.successTemplate, context) || defaultSuccessMessage(data) };
    } catch (err) {
      lastErrContext = { ...collected, error: err.name === "TimeoutError" ? "timeout" : err.message };
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      console.error(`❌ Automation "${automation.id}" HTTP call failed:`, err.message);
    }
  }
  return { success: false, message: renderTemplate(automation.errorTemplate, lastErrContext) || DEFAULT_ERROR_MESSAGE };
}

// logLead/logExecution are passed in rather than imported — keeps this
// module decoupled from server.js's log-file/notifier wiring, matching how
// the rest of the codebase avoids circular requires.
async function executeAutomation(automation, { tenant, tenantId, sessionId, collected, logLead, logExecution }) {
  let result;

  if (automation.type === "internal") {
    const message =
      automation.id === "escalation"
        ? "Thanks — I've passed this to our team. Someone will follow up with you shortly."
        : "Great, that's confirmed — I've passed this to our team and they'll follow up with you shortly. Is there anything else you'd like to know?";
    result = { success: true, message };
  } else {
    result = await executeHttpAutomation(automation, { tenantId, sessionId, collected });
  }

  // Every execution gets logged for analytics/audit, regardless of type or
  // whether it's lead-worthy — this used to not happen at all for n8n/API
  // automations (Visa Status, Order Tracking, etc. left no record anywhere).
  if (logExecution) {
    logExecution({ sessionId, tenantId, automationId: automation.id, type: automation.type, success: result.success, ...collected });
  }

  // Lead notifications (email/WhatsApp/webhook) are now an EXPLICIT
  // per-automation choice, not implicitly tied to type — a routine status
  // check isn't a sales lead unless the admin says it is.
  if (automation.notifyOnExecution && logLead) {
    logLead({ sessionId, tenantId, type: automation.id, ...collected, _structured: true }, tenant);
  }

  return result;
}

module.exports = {
  fieldQuestionText,
  looksLikeTimeField,
  confirmationSummary,
  renderTemplate,
  executeAutomation,
  generateAvailableSlots, // re-exported for convenience — server.js already imports it separately too
};
