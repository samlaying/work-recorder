import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// get-windows' activeWindow() wrapper hangs permanently in Electron main after
// the first vision fetch (observed: helper never spawned/resolved again), while
// the underlying helper binary works fine when spawned directly via execFile.
// So we drive the binary ourselves: serialized (never two helpers at once),
// hard timeout with SIGKILL, parse its JSON, resolve null on any failure.
// ('./main' and './package.json' are not in the package exports map,
// so resolve the package entry and take its directory instead.)
const require = createRequire(import.meta.url);
const pkgRoot = path.dirname(require.resolve('get-windows'));
const HELPER = path.join(pkgRoot, 'main');

let pending = null;

export function activeWindowQuery(timeoutMs = 2000) {
  if (pending) return pending; // coalesce concurrent callers onto one spawn
  pending = new Promise((resolve) => {
    execFile(
      HELPER,
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
