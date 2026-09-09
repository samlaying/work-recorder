#!/usr/bin/env node
// Offline daily summary — reads the local SQLite directly, no Electron needed.
// Usage: npm run report [-- 2026-08-14]
import sqliteWasm from 'node-sqlite3-wasm';
const { Database } = sqliteWasm;
import fs from 'node:fs';
import path from 'node:path';
import { workRecorderDataDir, recoverSqliteJournal } from '../src/paths.js';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const getBeijingDate = (d = new Date()) => {
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return bj.toISOString().slice(0, 10);
};
const formatBeijingTime = (str) => {
  if (!str) return '--:--';
  if (str.endsWith('Z')) {
    const d = new Date(str);
    const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
    return bj.toISOString().slice(11, 16);
  }
  return str.slice(11, 16);
};

const date = process.argv[2] ?? getBeijingDate();
const dbPath = path.join(workRecorderDataDir(), 'work-recorder.db');
// open read-write so SQLite can roll back any hot journal left by a killed run;
// a readOnly handle would fail with "database is locked" instead.
let db;
try {
  db = new Database(dbPath);
  db.prepare('SELECT 1').all();
} catch (e) {
  // stale hot journal / stale lock dir from a killed run:
  // validate via system sqlite3, move aside, retry
  const journal = dbPath + '-journal';
  const lockDir = dbPath + '.lock';
  if (/locked/i.test(e.message) && (fs.existsSync(journal) || fs.existsSync(lockDir))) {
    recoverSqliteJournal(dbPath);
    db = new Database(dbPath);
  } else {
    throw e;
  }
}

const pad = (ms) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

const sessions = db
  .prepare(
    `SELECT app_name, activity_state,
            SUM(COALESCE(active_duration_ms, 0)) AS active_ms,
            SUM(COALESCE(idle_duration_ms, 0)) AS idle_ms,
            COUNT(*) AS session_count,
            SUM(COALESCE(context_switch_count, 0)) AS switches
     FROM app_usage_sessions_v2
     WHERE (started_at LIKE '%Z' AND date(started_at, '+8 hours') = ?)
        OR (started_at NOT LIKE '%Z' AND substr(started_at, 1, 10) = ?)
     GROUP BY app_name, activity_state
     ORDER BY active_ms + idle_ms DESC`
  )
  .all([date, date]);

console.log(`\n== 工作时间线 ${date} (北京时间) ==`);
console.log('应用                状态    总时长   活跃     会话  切换');
for (const s of sessions) {
  console.log(
    `${s.app_name.slice(0, 18).padEnd(19)}${s.activity_state.padEnd(8)}` +
      `${pad(s.active_ms + s.idle_ms).padEnd(9)}${pad(s.active_ms).padEnd(9)}` +
      `${String(s.session_count).padEnd(6)}${s.switches}`
  );
}

const records = db
  .prepare(
    `SELECT captured_at, source, app_name, summary, error FROM work_records
     WHERE (captured_at LIKE '%Z' AND date(captured_at, '+8 hours') = ?)
        OR (captured_at NOT LIKE '%Z' AND substr(captured_at, 1, 10) = ?)
     ORDER BY id`
  )
  .all([date, date]);

console.log(`\n== 工作记录 (${records.length}) ==`);
for (const r of records) {
  const time = formatBeijingTime(r.captured_at);
  if (r.error) console.log(`${time} [${r.source}] ERROR: ${r.error}`);
  else console.log(`${time} [${r.source}] ${r.app_name ?? ''} — ${r.summary}`);
}

const dedup = db
  .prepare(
    `SELECT decision, COUNT(*) AS n FROM frame_dedup_logs
     WHERE (captured_at LIKE '%Z' AND date(captured_at, '+8 hours') = ?)
        OR (captured_at NOT LIKE '%Z' AND substr(captured_at, 1, 10) = ?)
     GROUP BY decision`
  )
  .all([date, date]);
console.log(`\n== 截图去重判定 ==`);
for (const d of dedup) console.log(`${d.decision}: ${d.n}`);

