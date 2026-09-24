import { execFileSync } from 'node:child_process';

// The recorder's node-sqlite3-wasm VFS fakes cross-process locking with a
// .lock directory; any second process opening the live db can wedge the
// collector into a permanent "database is locked" (it only recovers at
// process start). Out-of-process readers therefore go through the system
// sqlite3 with immutable=1: no locks are taken at all, so contention is
// impossible. Worst case a read races a commit and errors — callers treat
// that as "retry next tick".
const BINS = process.platform === 'win32' ? ['sqlite3'] : ['/usr/bin/sqlite3', 'sqlite3'];

export function queryJson(dbPath, sql) {
  let lastErr;
  for (const bin of BINS) {
    try {
      const out = execFileSync(
        bin,
        ['-json', `file:${encodeURI(dbPath)}?mode=ro&immutable=1`, sql],
        { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const text = out.toString().trim();
      return text ? JSON.parse(text) : [];
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue; // try next binary
      throw e;
    }
  }
  throw lastErr;
}
