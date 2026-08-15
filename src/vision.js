import fs from 'node:fs';
import path from 'node:path';
import { getBeijingISOString } from './util.js';

/**
 * Layer 2: screenshot -> structured work record via an OpenAI-compatible vision model.
 *
 * Each capture sends: screenshot + focused-window info + recent system context,
 * under a user-configurable prompt template (screenshot-prompt-templates analogue).
 * The default prompt enforces sensitive-field filtering (passwords/tokens/OTPs).
 */

const DEFAULT_PROMPT = `你是工作行为记录助手。请根据这张屏幕截图和当前前台应用信息，用一句话（不超过 60 字）概括用户此刻正在做什么工作。只描述工作内容，不要猜测情绪或意图。如果画面中出现密码、Token、验证码、API Key、私聊内容等敏感信息，一律用【敏感信息已过滤】代替，不得转述。`;

export class VisionService {
  constructor({ db, log, config, dataDir }) {
    this.db = db;
    this.log = log;
    this.cfg = config.vision;
    this.dataDir = dataDir;
    this.queue = [];
    this.running = false;
  }

  enabled() {
    return !!(this.cfg.enabled && this.cfg.apiKey && !this.cfg.apiKey.startsWith('sk-REPLACE'));
  }

  /** Called by the screenshot service with a fresh capture; serializes requests. */
  enqueue({ pngBuf, appName, title, source, systemContext }) {
    this.queue.push({ pngBuf, appName, title, source, systemContext, at: Date.now() });
    this.#drain().catch((e) => this.log.error(`vision: ${e.message}`));
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        // keep only freshest if backlog builds up (bounded staleness)
        if (this.queue.length > 2) {
          this.queue.splice(0, this.queue.length - 1);
        }
        await this.#process(job);
      }
    } finally {
      this.running = false;
    }
  }

  async #process({ pngBuf, appName, title, source, systemContext }) {
    const t0 = Date.now();
    const prompt = this.cfg.promptTemplate?.trim() || DEFAULT_PROMPT;
    const row = {
      captured_at: getBeijingISOString(),
      source: source ?? 'manual',
      app_name: appName,
      window_title: title,
      system_context: systemContext ?? null,
      prompt,
      model: this.cfg.model,
      summary: null,
      raw_response: null,
      error: null,
      screenshot_path: null,
      latency_ms: null,
    };

    try {
      const content = [
        { type: 'text', text: this.#buildUserText(appName, title, systemContext, prompt) },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${pngBuf.toString('base64')}` },
        },
      ];
      const resp = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: this.cfg.maxTokens ?? 1024,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      const json = await resp.json();
      const text = json.choices?.[0]?.message?.content ?? '';
      row.raw_response = text;
      row.summary = text.trim().split('\n')[0].slice(0, 500);
      row.latency_ms = Date.now() - t0;
      this.log.info(`work-record [${row.source}] ${row.summary}`);
    } catch (e) {
      row.error = e.message;
      this.log.warn(`vision failed: ${e.message}`);
    }

    // keep the screenshot only if explicitly configured (evidence/debug)
    if (this.cfg.keepScreenshots) {
      const dir = path.join(this.dataDir, 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      row.screenshot_path = path.join(dir, `${row.captured_at.replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(row.screenshot_path, pngBuf);
    }

    this.db
      .prepare(
        `INSERT INTO work_records (captured_at, source, app_name, window_title, system_context,
         prompt, model, summary, raw_response, error, screenshot_path, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.captured_at, row.source, row.app_name, row.window_title, row.system_context,
        row.prompt, row.model, row.summary, row.raw_response, row.error,
        row.screenshot_path, row.latency_ms
      );
  }

  #buildUserText(appName, title, systemContext, prompt) {
    const parts = [prompt];
    if (appName) parts.push(`前台应用: ${appName}${title ? ` — ${title.slice(0, 120)}` : ''}`);
    if (systemContext) parts.push(`近期工作上下文:\n${systemContext}`);
    return parts.join('\n\n');
  }
}
