import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  pollIntervalMs: 2000,
  idleThresholdMs: 180000,
  screenshot: {
    enabled: true,
    intervalSeconds: 120,
    minIntervalSeconds: 120,
    pauseOnIdle: true,
    dedupEnabled: true,
    dedupThreshold: 0.02,
    dedupScaleWidth: 320,
    keepScreenshots: false,
    enterKeyTrigger: true,
    enterKeyDebounceMs: 30000,
    excludedApps: [],
    notExcludedApps: [],
  },
  keyboardHeatmap: { enabled: true, flushIntervalSeconds: 300 },
  vision: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    maxTokens: 1024,
    language: 'zh',
    promptTemplate: '',
    contextLines: 3,
  },
  log: { level: 'info', file: 'work-recorder.log' },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k] ?? {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  // Order: --config <path> > PROJECT_ROOT/config.json > PROJECT_ROOT/config.example.json (apiKey etc. empty)
  const argv = process.argv;
  let file = null;
  const ci = argv.indexOf('--config');
  if (ci !== -1 && argv[ci + 1]) file = path.resolve(argv[ci + 1]);
  else if (fs.existsSync(path.join(PROJECT_ROOT, 'config.json')))
    file = path.join(PROJECT_ROOT, 'config.json');

  const userCfg = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = deepMerge(DEFAULTS, userCfg);
  return { config: cfg, configFile: file };
}

export { PROJECT_ROOT };
