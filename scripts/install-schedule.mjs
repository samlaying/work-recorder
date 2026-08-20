#!/usr/bin/env node
// Install / unload the weekday LaunchAgent (login + every 2 min tick, stop 20:00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'local.work-recorder.schedule';
const TICK = path.join(ROOT, 'scripts', 'schedule-tick.sh');
const uid = process.getuid();
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const logPath = path.join(os.homedir(), 'Library/Logs/work-recorder-schedule.log');
const uninstall = process.argv.includes('--uninstall');

function launchctl(args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message).toString();
    if (!/No such process|Could not find|not found/i.test(msg)) throw e;
  }
}

fs.chmodSync(TICK, 0o755);
launchctl(['bootout', `gui/${uid}/${LABEL}`]);

if (uninstall) {
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(`unloaded ${LABEL}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${TICK}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TZ</key>
    <string>Asia/Shanghai</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
fs.writeFileSync(plistPath, plist);
launchctl(['bootstrap', `gui/${uid}`, plistPath]);
launchctl(['enable', `gui/${uid}/${LABEL}`]);
launchctl(['kickstart', '-k', `gui/${uid}/${LABEL}`]);
console.log(`installed ${LABEL}`);
console.log(`  plist: ${plistPath}`);
console.log(`  log:   ${logPath}`);
console.log('工作日登录/唤醒后两分钟内自动开始，北京时间 20:00 结束。周末不自动开。');
