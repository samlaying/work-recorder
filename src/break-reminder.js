import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getBeijingDateString, getBeijingISOString } from './util.js';

// require('electron') returns the binary path under plain node (test harness);
// the optional-chain guards below then fall through to osascript.
const require = createRequire(import.meta.url);
let Notification;
try { ({ Notification } = require('electron')); } catch { /* not under electron */ }

/**
 * Focus/break reminder: accumulate ACTIVE time (any keyboard/mouse input,
 * same idle threshold as the foreground tracker); after workMinutes of it,
 * notify a breakMinutes rest. A spontaneous idle >= resetAfterMinutes counts
 * as rest already taken and resets the accumulator — no nagging right after
 * lunch. Cycles are recorded in focus_cycles for the daily digest; working
 * through a break is recorded honestly but never enforced.
 */
export class BreakReminder {
  constructor({ db, log, inputMonitor, config }) {
    this.db = db;
    this.log = log;
    this.inputMonitor = inputMonitor;
    this.workMinutes = config.workMinutes ?? 45;
    this.breakMinutes = config.breakMinutes ?? 5;
    this.workMs = this.workMinutes * 60 * 1000;
    this.breakMs = this.breakMinutes * 60 * 1000;
    this.resetAfterMs = (config.resetAfterMinutes ?? 5) * 60 * 1000;
    this.idleThresholdMs = config.idleThresholdMs ?? 180000;
    this.timer = null;

    this.phase = 'work'; // 'work' | 'break'
    this.workedMs = 0;
    this.workStartedAt = null;
    this.cycleRowId = null;
    this.breakEndsAt = 0;
    this.breakActiveMs = 0;
    this.lastTickAt = 0;
    this.idleResetLogged = false;
  }

  start() {
    if (this.timer) return;
    this.#resetWork();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.#tick(), 5000);
    this.log.info(
      `break-reminder started (work=${this.workMinutes}m break=${this.breakMinutes}m reset-after-idle=${this.resetAfterMs / 60000}m)`
    );
  }

  stop(reason = 'shutdown') {
    if (!this.timer) return;
    clearInterval(this.timer), (this.timer = null);
    if (this.phase === 'break') this.#finalizeBreak(Date.now()); // no notification, no new cycle
    this.log.info(`break-reminder stopped (${reason})`);
  }

  #active(now) {
    const im = this.inputMonitor;
    if (!im || !im.running) return true; // no input channel → wall-clock accumulation
    return now - im.lastActivityAt < this.idleThresholdMs;
  }

  #resetWork() {
    this.phase = 'work';
    this.workedMs = 0;
    this.workStartedAt = null;
    this.cycleRowId = null;
  }

  #tick() {
    const now = Date.now();
    const delta = now - this.lastTickAt;
    this.lastTickAt = now;
    const active = this.#active(now);
    const idleFor = this.inputMonitor?.running ? now - this.inputMonitor.lastActivityAt : 0;

    if (this.phase === 'work') {
      if (active) {
        this.idleResetLogged = false;
        this.workStartedAt ??= now;
        this.workedMs += delta;
        if (this.workedMs >= this.workMs) this.#startBreak(now);
      } else if (idleFor >= this.resetAfterMs && this.workedMs > 0) {
        if (!this.idleResetLogged) {
          this.log.info(
            `idle ${Math.round(idleFor / 60000)}m ≥ ${this.resetAfterMs / 60000}m — spontaneous rest, focus counter reset`
          );
          this.idleResetLogged = true;
        }
        this.#resetWork();
      }
      // idle shorter than resetAfterMs: accumulation just pauses
    } else {
      // break runs on wall clock; input during it is honesty bookkeeping only
      if (active) this.breakActiveMs += delta;
      if (now >= this.breakEndsAt) {
        this.#finalizeBreak(now);
        this.#notify(
          this.breakActiveMs < 60000 ? '休息结束' : '休息结束（你一直在工作）',
          this.breakActiveMs < 60000
            ? '开始新的专注周期'
            : `这 ${this.breakMinutes} 分钟没有真正休息，下一轮记得离开屏幕`
        );
        this.#resetWork();
      }
    }
  }

  #startBreak(now) {
    this.phase = 'break';
    this.breakEndsAt = now + this.breakMs;
    this.breakActiveMs = 0;
    const startedIso = getBeijingISOString(this.workStartedAt ?? now - this.workedMs);
    const nowIso = getBeijingISOString(now);
    try {
      const res = this.db
        .prepare(
          `INSERT INTO focus_cycles
           (date, work_started_at, work_ended_at, work_ms, break_started_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(getBeijingDateString(), startedIso, nowIso, Math.round(this.workedMs), nowIso, nowIso);
      this.cycleRowId = Number(res.lastInsertRowid);
    } catch (e) {
      this.log.warn(`focus_cycles insert failed: ${e.message}`);
    }
    this.#notify(`专注 ${this.workMinutes} 分钟`, `休息 ${this.breakMinutes} 分钟——离开屏幕，放心休息`);
  }

  #finalizeBreak(now) {
    const rested = this.breakActiveMs < 60000; // under 1min of input during the break
    if (this.cycleRowId == null) return;
    try {
      this.db
        .prepare(
          `UPDATE focus_cycles SET break_ended_at = ?, break_active_ms = ?, rested = ? WHERE id = ?`
        )
        .run(getBeijingISOString(now), Math.round(this.breakActiveMs), rested ? 1 : 0, this.cycleRowId);
    } catch (e) {
      this.log.warn(`focus_cycles update failed: ${e.message}`);
    }
  }

  #notify(title, body) {
    try {
      if (Notification?.isSupported?.()) {
        new Notification({ title, body, soundName: 'default' }).show();
        return;
      }
    } catch { /* fall back to osascript */ }
    try {
      execFileSync('osascript', [
        '-e',
        `display notification "${body}" with title "${title}" sound name "default"`,
      ]);
    } catch (e) {
      this.log.warn(`notify failed: ${e.message}`);
    }
  }
}
