#!/usr/bin/env node
// One-shot watcher: run every few minutes via launchd.
// If work_records has new rows since last check → regenerate today's vault digest.
// State: <dataDir>/digest-state.json   (lastId + day)
import sqliteWasm from 'node-sqlite3-wasm';
const { Database } = sqliteWasm;
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workRecorderDataDir } from '../src/paths.js';

const VAULT = '/Users/sam/02-Obsidian/Growth-Vault';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const getBeijingDate = () =>
  new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const dataDir = workRecorderDataDir();
const statePath = path.join(dataDir, 'digest-state.json');
const dbPath = path.join(dataDir, 'work-recorder.db');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

let state = { lastId: 0, day: '' };
try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch {}

const db = new Database(dbPath);
const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM work_records').get().m;
db.close();

const today = getBeijingDate();

if (maxId > state.lastId || today !== state.day) {
  try {
    execFileSync(process.execPath, [
      path.join(scriptDir, 'export-digest.mjs'), today, '--vault', VAULT,
    ], { stdio: 'inherit' });
  } catch (e) {
    console.error('digest export failed:', e.message);
    process.exit(1); // don't update state → retried next tick
  }
} else if (maxId < state.lastId) {
  // db was cleaned/purged — resync baseline silently
}

fs.writeFileSync(statePath, JSON.stringify({ lastId: maxId, day: today }));
