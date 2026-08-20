import { getBeijingParts, msUntilBeijingClock } from './util.js';

export function scheduleOptions(config) {
  const s = config?.schedule ?? {};
  return {
    enabled: s.enabled !== false,
    weekdaysOnly: s.weekdaysOnly !== false,
    stopHour: Number.isFinite(s.stopHour) ? s.stopHour : 20,
    stopMinute: Number.isFinite(s.stopMinute) ? s.stopMinute : 0,
  };
}

export function inCaptureWindow(config, dateInput = new Date()) {
  const { enabled, weekdaysOnly, stopHour, stopMinute } = scheduleOptions(config);
  if (!enabled) return true;
  const p = getBeijingParts(dateInput);
  if (weekdaysOnly && (p.weekday === 0 || p.weekday === 6)) return false;
  const mins = p.hours * 60 + p.minutes;
  return mins < stopHour * 60 + stopMinute;
}

export function msUntilScheduledStop(config, dateInput = new Date()) {
  const { stopHour, stopMinute } = scheduleOptions(config);
  const ms = msUntilBeijingClock(stopHour, stopMinute, dateInput);
  return ms > 0 ? ms : 0;
}
