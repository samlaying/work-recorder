#!/usr/bin/env node
// Export a day's work digest as Markdown into the Obsidian Growth-Vault.
// Usage: node scripts/export-digest.mjs [YYYY-MM-DD] [--vault <path>]
// Reuses the same queries as report.mjs; safe to re-run (overwrites same-day file).
import sqliteWasm from 'node-sqlite3-wasm';
const { Database } = sqliteWasm;
import fs from 'node:fs';
import path from 'node:path';
import { workRecorderDataDir, recoverSqliteJournal } from '../src/paths.js';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const getBeijingDate = (d = new Date()) =>
  new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const args = process.argv.slice(2);
const vaultIdx = args.indexOf('--vault');
const vault = vaultIdx !== -1 ? args[vaultIdx + 1] : '/Users/sam/02-Obsidian/Growth-Vault';
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? getBeijingDate();

const formatBeijingTime = (str) => {
  if (!str) return '--:--';
  if (str.endsWith('Z')) {
    const bj = new Date(new Date(str).getTime() + BEIJING_OFFSET_MS);
    return bj.toISOString().slice(11, 16);
  }
  return str.slice(11, 16);
};
const pad = (ms) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

const dbPath = path.join(workRecorderDataDir(), 'work-recorder.db');
let db;
try {
  db = new Database(dbPath);
  db.prepare('SELECT 1').all();
} catch (e) {
  const journal = dbPath + '-journal';
  const lockDir = dbPath + '.lock';
  if (/locked/i.test(e.message) && (fs.existsSync(journal) || fs.existsSync(lockDir))) {
    recoverSqliteJournal(dbPath);
    db = new Database(dbPath);
  } else {
    throw e;
  }
}

const sessions = db.prepare(
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
).all([date, date]);

const records = db.prepare(
  `SELECT captured_at, source, app_name, summary, error FROM work_records
   WHERE (captured_at LIKE '%Z' AND date(captured_at, '+8 hours') = ?)
      OR (captured_at NOT LIKE '%Z' AND substr(captured_at, 1, 10) = ?)
   ORDER BY id`
).all([date, date]);

let md = `---
created: ${date}
area: work
type: log
source: work-recorder
---

# Work Log — ${date}

> work-recorder 自动生成。随时重跑 \`worklog\` 覆盖更新为全天数据。

`;

if (!sessions.length && !records.length) {
  md += `> 今日暂无数据（采集器未运行 / 非工作日 / 权限未授予）。\n`;
} else {
  md += `## ⏱ 应用时间线\n\n| 应用 | 状态 | 总时长 | 活跃 | 会话 | 切换 |\n|---|---|---|---|---|---|\n`;
  for (const s of sessions) {
    md += `| ${s.app_name} | ${s.activity_state} | ${pad(s.active_ms + s.idle_ms)} | ${pad(s.active_ms)} | ${s.session_count} | ${s.switches} |\n`;
  }
  md += `\n## 📝 工作记录（${records.length} 条，视觉模型摘要）\n\n`;
  for (const r of records) {
    const t = formatBeijingTime(r.captured_at);
    md += r.error
      ? `- ${t} [${r.source}] ⚠️ ${r.error}\n`
      : `- ${t} — ${r.summary}\n`;
  }
}

md += `
## 🗣️ 复述素材（午休填）
> 从上面挑 1-2 条最有价值的，用自己的话写进日记：结论 → 理由 → 例子。
> 进阶：丢给 Claude 用英语复述一遍（[[prompt-library]] Expression-3）。

## 🎯 今天最重要的一件事（下班前填）
-
`;

const outDir = path.join(vault, '01-Daily');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `work-log-${date}.md`);
fs.writeFileSync(outFile, md, 'utf-8');
console.log(`✓ ${outFile}  (sessions: ${sessions.length}, records: ${records.length})`);
