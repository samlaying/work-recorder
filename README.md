# work-recorder

无界面行为采集 → 工作记录（复刻"小黑日报助手"的第 1、2 层，无前端）。

## 结构

```
src/
├── main.js               # 入口：headless Electron 主进程（无 BrowserWindow，dock 隐藏）
├── config.js             # config.json 加载 + 默认值
├── db.js                 # SQLite（node-sqlite3-wasm，纯 WASM 无需 native rebuild）
├── foreground-tracker.js # 通道1：get-windows 轮询 → app_usage_sessions_v2（active/idle 切分）
├── input-monitor.js      # 通道2：uiohook-napi → 空闲检测 / 回车触发 / 键盘热力图
├── screenshot.js         # 通道3：desktopCapturer → 去重(pixelmatch)/排除名单/最小间隔/空闲暂停
└── vision.js             # 第2层：OpenAI 兼容视觉模型 → work_records（敏感信息过滤提示词）
scripts/report.mjs        # 离线日报摘要（直接读 SQLite，不需要 Electron）
scripts/schedule-tick.sh  # launchd：工作日窗口内拉起 / 20:00 停
scripts/install-schedule.mjs
```

## 使用

```bash
cd work-recorder
npm install
cp config.example.json config.json   # 填 vision.apiKey（OpenAI/DeepSeek/GLM 等兼容端点均可）
npm start                            # 启动后台采集
npm run schedule:install             # 工作日登录/唤醒自动开始，北京时间 20:00 结束
npm run schedule:uninstall           # 取消自动启停
npm run report                       # 查看当天时间线 + 工作记录
npm run report -- 2026-08-14         # 指定日期
```

数据库：`~/Library/Application Support/work-recorder/work-recorder.db`

## macOS 权限（两项都必须）

| 权限 | 用途 | 开启方式 |
|---|---|---|
| 屏幕录制 | 截图 + get-windows 读窗口标题 | 系统设置 → 隐私与安全性 → 屏幕录制 → 添加本仓库的 Electron：`node_modules/electron/dist/Electron.app`（不要加 openhanako 或其他项目里的） |
| 辅助功能 | uiohook 全局键鼠监听 | 同上，添加**这一份** Electron |

未授权时：前台应用读不到标题、截图为空、键鼠事件收不到——日志会有对应 warn。

## 复刻的关键工程设计

1. **会话不是记时间**：`app_usage_sessions_v2` 按 `(应用, 活跃状态)` 切分会话，记录 `active_duration_ms / idle_duration_ms / context_switch_count / longest_active_duration_ms / sample_count / confidence / detection_source`
2. **截图去重**：pixelmatch 对比前后帧，差异率 < `dedupThreshold` 跳过识别；判定记录进 `frame_dedup_logs`（只存差异率，不存图）
3. **防风控**：截图最小间隔 2 分钟（配置强制下限）、鼠标空闲自动暂停、排除名单（前台是微信/密码管理器时跳过），`notExcludedApps` 优先级更高（排除"微信"但放行"企业微信"）
4. **回车触发**：全局监听回车 → 防抖窗口内只截第一次 → 截图识别。回车 ≈ "刚完成一件事"的低成本切分信号
5. **敏感信息**：默认提示词要求模型用【敏感信息已过滤】替代密码/Token/验证码/私聊；`keepScreenshots=false` 时截图识别后即丢弃，不落盘

## 数据流

```
get-windows ──轮询──▶ app_usage_sessions_v2 ─┐
uiohook-napi ─▶ idle/enter/heatmap ──────────┤
desktopCapturer ─▶ 去重 ─▶ vision API ─▶ work_records ─┼─▶ scripts/report.mjs 日报摘要
```
