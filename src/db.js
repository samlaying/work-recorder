import sqliteWasm from 'node-sqlite3-wasm';
const { Database } = sqliteWasm;
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getBeijingISOString } from './util.js';

// Schema mirrors the reverse-engineered app (app_usage_sessions_v2 / frame_dedup_logs),
// plus work_records and keyboard_heatmap for layers 1-2 of this clone.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracked_applications (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_usage_sessions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  activity_state TEXT NOT NULL CHECK (activity_state IN ('active', 'idle')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  active_duration_ms INTEGER,
  idle_duration_ms INTEGER,
  longest_active_duration_ms INTEGER,
  sample_count INTEGER DEFAULT 0,
  context_switch_count INTEGER DEFAULT 0,
  start_reason TEXT,
  end_reason TEXT,
  detection_source TEXT DEFAULT 'get-windows',
  confidence TEXT DEFAULT 'medium',
  is_open INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON app_usage_sessions_v2 (started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_app ON app_usage_sessions_v2 (application_id);

CREATE TABLE IF NOT EXISTS frame_dedup_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL,
  app_name TEXT,
  window_title TEXT,
  trigger_source TEXT,
  diff_ratio REAL,
  threshold REAL,
  decision TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS work_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('interval', 'enter', 'manual')),
  app_name TEXT,
  window_title TEXT,
  system_context TEXT,
  prompt TEXT NOT NULL,
  model TEXT,
  summary TEXT,
  raw_response TEXT,
  error TEXT,
  screenshot_path TEXT,
  latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_work_records_captured ON work_records (captured_at);

CREATE TABLE IF NOT EXISTS keyboard_heatmap (
  date TEXT NOT NULL,
  key_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, key_name)
);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db = new Database(dbPath);
  try {
    db.exec(SCHEMA);
  } catch (e) {
    // node-sqlite3-wasm's VFS cannot roll back its own hot journal after a
    // killed process: it reports "database is locked" forever. Let the system
    // sqlite3 validate/roll back; if it succeeds the journal is stale and can
    // be moved aside, after which the wasm handle opens normally.
    const journal = dbPath + '-journal';
    const lockDir = dbPath + '.lock';
    if (/locked/i.test(e.message) && (fs.existsSync(journal) || fs.existsSync(lockDir))) {
      try {
        db.close();
      } catch { /* already unusable */ }
      execFileSync(
        '/usr/bin/sqlite3',
        [dbPath, 'SELECT count(*) FROM sqlite_master;'],
        { timeout: 3000, stdio: 'pipe' }
      );
      if (fs.existsSync(journal)) fs.renameSync(journal, `${journal}.stale-${Date.now()}`);
      // the wasm VFS lock dir is also left in a bad state by SIGKILL
      if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
      db = new Database(dbPath);
      db.exec(SCHEMA);
    } else {
      throw e;
    }
  }
  // node-sqlite3-wasm only binds the FIRST vararg; make .run/.get/.all accept varargs
  // (single object/primitive passes through, multiple args get wrapped in an array).
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    for (const m of ['run', 'get', 'all']) {
      const fn = stmt[m].bind(stmt);
      stmt[m] = (...args) => fn(args.length <= 1 ? args[0] : args);
    }
    return stmt;
  };
  return db;
}

export function appIdFor(name) {
  // stable id from display name: 'app:' + hex(name)
  return 'app:' + Buffer.from(name.toLowerCase().trim(), 'utf8').toString('hex');
}

export function upsertApplication(db, displayName) {
  const now = getBeijingISOString();
  const id = appIdFor(displayName);
  db.prepare(
    `INSERT INTO tracked_applications (id, platform, stable_key, display_name, first_seen_at, last_seen_at)
     VALUES (?, 'darwin', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(id, 'name:' + displayName.toLowerCase().trim(), displayName, now, now);
  return id;
}
