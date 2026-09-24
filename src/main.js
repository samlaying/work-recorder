import { app, powerMonitor } from 'electron';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './log.js';
import { openDb } from './db.js';
import { isSqliteBusy } from './db-retry.js';
import { recoverSqliteJournal } from './paths.js';
import { ForegroundTracker } from './foreground-tracker.js';
import { InputMonitor } from './input-monitor.js';
import { ScreenshotService } from './screenshot.js';
import { VisionService } from './vision.js';
import { BreakReminder } from './break-reminder.js';
import { inCaptureWindow, msUntilScheduledStop, scheduleOptions } from './schedule.js';

// Headless: no BrowserWindow, no frontend. Keep running without windows.
if (!app.requestSingleInstanceLock()) {
  console.error('work-recorder already running');
  app.quit();
}

app.dock?.hide();
if (process.platform === 'win32') {
  app.setAppUserModelId('local.work-recorder');
}

const { config, configFile } = loadConfig();
const dataDir = app.getPath('userData');
const log = createLogger(config.log, dataDir);
const dbPath = path.join(dataDir, 'work-recorder.db');

// Swappable db handle: services capture `db` at construction, so recovery
// swaps the underlying connection in place instead of restarting the process.
const dbRef = { handle: openDb(dbPath) };
const db = new Proxy({}, {
  get: (_, prop) => {
    const value = dbRef.handle[prop];
    return typeof value === 'function' ? value.bind(dbRef.handle) : value;
  },
});

log.info(`work-recorder starting (config: ${configFile ?? 'defaults'})`);

let tracker, input, shots, vision, reminder;
let isShuttingDown = false;
let stopTimer;
let dbWatchdog;

// Self-heal for wedged VFS locks: node-sqlite3-wasm reports "database is
// locked" forever once its .lock dir is left stale (process died mid-write),
// and openDb() only recovers at startup — a long-running collector used to
// stay broken for the rest of the day. Probe cheaply; after ~1min of
// consecutive lock errors, rebuild the connection.
function startDbWatchdog() {
  let busyStreak = 0;
  dbWatchdog = setInterval(() => {
    if (isShuttingDown) return;
    try {
      // Probe the WRITE path: a wedged connection still serves reads, so
      // SELECT 1 passes while every INSERT/UPDATE fails with SQLITE_BUSY.
      // BEGIN IMMEDIATE acquires the write lock without touching data.
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
      busyStreak = 0;
      return;
    } catch (e) {
      if (!isSqliteBusy(e)) return; // non-lock errors belong to the services
      busyStreak += 1;
      if (busyStreak < 5) return;
    }
    busyStreak = 0;
    try {
      log.warn('database locked for >1min — rebuilding connection');
      try { dbRef.handle.close(); } catch { /* already unusable */ }
      recoverSqliteJournal(dbPath);
      dbRef.handle = openDb(dbPath);
      log.info('database connection recovered');
    } catch (e) {
      log.error(`database recovery failed: ${e.message}`);
    }
  }, 15000);
}

function recentContext(lines = 3) {
  const rows = db
    .prepare(
      `SELECT captured_at, app_name, summary FROM work_records
       WHERE summary IS NOT NULL ORDER BY id DESC LIMIT ?`
    )
    .all(lines);
  return rows
    .map((r) => `- [${r.captured_at.slice(11, 16)}] ${r.app_name ?? ''}: ${r.summary}`)
    .join('\n');
}

function pruneOldRecords(retentionDays = 1) {
  try {
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() + BEIJING_OFFSET_MS - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r1 = db.prepare('DELETE FROM work_records WHERE substr(captured_at, 1, 10) < ?').run(cutoff);
    const r2 = db.prepare('DELETE FROM app_usage_sessions_v2 WHERE substr(started_at, 1, 10) < ?').run(cutoff);
    const r3 = db.prepare('DELETE FROM frame_dedup_logs WHERE substr(captured_at, 1, 10) < ?').run(cutoff);
    const r4 = db.prepare('DELETE FROM keyboard_heatmap WHERE date < ?').run(cutoff);
    const totalDeleted = (r1.changes || 0) + (r2.changes || 0) + (r3.changes || 0) + (r4.changes || 0);
    if (totalDeleted > 0) {
      log.info(`auto-prune: cleaned ${totalDeleted} records older than ${cutoff}`);
    }
  } catch (e) {
    log.warn(`auto-prune failed: ${e.message}`);
  }
}

