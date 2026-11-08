# grokbot-BYOK 使用说明书

> 版本:v2.x · 更新:2026-11-08 · 适用于当前 main 分支
>
> 本手册描述的每一条命令与行为均经过真机验证。

---

## 目录

1. [这是什么](#1-这是什么)
2. [工作原理](#2-工作原理)
3. [安装与升级](#3-安装与升级)
4. [快速开始(三分钟)](#4-快速开始三分钟)
5. [三种接入方式](#5-三种接入方式)
6. [订阅登录(OAuth)详解](#6-订阅登录oauth详解)
7. [多账号与优先级](#7-多账号与优先级)
8. [模型与别名](#8-模型与别名)
9. [配置文件完全参考](#9-配置文件完全参考)
10. [路由、容错与熔断](#10-路由容错与熔断)
11. [守护进程管理](#11-守护进程管理)
12. [常用命令速查](#12-常用命令速查)
13. [日志与排障](#13-日志与排障)
14. [安全须知](#14-安全须知)
15. [测试与开发](#15-测试与开发)
16. [卸载](#16-卸载)

---

## 1. 这是什么

**grokbot-BYOK** 是一个跑在你本机(127.0.0.1:8788)的 AI 推理代理:

- 把 **Grok Bot**(及其 Cursor 系宿主)的推理调用拦截下来,改走**你自己的**模型渠道;
- 渠道可以是 **API Key**(OpenRouter / OpenCode / 本地服务等),也可以是**你的订阅账号登录**(ChatGPT、Claude、Google Antigravity)——不再为 IDE 单独买 API;
- 多渠道自动**故障转移**:配额耗尽、token 失效、服务超时都会自动切到下一个渠道,客户端无感。

> **订阅登录的边界提示**:OAuth 直通在各家 ToS 中属灰色地带,理论上存在账号风控风险;API Key 渠道永远是"安全路径"。详见[第 14 节](#14-安全须知)。

## 2. 工作原理

```
Grok Bot (Connect-RPC)                 你的模型渠道
      │                                      ▲
      ▼                                      │ OpenAI SSE / Anthropic / Gemini
┌──────────────────┐    协议翻译    ┌─────────┴────────┐
│  grokbot-BYOK    │ ────────────▶ │  上游 Provider    │
│  127.0.0.1:8788  │ ◀──────────── │  ×N + 自动 failover│
└──────────────────┘    流式回译    └──────────────────┘
```

- 宿主的 `host-main.cjs` 会被自动打补丁,把推理请求指向本代理;宿主升级后由 **watcher 守护**自动重打补丁(备份为 `host-main.cjs.bak`)。
- 未安装 Grok Bot 宿主的机器上,补丁步骤自动跳过,代理本身照常可用(直接向 8788 发 Connect 请求即可,见 `test/live/` 冒烟脚本)。
- 代理内部统一用 OpenAI Chat Completions 方言,对三家订阅渠道分别内置 Responses / Anthropic Messages / Gemini v1internal 翻译层。

## 3. 安装与升级

**要求**:Node.js 18+(开发验证于 Node 26)、macOS/Linux。

```bash
git clone https://github.com/TommyG0105/grokbot-BYOK.git
cd grokbot-BYOK
npm install          # 安装依赖
npm run setup        # 一键:生成配置 → 构建 → 启动守护 → 打补丁 → 冒烟
```

`npm run setup` 完全非交互,可带参数写入 API Key(见 5.2)。升级:`git pull && npm install && npm run setup`。

## 4. 快速开始(三分钟)

**零 Key 可用**(Kilo 匿名通道,约 200 次/小时/IP):

```bash
npm run setup        # 不传任何 Key 也能启动
npm status           # 三个守护都应为 running
```

**用订阅账号(推荐,免费账号即可两家)**:

```bash
npm run login -- chatgpt       # 浏览器登录 ChatGPT(免费档可用)
npm run login -- antigravity   # 浏览器登录 Google 账号(免费档含 Gemini 配额)
npm start                      # 重启 shim 激活
npm run login --status         # 查看全部已登录账号
```

**验证**:

```bash
node test/live/chatgpt-smoke.mjs                      # 默认模型打一发
MODEL=gemini-3-pro-preview node test/live/chatgpt-smoke.mjs   # 指定模型
MODEL=gemini-3-pro-preview node test/live/chatgpt-smoke.mjs --tools  # 含工具调用
```

看到 `SMOKE OK` 即全链路通畅。

## 5. 三种接入方式

### 5.1 订阅登录(零 API Key)

| Provider | 计划要求 | 免费档 | 登录后的默认模型 |
|---|---|---|---|
| `chatgpt` | 任意(含免费) | ✅ 目录较小(gpt-reserve / gpt-5.6 / gpt-6 系)、配额较低 | `gpt-reserve`(登录时自动探测目录第一项) |
| `antigravity` | 任意 Google 账号 | ✅ 含 Gemini 配额(有当日上限) | `gemini-3-pro-preview` |
| `claude` | **需 Claude Pro/Max** | ❌ 授权页直接拒绝免费账号 | `claude-sonnet-4-5` |

详细步骤见[第 6 节](#6-订阅登录oauth详解)。

### 5.2 API Key(BYOK)

```bash
# 方式一:CLI 参数(自动写入 .env)
npm run setup -- --opencode-key sk-xxx --openrouter-key sk-or-xxx

# 方式二:环境变量
OPENCODE_API_KEY=sk-xxx npm run setup

# 方式三:直接编辑 .env
```

| Provider | 环境变量 | 必填 | 说明 |
|---|---|---|---|
| `opencode-go` | `OPENCODE_API_KEY` | setup 视为必填(有订阅登录时豁免) | 主力渠道,免费层 |
| `openrouter` | `OPENROUTER_API_KEY` | 否 | 一个 Key 聚合大量模型 |
| `kilo` | `KILO_API_KEY` | 否 | 不填 Key 也可匿名用(限速) |
| `opencode-zen` | `OPENCODE_API_KEY` | 否 | 与 go 共用 Key |
| `local` | `LOCAL_API_KEY` | 否 | 本地 127.0.0.1:3003 服务 |

> 注意:`.env` 里残留**占位符**(如 `sk-your-...`)会被当作真 Key 发送而吃到 401;确认要么留空、要么填真值。

### 5.3 同机直连(无宿主)

任何能发 Connect-RPC 流式请求的程序都可直连 `127.0.0.1:8788` 的 `/aiserver.v1.InferenceService/Stream`,请求体为 proto3 JSON。仓库内 `test/live/chatgpt-smoke.mjs` 是最小可参考客户端。

## 6. 订阅登录(OAuth)详解

统一入口(旧 `chatgpt:login` 等别名仍可用):

```bash
npm run login -- <provider> [选项]
#   provider: chatgpt | claude | antigravity
#   --priority N    账号优先级,数字越小越优先(默认 100)
#   --auto-config   登录成功后自动把 defaultModel 设为探测到的第一个可用模型
#   --no-open       不自动开浏览器(手动复制打印出的 URL)
```

**通用流程**:命令启动 → 自动打开浏览器授权页 → 你在浏览器完成登录/同意 → 本地回调端口收码 → 换取 token → (Antigravity 额外自动完成 loadCodeAssist/onboardUser 注册) → 账号写入本地凭据库 → 提示重启 shim。

**各家回调端口**(端口被占用会明确报错,先释放再试):

| Provider | 浏览器授权域 | 本地回调 | 凭据文件 |
|---|---|---|---|
| chatgpt | auth.openai.com | localhost:**1455**/auth/callback | `config/chatgpt-tokens.json` |
| claude | claude.ai | localhost:**54545**/callback | `config/oauth/claude-tokens.json` |
| antigravity | accounts.google.com | localhost:**51121**/oauth-callback | `config/oauth/antigravity-tokens.json` |

**查看与退出**:

```bash
npm run login --status                      # 所有 provider 的账号/优先级/到期时间
npm run logout -- chatgpt                   # 查看/交互确认
npm run logout -- chatgpt --all             # 全部退出(尽力吊销 token + 本地删除)
npm run logout -- claude --account <id>     # 退出指定账号
```

**登录后必做**:`npm start` 重启 shim(凭据库在启动时加载)。

**Token 生命周期**:access token 到期前自动刷新(后台每 10 分钟巡检 + 请求时兜底);刷新失败(invalid_grant,如你在官方客户端登出)会自动禁用该账号并在 `--status` 里标注 `DISABLED (re-login)`,重跑登录即恢复。

## 7. 多账号与优先级

体系分两层,互不冲突:

1. **渠道之间**:`config.json` 的 `providers.priority` 数组决定整体顺序(默认
   `openrouter → opencode-go → kilo → opencode-zen → local → chatgpt → claude → antigravity`);
   没配 Key / 没登录的渠道自动离队。
2. **同一渠道的账号之间**(OAuth):`--priority N` 设定,小者优先,**fill-first 降级**——
   主账号配额耗尽(429 usage_limit)或 token 失效时自动切到次账号,全部耗尽才轮到下一渠道。

```bash
# 例:主用 A 账号,B 做备份(再开一个浏览器 profile 登录)
npm run login -- chatgpt --priority 10    # A
npm run login -- chatgpt --priority 20    # B
npm start
```

API Key 池(`keys` 数组)仍为轮转(round-robin)语义;OAuth 渠道固定用优先级语义。

## 8. 模型与别名

- 每个渠道的 `models` 是 **别名 → 真实模型 id** 映射;请求里的模型名(宿主 UI 模型名)经小写归一后查表。
- 查不到的模型 → 落到该渠道 `defaultModel`;没有任何渠道认领 → 整链兜底渠道处理。
- **Claude 思考预算**:`<模型>-thinking-<N>` 别名自动开启 N token 思考预算(如 `claude-opus-4-5-thinking-32000`),非数字后缀安全忽略。
- **查看你的账号实际可用模型**:
  - ChatGPT:登录时自动拉取并打印(受 client_version 门控的目录端点);
  - Claude:登录时逐个 1-token 探测,输出 ✅/❌ 清单;
  - Antigravity:打印候选清单,首次真实请求时验证。
- 默认模型建议用 `--auto-config` 自动落到"第一个可用",或手动改 `config.json`。

## 9. 配置文件完全参考

位置:`config/config.json`(首次 setup 从 `config.example.json` 复制;支持 `${ENV_VAR}` 插值,值来自 `.env`)。

```jsonc
{
  "port": 8788,                        // 监听端口(SHIM_PORT 可覆盖)
  "host": "127.0.0.1",                 // 监听地址
  "logDir": "",                        // 日志目录(空 = /tmp)
  "failover": true,                    // 总开关:渠道间自动切换
  "requestTimeoutMs": 30000,           // 基础请求超时(大请求自适应延长)
  "routingStrategy": "latency",        // priority | round-robin | weighted-round-robin | fill-first | latency
  "sessionAffinity": { "enabled": false, "ttlMs": 3600000 },
  "visionFallbackModel": "",           // 非视觉模型收到图片时的兜底(空=剥图片)

  "providers": {
    "priority": ["openrouter", "..."],           // 渠道顺序
    "configs": {
      "<渠道名>": {
        "baseUrl": "…",                          // 上游基地址
        "apiKey": "${XX_API_KEY}",               // 静态 Key(占位符未解析=留空处理)
        "keys": [ { "value": "…", "weight": 1, "enabled": true } ],  // 可选多 Key 池
        "keyless": false,                        // true=无 Key 也参与(如 kilo)
        "defaultModel": "…",                     // 别名未命中时的模型
        "models": { "别名": "真实id" },           // 别名表
        "network": {                             // 可选,逐项覆盖
          "maxRetries": 1,                       // 渠道内重试次数
          "retryBackoffInitialMs": 500,
          "retryBackoffMaxMs": 5000,
          "rateLimitCooldownMs": 10000,          // 429 熔断时长(antigravity 建议 300000)
          "serverErrorCooldownMs": 30000,        // 5xx 熔断时长
          "failureThreshold": 3,                 // 连续失败开闸阈值
          "streamIdleTimeoutMs": 120000,         // 流式空闲超时
          "ttfbTimeoutMs": 15000                 // 首 token 超时
        },
        "compat": { "supportsImages": false, "supportsReasoningEffort": true },
        // —— 订阅登录渠道专用 ——
        "auth": {
          "type": "chatgpt-oauth | claude-oauth | antigravity-oauth",
          "tokenFile": "config/oauth/….json"     // 凭据库路径(有默认值)
        },
        "endpointPath": "/responses",            // 上游路径(默认 /chat/completions)
        "wireApi": "responses | anthropic-messages | gemini-v1internal",
        "keySelection": "priority"               // OAuth 渠道默认 priority
      }
    }
  },

  "hostConfig": { "sandHostDir": "${SAND_HOST_DIR}", "defaultModel": "…" }
}
```

> 修改 `config.json` 后需 `npm start` 生效(凭据库与渠道表在启动时装配)。

## 10. 路由、容错与熔断

- **选路**:按 `routingStrategy` 在"认领了该模型别名的渠道"中挑选;latency 策略按实测 TTFB/吞吐打分并小比例探索。
- **故障转移链**:主渠道失败 → 沿 priority 链依次尝试;客户端在整个过程中无感(响应未开始前不写字节)。
- **错误分类与动作**:
  - `401/403` → 先强制刷新一次 token(OAuth)→ 仍失败轮换下一**账号**;
  - `429 usage_limit_reached`(ChatGPT 配额)→ 视为账号级,轮换账号;
  - 其他 `429` → 熔断冷却(渠道级)+ 上游建议退避;
  - **退避上限 60s**:上游建议的半小时级等待(如 Google 配额)不阻塞当前请求,立即切下一渠道;
  - `400/404/422` → 判定请求本身问题,立即终止(不浪费其他渠道);
  - `5xx`/网络错误/空补全/TTFB 超时 → 重试或转移,连续失败触发熔断。
- **流式中途故障**:已产生内容则尽量交付;首字节前失败则整体转移重试。

## 11. 守护进程管理

| 命令 | 作用 |
|---|---|
| `npm start` | 启动/重启全部守护(= setup --no-build) |
| `npm stop` | 停止全部守护 |
| `npm status` | 查看三守护 + 8788 端口状态 |

三个守护:

1. **Shim**(核心代理,PID 锁按端口互斥);
2. **Host watcher**(宿主升级后自动重打补丁;未装宿主则闲置);
3. **Health watchdog**(每 60s 巡检;**连续两次**异常才自动重部署,避免启动竞态;部署含旧进程清理与重试)。

日志(默认 /tmp):`inference-shim.log`(主)、`grokbot-watch-host.log`、`grokbot-health-check.log`。

## 12. 常用命令速查

```bash
# ── 生命周期 ──
npm run setup [-- --opencode-key sk-…]   # 全新安装/配置
npm start / npm stop / npm status        # 启停与状态

# ── 订阅登录 ──
npm run login -- chatgpt|claude|antigravity [--priority N] [--auto-config]
npm run login --status
npm run logout -- <provider> [--all | --account <id>]

# ── 验证 ──
node test/live/chatgpt-smoke.mjs [MODEL=xxx] [--tools]
tail -20 /tmp/inference-shim.log

# ── 开发 ──
npm test            # 全量测试
npm run typecheck   # 类型检查
npm run build:all   # 重建 shim + 脚本
npm run uninstall   # 卸载
```

## 13. 日志与排障

**看什么**:`routing request`(选了哪个渠道/链)、`upstream connected`、`request complete`(含 usage/ttfb)、`failover trail`(整条尝试轨迹)。

| 症状 | 原因与处理 |
|---|---|
| 登录报"could not bind callback port 1455/54545/51121" | 回调端口被占(常见:上次登录进程残留/官方客户端在登)。释放端口后重试 |
| Claude 登录页提示无法使用 Claude Code | 免费账号被 Anthropic 拒绝;需 Pro/Max |
| `anthropic beta`/401 刷新后仍 401 | 账号在官方端登出过 → `--status` 会标 DISABLED,重跑登录 |
| Antigravity 请求长时间无响应后 429 | 免费档**当日配额**耗尽(Google 提示重试 1800s)。代理会秒级切到下一渠道;次日自动恢复 |
| 请求疑似"抽风"失败后守护重启 | 检查 `/tmp/inference-shim.log` 最近 5 分钟是否有失败记录——watchdog 按滚动窗口统计,排障时可 `: > /tmp/inference-shim.log` 清零再复现 |
| Kilo 404 model_not_found | Kilo 目录漂移(模型下架);把 kilo 的 `defaultModel` 换成其 `/api/gateway/models` 里现存 id |
| opencode 400 MissingSessionID | 上游新增会话头要求;渠道暂时不可用,等更新或改用其他渠道 |
| `.env` 填了占位 Key 后全 401 | 占位字符串会被当真 Key;留空即可(keyless 自动生效) |
| 修改配置不生效 | 配置与凭据库在启动时装配 → `npm start` |

## 14. 安全须知

- **凭据位置**:真实 token 只存 `config/chatgpt-tokens.json`、`config/oauth/*.json`(权限 0600,原子写入)与 `.env`;以上均已在 `.gitignore`,**永不入库**(含 CI Push Protection 兜底)。
- **网络面**:代理仅监听 127.0.0.1,不对外暴露。
- **日志脱敏**:token/key 在日志输出前自动打码。
- **ToS 与账号风险**:订阅 OAuth 直通按各家条款属灰色地带,可能引来风控;请只用你自己的账号、自担风险;API Key 渠道是合规安全路径。
- 上游协议随时可能变(本手册里的端点/常量截至 2026-11 验证有效)。

## 15. 测试与开发

```bash
npm test               # 全量(单元 + 集成 + 黑盒;442 项)
npm run typecheck
npm run build:all      # esbuild 产物:dist/shim.js + dist/scripts/*
```

- 方言翻译与 OAuth 流程均有单测/集成测试(mock 上游 + mock token 端点);
- `test/live/e2e-chatgpt-built.mjs` 为**构建产物**黑盒 E2E(拉起真实 dist/shim.js 子进程);
- 新增渠道的模式:provider 配置(纯数据)→(新方言时)translate 层 → 测试三件套,参考 `src/translate/gemini-v1internal.ts` 与对应测试。

## 16. 卸载

```bash
npm run uninstall      # 停守护、恢复宿主补丁备份、清理 PID/配置产物(凭据文件按提示保留或删除)
```

---

*本手册随仓库演进;发现行为与手册不符时,以 `README.md` 与源码为准,并欢迎回补文档。*
