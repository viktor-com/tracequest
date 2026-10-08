import { sessionMtimeMs } from "../sessions/session-list.js";

const DURATION_UNITS_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function localDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDayHour(date, hour) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0);
}

function previousLocalWeekday(date) {
  let candidate = addLocalDays(localDayStart(date), -1);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate = addLocalDays(candidate, -1);
  }
  return candidate;
}

function localDayHourFromDay(day, hour) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
}

function parseDateOnly(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

export function parseStandupSince(value, { now = new Date() } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("--since requires a date/time or duration like 2h, 1d, or 2026-06-27.");

  const duration = /^(\d+(?:\.\d+)?)([mhdw])$/i.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid --since duration: ${value}`);
    }
    return new Date(new Date(now).getTime() - amount * DURATION_UNITS_MS[duration[2].toLowerCase()]);
  }

  const dateOnly = parseDateOnly(text);
  if (dateOnly) return dateOnly;

  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)
    ? text.replace(/\s+/, "T")
    : text;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --since value: ${value}\nUse a duration like 2h/1d or a date/time like 2026-06-27 or 2026-06-27T09:00.`);
  }
  return parsed;
}

export function resolveStandupSelectionWindow(values = {}, { now = new Date() } = {}) {
  const hasSince = values.since != null && String(values.since).trim() !== "";
  const hasToday = Boolean(values.today);
  const hasYesterday = Boolean(values.yesterday);
  const hasWorkday = Boolean(values.workday);
  const hasPreviousWorkday = Boolean(values["previous-workday"] || values.previousWorkday);
  const count = [hasSince, hasToday, hasYesterday, hasWorkday, hasPreviousWorkday].filter(Boolean).length;
  if (count > 1) {
    throw new Error("Choose only one standup selection window: --since, --today, --yesterday, --workday, or --previous-workday.");
  }

  const reference = new Date(now);
  if (Number.isNaN(reference.getTime())) {
    throw new Error("Invalid standup selection reference time.");
  }

  if (hasSince) {
    const since = parseStandupSince(values.since, { now: reference });
    return {
      since,
      before: null,
      label: `since ${String(values.since).trim()}`,
    };
  }

  if (hasToday) {
    return {
      since: localDayStart(reference),
      before: null,
      label: "today",
    };
  }

  if (hasYesterday) {
    const today = localDayStart(reference);
    return {
      since: addLocalDays(today, -1),
      before: today,
      label: "yesterday",
    };
  }

  if (hasWorkday) {
    return {
      since: localDayHour(reference, 9),
      before: localDayHour(reference, 17),
      label: "workday (09:00-17:00 local)",
    };
  }

  if (hasPreviousWorkday) {
    const day = previousLocalWeekday(reference);
    return {
      since: localDayHourFromDay(day, 9),
      before: localDayHourFromDay(day, 17),
      label: "previous workday (09:00-17:00 local)",
    };
  }

  return null;
}

export function applyStandupSelectionWindow(sessions, window) {
  if (!window) return [...(sessions || [])];
  const sinceMs = window.since ? window.since.getTime() : -Infinity;
  const beforeMs = window.before ? window.before.getTime() : Infinity;
  return [...(sessions || [])].filter((session) => {
    const mtime = sessionMtimeMs(session);
    return mtime >= sinceMs && mtime < beforeMs;
  });
}
