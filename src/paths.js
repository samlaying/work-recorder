import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** Same location Electron uses for app.getPath('userData') given package name work-recorder. */
export function workRecorderDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/work-recorder');
  }
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'work-recorder');
  }
  return path.join(os.homedir(), '.config', 'work-recorder');
}

export function electronBinary(projectRoot) {
  if (process.platform === 'win32') {
    return path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(
      projectRoot,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    );
  }
  return path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
}

/** Best-effort rollback of a stale sqlite journal. sqlite3 CLI is optional. */
export function recoverSqliteJournal(dbPath) {
  const journal = dbPath + '-journal';
  const lockDir = dbPath + '.lock';
  const bins =
    process.platform === 'win32' ? ['sqlite3'] : ['/usr/bin/sqlite3', 'sqlite3'];
  for (const bin of bins) {
    try {
      execFileSync(bin, [dbPath, 'SELECT count(*) FROM sqlite_master;'], {
        timeout: 3000,
        stdio: 'pipe',
      });
      break;
    } catch {
      /* try next / skip */
    }
  }
  if (fs.existsSync(journal)) fs.renameSync(journal, `${journal}.stale-${Date.now()}`);
  if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
}
