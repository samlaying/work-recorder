#!/usr/bin/env node
// Build "Work Recorder.app" — a renamed, re-signed copy of the node_modules
// Electron — so macOS labels our notifications and permission entries "Work
// Recorder" instead of "Electron". Notification sender identity comes from
// the running app bundle; the Notification API cannot change it.
// Re-run after any electron version bump (npm install triggers it via postinstall).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const APP_NAME = 'Work Recorder';
const BUNDLE_ID = 'local.work-recorder';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const DEST = path.join(ROOT, `${APP_NAME}.app`);

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString().trim();

try {
  if (process.platform !== 'darwin') process.exit(0); // macOS-only concern
  if (!fs.existsSync(SRC)) {
    console.error(`make-app: electron not installed yet — skipping (${SRC})`);
    process.exit(0); // postinstall on a fresh clone, before electron lands
  }
  fs.rmSync(DEST, { recursive: true, force: true });
  sh('ditto', [SRC, DEST]); // ditto preserves bundle structure/xattrs correctly
  const plist = path.join(DEST, 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleName', APP_NAME],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleIdentifier', BUNDLE_ID],
  ]) {
    sh('plutil', ['-replace', key, '-string', value, plist]);
  }
  // arm64 refuses to run a bundle whose signature no longer matches its edits
  sh('codesign', ['--force', '--deep', '--sign', '-', DEST]);
  console.log(`✓ ${DEST}`);
  console.log('  One-time after switching: re-grant 屏幕录制 + 辅助功能 to this app,');
  console.log('  and allow notifications when the first one arrives.');
} catch (e) {
  // Loud but non-fatal: schedule-tick falls back to the node_modules Electron.
  console.error(`make-app failed (launch will use plain Electron): ${e.message}`);
  process.exit(0);
}
