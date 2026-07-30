/**
 * availability.js — generates candidate appointment slots from a tenant's
 * configured weekly business hours (tenant_meta.booking.availability).
 *
 * Deliberately NOT a real calendar sync — it doesn't know what's actually
 * booked, just what hours the business is generally open. That's the right
 * scope for now: once n8n is wired to a real calendar, swap this for a call
 * to an n8n endpoint that returns true free/busy, and nothing else in the
 * booking flow needs to change (it just consumes a list of {iso, label}
 * slots either way).
 */

const DEFAULT_AVAILABILITY = {
  timezone: "Asia/Karachi",
  daysOfWeek: [1, 2, 3, 4, 5], // 0=Sun..6=Sat
  startHour: 10,
  endHour: 18,
  slotMinutes: 30,
  daysAhead: 7,
  slotsToOffer: 3,
  leadTimeMinutes: 60, // don't offer a slot less than this far from now
};

function getAvailabilityConfig(tenant) {
  const raw = tenant?.bookingAvailability || {};
  return { ...DEFAULT_AVAILABILITY, ...raw };
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10) };
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function generateAvailableSlots(tenant) {
  const cfg = getAvailabilityConfig(tenant);
  const stepMs = cfg.slotMinutes * 60 * 1000;
  const now = Date.now();
  const horizon = now + cfg.daysAhead * 24 * 60 * 60 * 1000;

  let t = Math.ceil((now + cfg.leadTimeMinutes * 60 * 1000) / stepMs) * stepMs;
  const slots = [];

  const labelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  while (t <= horizon && slots.length < cfg.slotsToOffer) {
    const { weekday, hour } = getZonedParts(new Date(t), cfg.timezone);
    const dow = WEEKDAY_INDEX[weekday];
    if (cfg.daysOfWeek.includes(dow) && hour >= cfg.startHour && hour < cfg.endHour) {
      slots.push({ iso: new Date(t).toISOString(), label: labelFmt.format(new Date(t)) });
    }
    t += stepMs;
  }

  return slots;
}

module.exports = { generateAvailableSlots, getAvailabilityConfig, DEFAULT_AVAILABILITY };
