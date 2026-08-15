import { app, powerMonitor } from 'electron';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './log.js';
import { openDb } from './db.js';
import { ForegroundTracker } from './foreground-tracker.js';
import { InputMonitor } from './input-monitor.js';
import { ScreenshotService } from './screenshot.js';
import { VisionService } from './vision.js';

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

function boot() {
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

function shutdown(reason) {
  log.info(`shutting down (${reason})`);
  try {
    shots?.stop();
    tracker?.stop(reason);
    input?.stop(); // flushes heatmap
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
