#!/usr/bin/env node
/**
 * Data cleanup script for work-recorder.
 * 
 * Usage:
 *   npm run clean                 # Prunes data older than 7 days
 *   npm run clean -- --days 3     # Prunes data older than 3 days
 *   npm run clean -- --all        # Completely clears all records and logs (reset to clean state)
 */
import sqliteWasm from 'node-sqlite3-wasm';
const { Database } = sqliteWasm;
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.homedir(), 'Library/Application Support/work-recorder/work-recorder.db');
const logPath = path.join(os.homedir(), 'Library/Application Support/work-recorder/work-recorder.log');
const screenshotDir = path.join(os.homedir(), 'Library/Application Support/work-recorder/screenshots');

const args = process.argv.slice(2);
const isAll = args.includes('--all');
let days = 1; // 默认一天一清
const daysIdx = args.indexOf('--days');
if (daysIdx !== -1 && args[daysIdx + 1]) {
  days = parseInt(args[daysIdx + 1], 10) || 1;
}

if (!fs.existsSync(dbPath)) {
  console.log('数据库文件不存在，无需清理。');
  process.exit(0);
}

const db = new Database(dbPath);

if (isAll) {
  console.log('正在执行全量数据彻底清理（无痕重置）...');
  
  // 清理数据库所有表数据
  db.exec(`
    DELETE FROM work_records;
    DELETE FROM app_usage_sessions_v2;
    DELETE FROM frame_dedup_logs;
    DELETE FROM keyboard_heatmap;
    DELETE FROM tracked_applications;
    VACUUM;
  `);

  // 清空日志文件
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

  // 清理截图目录（如果有）
  if (fs.existsSync(screenshotDir)) {
    fs.rmSync(screenshotDir, { recursive: true, force: true });
  }

  // 清理 stale journal 临时文件
  const appDir = path.dirname(dbPath);
  for (const f of fs.readdirSync(appDir)) {
    if (f.includes('.stale-') || f.endsWith('.png')) {
      try { fs.unlinkSync(path.join(appDir, f)); } catch {}
    }
  }

  console.log('✓ 全量数据已全部清空，无痕迹重置完成！');
} else {
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const cutoffTime = new Date(Date.now() + BEIJING_OFFSET_MS - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`正在清理 ${days} 天前（${cutoffTime} 之前）的历史记录...`);

  const r1 = db.prepare(`DELETE FROM work_records WHERE substr(captured_at, 1, 10) < ?`).run(cutoffTime);
  const r2 = db.prepare(`DELETE FROM app_usage_sessions_v2 WHERE substr(started_at, 1, 10) < ?`).run(cutoffTime);
  const r3 = db.prepare(`DELETE FROM frame_dedup_logs WHERE substr(captured_at, 1, 10) < ?`).run(cutoffTime);
  const r4 = db.prepare(`DELETE FROM keyboard_heatmap WHERE date < ?`).run(cutoffTime);
  db.exec('VACUUM;');

  console.log(`✓ 清理完成！已清理 ${days} 天前的历史记录。`);
}
