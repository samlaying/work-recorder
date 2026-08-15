import { activeWindowQuery } from './foreground-query.js';
import { upsertApplication } from './db.js';
import { getBeijingISOString } from './util.js';

/**
 * Foreground app tracker (channel 1).
 * Polls the active window every pollIntervalMs, and maintains app usage sessions
 * with active/idle state splitting — not naive time bookkeeping:
 *
 *  - a session = contiguous period with the SAME app AND the SAME activity state
 *  - activity state derives from last global input event (uiohook) vs idleThresholdMs
 *  - context_switch_count counts app changes observed while the session was open
 */

export class ForegroundTracker {
  constructor({ db, log, inputMonitor, pollIntervalMs, idleThresholdMs }) {
    this.db = db;
    this.log = log;
    this.inputMonitor = inputMonitor;
    this.pollIntervalMs = pollIntervalMs;
    this.idleThresholdMs = idleThresholdMs;

    this.timer = null;
    this.session = null; // { rowId, appId, appName, state, startedAt, lastSampleAt, activeMs, idleMs, longestActiveMs, samples, switches }
    this.lastAppName = null;
    this.onAppChange = null; // optional callback(appName, title)
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#poll().catch((e) => this.log.error(`poll: ${e.message}`)), this.pollIntervalMs);
    this.log.info(`foreground-tracker started (poll=${this.pollIntervalMs}ms idle=${this.idleThresholdMs}ms)`);
  }

  stop(reason = 'shutdown') {
    if (this.timer) clearInterval(this.timer), (this.timer = null);
    this.#closeSession(reason);
    this.log.info('foreground-tracker stopped');
  }

  activityState() {
    const last = this.inputMonitor?.lastActivityAt ?? 0;
    return Date.now() - last < this.idleThresholdMs ? 'active' : 'idle';
  }

  async #poll() {
    const win = await activeWindowQuery(2000);
    if (!win) return;

    const appName = win.owner?.name || win.owner?.path || 'Unknown';
    const title = win.title || '';
    const state = this.activityState();

    if (appName !== this.lastAppName) {
      this.log.info(`foreground: ${appName} — ${title.slice(0, 80)}`);
      this.lastAppName = appName;
      this.onAppChange?.(appName, title);
    }

    const now = Date.now();
    const sameApp = this.session && this.session.appName === appName;
    const sameState = this.session && this.session.state === state;

    if (!sameApp) {
      // app switch closes the open session (if any), counting the switch
      this.#closeSession('app-switch');
      this.#openSession(appName, state, now, 'new-foreground-app');
    } else if (!sameState) {
      this.#closeSession(`state-${state}`);
      this.#openSession(appName, state, now, `activity-state-${state}`);
    } else {
      this.#accumulate(now, appName);
    }
  }

  #openSession(appName, state, now, reason) {
    const appId = upsertApplication(this.db, appName);
    const iso = getBeijingISOString(now);
    const res = this.db
      .prepare(
        `INSERT INTO app_usage_sessions_v2
         (application_id, app_name, activity_state, started_at, is_open, start_reason,
          detection_source, confidence, sample_count, context_switch_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 'get-windows', 'medium', 0, 0, ?, ?)`
      )
      .run(appId, appName, state, iso, reason, iso, iso);

    this.session = {
      rowId: Number(res.lastInsertRowid),
      appId,
      appName,
      state,
      startedAt: now,
      lastSampleAt: now,
      activeMs: 0,
      idleMs: 0,
      longestActiveMs: 0,
      samples: 0,
      switches: 0,
    };
  }

  #accumulate(now, currentApp) {
    const s = this.session;
    if (!s) return;
    const delta = now - s.lastSampleAt;
    if (s.state === 'active') {
      s.activeMs += delta;
      s.longestActiveMs = Math.max(s.longestActiveMs, delta);
    } else {
      s.idleMs += delta;
    }
    if (currentApp !== s.appName) s.switches += 1; // defensive; shouldn't happen while sameApp
    s.samples += 1;
    s.lastSampleAt = now;

    const iso = getBeijingISOString(now);
    this.db
      .prepare(
        `UPDATE app_usage_sessions_v2 SET ended_at = ?, duration_ms = ?, active_duration_ms = ?,
         idle_duration_ms = ?, longest_active_duration_ms = ?, sample_count = ?,
         context_switch_count = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        iso,
        now - s.startedAt,
        s.activeMs,
        s.idleMs,
        s.longestActiveMs,
        s.samples,
        s.switches,
        iso,
        s.rowId
      );
  }

  #closeSession(reason) {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    const delta = now - s.lastSampleAt;
    if (s.state === 'active') s.activeMs += delta;
    else s.idleMs += delta;

    const iso = getBeijingISOString(now);
    this.db
      .prepare(
        `UPDATE app_usage_sessions_v2 SET ended_at = ?, is_open = 0, end_reason = ?,
         duration_ms = ?, active_duration_ms = ?, idle_duration_ms = ?,
         longest_active_duration_ms = ?, sample_count = ?, context_switch_count = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        iso,
        reason,
        now - s.startedAt,
        s.activeMs,
        s.idleMs,
        s.longestActiveMs,
        s.samples + 1,
        s.switches,
        iso,
        s.rowId
      );
    this.log.debug(
      `session closed: ${s.appName} [${s.state}] ${(now - s.startedAt) / 1000}s (${reason})`
    );
    this.session = null;
  }
}
