import fs from 'node:fs';
import path from 'node:path';
import { getBeijingLogTime } from './util.js';

// If the parent shell/terminal is gone, every console.log throws an async
// EPIPE that crashes the process as an uncaught exception. Swallow it —
// file logging is unaffected.
for (const s of [process.stdout, process.stderr]) {
  s?.on?.('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

export function createLogger(cfg, dataDir) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[cfg.level] ?? 20;
  const file = path.join(dataDir, cfg.file ?? 'work-recorder.log');
  const stream = fs.createWriteStream(file, { flags: 'a' });

  function write(level, msg) {
    if (levels[level] < min) return;
    const line = `${getBeijingLogTime()} [${level}] ${msg}`;
    stream.write(line + '\n');
    console.log(line);
  }

  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    end: () => stream.end(),
  };
}
