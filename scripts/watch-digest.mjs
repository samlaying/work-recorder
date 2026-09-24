#!/usr/bin/env node
// One-shot watcher: run every few minutes via launchd.
// If work_records has new rows since last check → regenerate today's vault digest.
// State: <dataDir>/digest-state.json   (lastId + day)
// NEVER opens the live db with the wasm driver — see db-snapshot.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workRecorderDataDir } from '../src/paths.js';
import { queryJson } from './db-snapshot.mjs';

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

try {
  const rows = queryJson(dbPath, 'SELECT COALESCE(MAX(id), 0) AS m FROM work_records');
  const maxId = Number(rows[0]?.m ?? 0);

  const today = getBeijingDate();

  if (maxId > state.lastId || today !== state.day) {
    execFileSync(process.execPath, [
      path.join(scriptDir, 'export-digest.mjs'), today, '--vault', VAULT,
    ], { stdio: 'inherit' });
  } else if (maxId < state.lastId) {
    // db was cleaned/purged — resync baseline silently
  }

  fs.writeFileSync(statePath, JSON.stringify({ lastId: maxId, day: today }));
} catch (e) {
  // One line, no stack: launchd logs repeat every 5 minutes.
  console.error(`watch-digest: ${e.message}`);
  process.exit(1); // don't update state → retried next tick
}
