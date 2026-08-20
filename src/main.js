import { app, powerMonitor } from 'electron';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './log.js';
import { openDb } from './db.js';
import { ForegroundTracker } from './foreground-tracker.js';
import { InputMonitor } from './input-monitor.js';
import { ScreenshotService } from './screenshot.js';
import { VisionService } from './vision.js';
import { inCaptureWindow, msUntilScheduledStop, scheduleOptions } from './schedule.js';

// Headless: no BrowserWindow, no frontend. Keep running without windows.
if (!app.requestSingleInstanceLock()) {
  console.error('work-recorder already running');
  app.quit();
}

app.dock?.hide(); // background agent, no dock icon

const { config, configFile } = loadConfig();
const dataDir = app.getPath('userData');
const log = createLogger(config.log, dataDir);
const db = openDb(path.join(dataDir, 'work-recorder.db'));

log.info(`work-recorder starting (config: ${configFile ?? 'defaults'})`);

let tracker, input, shots, vision;
let shuttingDown = false;
let stopTimer;

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

  tracker.start();
  shots.start();

  powerMonitor.on('suspend', () => {
    log.info('system suspend -> pausing capture');
    shots.stop();
    tracker.stop('suspend');
  });
  powerMonitor.on('resume', () => {
    log.info('system resume -> resuming capture');
    tracker.start();
    shots.start();
  });
}

let isShuttingDown = false;
async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`shutting down (${reason})`);
  try {
    shots?.stop();
    tracker?.stop(reason);
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
