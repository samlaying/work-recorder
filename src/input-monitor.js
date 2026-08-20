import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { getBeijingDateString, getBeijingISOString } from './util.js';

/**
 * Global input monitor (channel 2, via uiohook-napi / libuiohook).
 * Provides:
 *  - lastActivityAt          -> idle detection feeding the foreground tracker
 *  - 'enter' events          -> enter-key screenshot trigger ("just finished something")
 *  - per-key counters        -> keyboard heatmap (counts only, never content)
 *
 * macOS: requires Accessibility permission
 * (System Settings -> Privacy & Security -> Accessibility).
 */

const NAMED_KEYS = new Map(
  Object.entries(UiohookKey).map(([name, code]) => [code, name])
);

export class InputMonitor extends EventEmitter {
  constructor({ log, keyboardHeatmap }) {
    super();
    this.log = log;
    this.heatCfg = keyboardHeatmap;
    this.lastActivityAt = Date.now();

    this.keyCounts = new Map(); // `${date}|${keyName}` -> count
    this.running = false;
    this.flushTimer = null;
  }

  start() {
    if (this.running) return;
    try {
      uIOhook.on('input', this.#onInput);
      uIOhook.start();
    } catch (e) {
      this.log.error(
        `uiohook start failed (Accessibility permission?): ${e.message}`
      );
      throw e;
    }
    this.running = true;
    if (this.heatCfg?.enabled) {
      this.flushTimer = setInterval(
        () => this.flushHeatmap(),
        (this.heatCfg.flushIntervalSeconds ?? 300) * 1000
      );
    }
    this.log.info('input-monitor started (uiohook-napi)');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    try {
      uIOhook.removeAllListeners();
      uIOhook.stop();
    } catch {
      /* already stopped */
    }
    if (this.flushTimer) clearInterval(this.flushTimer), (this.flushTimer = null);
    try {
      this.flushHeatmap();
    } catch {
      /* ignore flush error during shutdown */
    }
    this.log.info('input-monitor stopped');
  }

  #onInput = (e) => {
    if (!this.running) return;
    this.lastActivityAt = Date.now();
    if (e.type === 'keyDown') {
      const name = NAMED_KEYS.get(e.keycode) ?? `key_${e.keycode}`;
      this.#bump(name);
      if (e.keycode === UiohookKey.Enter) {
        this.emit('enter', { at: this.lastActivityAt });
      }
    }
  };

  #bump(name) {
    if (!this.heatCfg?.enabled) return;
    const date = getBeijingDateString();
    const k = `${date}|${name}`;
    this.keyCounts.set(k, (this.keyCounts.get(k) ?? 0) + 1);
  }

  flushHeatmap(db) {
    const target = db ?? this.db;
    if (!target || this.keyCounts.size === 0) return;
    const now = getBeijingISOString();
    const stmt = target.prepare(
      `INSERT INTO keyboard_heatmap (date, key_name, count, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(date, key_name) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`
    );
    target.exec('BEGIN');
    try {
      for (const [k, n] of this.keyCounts) {
        const [date, name] = k.split('|');
        stmt.run(date, name, n, now);
      }
      target.exec('COMMIT');
    } catch (e) {
      target.exec('ROLLBACK');
      throw e;
    }
    this.keyCounts.clear();
  }

  attachDb(db) {
    this.db = db;
  }
}