function armScheduledStop() {
  const opts = scheduleOptions(config);
  if (!opts.enabled) return;
  clearTimeout(stopTimer);
  if (!inCaptureWindow(config)) {
    shutdown('schedule-window');
    return;
  }
  const ms = msUntilScheduledStop(config);
  log.info(`scheduled stop in ${Math.round(ms / 60000)}m (Beijing ${String(opts.stopHour).padStart(2, '0')}:${String(opts.stopMinute).padStart(2, '0')})`);
  stopTimer = setTimeout(() => shutdown('schedule-stop'), ms);
}

function boot() {
  if (scheduleOptions(config).enabled && !inCaptureWindow(config)) {
    log.info('outside weekday capture window — exiting');
    shutdown('schedule-window');
    return;
  }
  pruneOldRecords(config.retentionDays ?? 1);
  // 定时每小时检查并清理一次过期旧数据（一天一清）
  setInterval(() => pruneOldRecords(config.retentionDays ?? 1), 3600 * 1000);

  input = new InputMonitor({ log, keyboardHeatmap: config.keyboardHeatmap });
  try {
    input.start();
  } catch {
    log.warn('continuing WITHOUT keyboard channel (no idle detection / enter trigger / heatmap)');
  }
  input.attachDb(db);

  tracker = new ForegroundTracker({
    db,
    log,
    inputMonitor: input,
    pollIntervalMs: config.pollIntervalMs,
    idleThresholdMs: config.idleThresholdMs,
  });

  vision = new VisionService({ db, log, config, dataDir });
  if (!vision.enabled()) log.warn('vision disabled or apiKey unset — screenshots will be dedup-logged only');

  shots = new ScreenshotService({ db, log, inputMonitor: input, config, dataDir });
  shots.onCapture = ({ pngBuf, appName, title, source }) => {
    if (!vision.enabled()) return;
    vision.enqueue({
      pngBuf,
      appName,
      title,
      source,
      systemContext: recentContext(config.vision.contextLines ?? 3),
    });
  };
  input.on('enter', () => shots.onEnterTrigger());

  if (config.reminder?.enabled) {
    if (input.running) {
      reminder = new BreakReminder({
        db,
        log,
        inputMonitor: input,
        config: { ...config.reminder, idleThresholdMs: config.idleThresholdMs },
      });
      reminder.start();
    } else {
      // Wall-clock fallback would fire "focus" cycles at night with no input
      // signal — the reminder is meaningless without real activity data.
      log.warn('break-reminder off: keyboard channel unavailable (accessibility not granted)');
    }
  }

  tracker.start();
  shots.start();
  armScheduledStop();
  startDbWatchdog();

  powerMonitor.on('suspend', () => {
    log.info('system suspend -> pausing capture');
    shots.stop();
    tracker.stop('suspend');
    reminder?.stop('suspend');
  });
  powerMonitor.on('resume', () => {
    if (scheduleOptions(config).enabled && !inCaptureWindow(config)) {
      log.info('system resume outside capture window -> stopping');
      shutdown('schedule-window');
      return;
    }
    log.info('system resume -> resuming capture');
    reminder?.start();
    tracker.start();
    shots.start();
    armScheduledStop();
  });
}

async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearTimeout(stopTimer);
  clearInterval(dbWatchdog);
  log.info(`shutting down (${reason})`);
  try {
    shots?.stop();
    tracker?.stop(reason);
    reminder?.stop(reason);
    input?.stop();
    await new Promise((r) => setTimeout(r, 150));
    db?.close();
  } catch (e) {
    log.error(`shutdown: ${e.message}`);
  }
  app.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
app.on('before-quit', () => shutdown('before-quit'));
app.on('window-all-closed', (e) => e.preventDefault()); // stay alive headlessly

app.whenReady().then(boot).catch((e) => {
  log.error(`fatal: ${e.stack}`);
  app.exit(1);
});
