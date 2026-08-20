// Guard against native helpers that hang instead of rejecting
// (observed: get-windows helper binary occasionally never exits).
export function withTimeout(promiseFactory, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve()
      .then(promiseFactory)
      .then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
  });
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getBeijingISOString(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : (typeof dateInput === 'number' || typeof dateInput === 'string' ? new Date(dateInput) : new Date());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return bj.toISOString().replace('Z', '+08:00');
}

export function getBeijingDateString(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : (typeof dateInput === 'number' || typeof dateInput === 'string' ? new Date(dateInput) : new Date());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return bj.toISOString().slice(0, 10);
}

export function getBeijingTimeString(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : (typeof dateInput === 'number' || typeof dateInput === 'string' ? new Date(dateInput) : new Date());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return bj.toISOString().slice(11, 16);
}

export function getBeijingLogTime(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : (typeof dateInput === 'number' || typeof dateInput === 'string' ? new Date(dateInput) : new Date());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  const iso = bj.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

/** UTC fields of the shifted Date are Beijing wall-clock. */
export function getBeijingParts(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : (typeof dateInput === 'number' || typeof dateInput === 'string' ? new Date(dateInput) : new Date());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return {
    weekday: bj.getUTCDay(), // 0 Sun … 6 Sat
    hours: bj.getUTCHours(),
    minutes: bj.getUTCMinutes(),
    seconds: bj.getUTCSeconds(),
    ms: bj.getUTCMilliseconds(),
  };
}

export function msUntilBeijingClock(stopHour, stopMinute = 0, dateInput = new Date()) {
  const p = getBeijingParts(dateInput);
  const elapsed = ((p.hours * 60 + p.minutes) * 60 + p.seconds) * 1000 + p.ms;
  const target = (stopHour * 60 + stopMinute) * 60 * 1000;
  return target - elapsed;
}

