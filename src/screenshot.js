import { desktopCapturer } from 'electron';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { withTimeout, getBeijingISOString } from './util.js';
import { activeWindowQuery } from './foreground-query.js';

/**
 * Automatic screenshot channel (channel 3).
 *
 * Anti-waste / anti-risk-control engineering (as in the original app):
 *  - minimum interval (>= 2 min by default)
 *  - pause while user is idle (mouse untouched)
 *  - app exclusion list (skip when e.g. a password manager / IM is frontmost),
 *    with a not-excluded override list taking precedence
 *  - frame dedup: near-identical consecutive frames skip recognition
 *    (pixelmatch diff ratio vs threshold; decisions logged to frame_dedup_logs,
 *     only the ratio/verdict is kept, never the image)
 */

const CAPTURE_WIDTH = 1600; // vision-friendly width; Electron scales height by aspect

export class ScreenshotService {
  constructor({ db, log, inputMonitor, config, dataDir }) {
    this.db = db;
    this.log = log;
    this.inputMonitor = inputMonitor;
    this.cfg = config.screenshot;
    this.visionCfg = config.vision;
    this.dataDir = dataDir;

    this.timer = null;
    this.prevPng = null; // previous decoded frame for dedup
    this.lastCaptureAt = 0;
    this.lastEnterCaptureAt = 0;
    this.busy = false;
    this.onCapture = null; // async ({png, appName, title, source}) => {}
  }

  start() {
    if (!this.cfg.enabled) {
      this.log.info('screenshot channel disabled by config');
      return;
    }
    const interval = Math.max(this.cfg.minIntervalSeconds ?? 120, this.cfg.intervalSeconds ?? 120);
    this.timer = setInterval(
      () => this.#intervalTick().catch((e) => this.log.error(`capture: ${e.message}`)),
      interval * 1000
    );
    this.log.info(`screenshot service started (interval=${interval}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer), (this.timer = null);
    this.log.info('screenshot service stopped');
  }

  /** Called by main when the input monitor fires a global Enter keydown. */
  onEnterTrigger() {
    if (!this.cfg.enabled || !this.cfg.enterKeyTrigger) return;
    const now = Date.now();
    if (now - this.lastEnterCaptureAt < (this.cfg.enterKeyDebounceMs ?? 30000)) return;
    this.lastEnterCaptureAt = now;
    this.#capture('enter').catch((e) => this.log.error(`enter-capture: ${e.message}`));
  }

  async #intervalTick() {
    const now = Date.now();
    const minMs = (this.cfg.minIntervalSeconds ?? 120) * 1000;
    if (now - this.lastCaptureAt < minMs) return;
    if (this.cfg.pauseOnIdle && this.inputMonitor) {
      const idleFor = now - (this.inputMonitor.lastActivityAt ?? 0);
      if (idleFor > (this.cfg.pauseOnIdleIdleMs ?? 120000)) {
        this.log.debug('skip capture: user idle');
        return;
      }
    }
    await this.#capture('interval');
  }

  #excluded(appName, title) {
    const norm = (s) => (s ?? '').toLowerCase();
    const app = norm(appName), t = norm(title);
    const notExcl = (this.cfg.notExcludedApps ?? []).some(
      (x) => app.includes(norm(x)) || t.includes(norm(x))
    );
    if (notExcl) return false;
    return (this.cfg.excludedApps ?? []).some(
      (x) => app.includes(norm(x)) || t.includes(norm(x))
    );
  }

  async #capture(source) {
    if (this.busy || !this.onCapture) return;
    this.busy = true;
    try {
      let fg = { appName: null, title: null };
      try {
        const w = await activeWindowQuery(2000);
        if (w) fg = { appName: w.owner?.name ?? null, title: w.title ?? null };
      } catch { /* foreground read is best-effort */ }

      if (fg.appName && this.#excluded(fg.appName, fg.title)) {
        this.#logDedup(fg, source, null, null, 'skip-excluded-app', 'excluded app frontmost');
        return;
      }

      const sources = await withTimeout(
        () =>
          desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: CAPTURE_WIDTH, height: Math.round((CAPTURE_WIDTH * 9) / 16) },
          }),
        15000,
        'desktopCapturer.getSources'
      );
      const primary = sources[0];
      if (!primary || primary.thumbnail.isEmpty()) {
        this.log.warn(
          process.platform === 'win32'
            ? 'no screen source (Windows may block screen capture for this Electron)'
            : 'no screen source (Screen Recording permission?)'
        );
        return;
      }

      const pngBuf = primary.thumbnail.toPNG();
      this.lastCaptureAt = Date.now();

      // frame dedup
      if (this.cfg.dedupEnabled) {
        const decision = this.#dedupDecision(pngBuf);
        if (decision.duplicate) {
          this.#logDedup(fg, source, decision.ratio, this.cfg.dedupThreshold, 'skip-duplicate-frame',
            `diff=${(decision.ratio * 100).toFixed(2)}% < threshold`);
          return;
        }
        this.#logDedup(fg, source, decision.ratio, this.cfg.dedupThreshold, 'recognized', '');
      }

      await Promise.race([
        this.onCapture({ pngBuf, ...fg, source }),
        new Promise((r) => setTimeout(r, 20000)),
      ]);
    } finally {
      this.busy = false;
    }
  }

  #dedupDecision(pngBuf) {
    try {
      const cur = PNG.sync.read(pngBuf);
      const prev = this.prevPng;
      this.prevPng = cur;
      if (!prev || prev.width !== cur.width || prev.height !== cur.height) {
        return { duplicate: false, ratio: null };
      }
      const diff = pixelmatch(prev.data, cur.data, null, cur.width, cur.height, {
        threshold: 0.12,
        includeAA: false,
      });
      const ratio = diff / (cur.width * cur.height);
      return { duplicate: ratio < (this.cfg.dedupThreshold ?? 0.02), ratio };
    } catch (e) {
      this.log.warn(`dedup decode failed (${e.message}); treating as new frame`);
      return { duplicate: false, ratio: null };
    }
  }

  #logDedup(fg, source, ratio, threshold, decision, detail) {
    this.db
      .prepare(
        `INSERT INTO frame_dedup_logs (captured_at, app_name, window_title, trigger_source,
         diff_ratio, threshold, decision, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        getBeijingISOString(),
        fg.appName,
        fg.title,
        source,
        ratio,
        threshold,
        decision,
        detail
      );
  }
}
