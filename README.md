<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 多模态视觉辅助通道：把本地图片喂给 OpenAI 兼容 VLM（默认 qwen3.8-flash）做读图问答/双图对比——批量审图不占主会话上下文
  inject: 'tools'
  tools: vision_ask,vision_compare
  runtime: host-only
  envDeps: OpenAI 兼容 VLM 端点（默认 dashscope）+ API key（config → 环境变量 → 凭据文件三级解析）+ 出网
  boundary: 需把图片内容 base64 上送到所配 endpoint（外部服务）；主会话「亲眼看图」应走官方 read_image（原生多模态），本插件是辅助通道
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-vision

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-vision"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-41%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一条**视觉辅助通道**——`vision_ask` 读一张本地图并让 VLM 回答，`vision_compare` 把参照图与生成图一起喂进去要一份异同分析。

**为什么值得用**：批量审图 / 反复对比时，图片**不进主会话上下文**——主会话只收一份结构化文本结论（`{ok, model, answer}`），原始像素留在插件侧。主会话需要「亲眼看图」时仍走官方 `read_image`（原生多模态），两者互补而非替代。

## 能力

| 工具 | 用途 |
|------|------|
| `vision_ask` | 读一张本地图片并用 VLM 回答（`path` 绝对路径；`question` 缺省=详细描述构图/色彩/风格/细节）。返回 `{ok, model, answer}` |
| `vision_compare` | 双图对比：`imageA`（参照/原图）与 `imageB`（对照/生成图）一起喂给 VLM，返回异同分析（主体/构图/色彩/风格/细节） |

两个工具都支持按次覆盖 `model`（不传则用配置默认）。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-vision": "link:<工作区>/self-plugins/dsh-agent-vision"
```

**2) 挂组合**（agent 预设行或 profile 组合；组合行 id 惯用 `agent-agent-vision`）：

```yaml
- id: agent-agent-vision
  name: dsh-agent-vision
  config:
    model: qwen3.8-flash
```

**3) 配 API key**（三级解析，任一命中即可）：`config.apiKey` → 环境变量（`apiKeyEnv`，默认 `QWEN_API_KEY`）→ 凭据文件（`credentialsFile`）。

**4) 30 秒验证**：调 `vision_ask { path: "<绝对路径>/任意一张图片.png" }` → 应返回 `{ok:true, model:"qwen3.8-flash", answer:"…"}`；同时 `tail -1 "$DSH_HOME/vision-trace.jsonl"` 应新增一行 `phase:"ask"`、`ok:true`。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `apiKey` | `""` | 直接配置的 key（最高优先级；**不要把真 key 写进仓库/预设模板**） |
| `apiKeyEnv` | `QWEN_API_KEY` | 从该环境变量取 key |
| `baseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点（换供应商只改这一项） |
| `credentialsFile` | `${DSH_HOME}/.credentials.yaml` | 兜底凭据文件（前两级都拿不到时才读；读失败静默回落空串） |
| `maxTokens` | `1500` | 单次回答 token 上限 |
| `model` | `qwen3.8-flash` | 默认 VLM 模型（工具参数可按次覆盖） |
| `timeoutMs` | `90000` | 单次请求超时（读图/对比同用） |

## 落盘与自证（出问题时先看这里）

每次调用落一行 JSONL 到 **`<DSH_HOME>/vision-trace.jsonl`**：

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载（含配置快照与端点，**不含 key**） |
| `ask` | 单图问答调用 |
| `compare` | 双图对比调用 |

关键字段：`build`（`<版本>@<模块 mtime ms>`）、`model`、`endpoint`、`images`/`imageBytes`、`questionChars`、`answerChars`、`httpStatus`、`durationMs`、`ok`。

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/vision-trace.jsonl"
# ① 跑的是哪个构建   → build = "<版本>@<模块 mtime ms>"
# ② 谁发起/投给谁    → phase + op + model + endpoint（哪个模型、哪台主机）
# ③ 断在哪一段       → phase 枚举 + httpStatus + ok（非 2xx 即端点侧失败）
# ④ 结果质量         → answerChars / questionChars / imageBytes（0 = 图没被读进去）
# ⑤ 耗时与预算       → durationMs vs Config.timeoutMs
```

图片正文与 key **不落盘**——只记字符数/字节数量级。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `tail -1 "$DSH_HOME/vision-trace.jsonl"` 里 `build` 的 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：`vision_ask` 真返回 `ok:true` + 非空 `answer`（**只看工具在不在不够**——key 缺失/端点不通时工具在但必失败）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-agent-vision revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-agent-vision` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：无需回退（无持久业务状态）；轨迹文件可随时删除。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**41 例离线测试**（不联网、不调真实 VLM）：
- `tests/pure.test.mjs` — 纯逻辑层：key 三级解析（config/环境变量/凭据文件，含优先级与空值回落）、模型解析、题面长度、结果摘要
- `tests/contract.test.mjs` — 契约层：工具参数 schema 与返回形状
- `tests/trace.test.mjs` — 轨迹层：路径解析、序列化稳定、容错解析（坏行跳过）、**尸体测试**（不可写路径 → 返回 `false` 且不抛）、端到端接线

**真实外部依赖**：跑通业务需**出网**访问所配 VLM 端点 + 有效 API key；测试本身两者都不需要。

## 设计要点

- **辅助通道定位**：批量/重复审图走本插件（省主会话 token），「亲眼看图」走官方 `read_image`——两套机制不争抢同一职责。
- **key 三级解析 + 单点收口**：解析规则在 `src/pure.ts`（可离线单测），IO 在 `index.ts`；凭据文件只在前面都拿不到时才读，读失败**静默回落空串**（不因缺 key 崩插件）。
- **观测单点落笔**：两个工具的执行体都经同一包装落轨迹——加第三个工具时不会漏掉证据层。
- **只记量级不记正文**：`answerChars`/`questionChars`/`imageBytes` 取代正文——审图结果可能含私人图像内容，轨迹必须可安全 tail。
- **端点可换**：任何 OpenAI 兼容 VLM 只需改 `baseUrl` + `model`；`model` 支持按次覆盖，便于同一会话里对比两个模型。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `comfyui-guidance` | 生图参数与成图评审方法论（`vision_compare` 的典型用途） |
| 技能 `ui-visual-verification` | 界面视觉与交互验收的四类断言（截图复核场景） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
