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

