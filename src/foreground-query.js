import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { withTimeout } from './util.js';

// macOS: get-windows' JS wrapper hangs in Electron main after the first vision
// fetch; spawn the Swift helper ourselves with a hard timeout.
// Windows/Linux: native addon / different helper — use the package API.
const require = createRequire(import.meta.url);
const pkgRoot = path.dirname(require.resolve('get-windows'));
const MAC_HELPER = path.join(pkgRoot, 'main');

let pending = null;

export function activeWindowQuery(timeoutMs = 2000) {
  if (pending) return pending;

  if (process.platform === 'darwin') {
    pending = new Promise((resolve) => {
      execFile(
        MAC_HELPER,
        [],
        { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
        (err, stdout) => {
          pending = null;
          if (err) return resolve(null);
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        }
      );
    });
    return pending;
  }

  pending = (async () => {
    try {
      const { activeWindow } = await import('get-windows');
      return await withTimeout(() => activeWindow(), timeoutMs, 'activeWindow');
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
