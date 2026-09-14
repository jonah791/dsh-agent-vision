# 语义文档：dsh-agent-vision（多模态视觉辅助通道）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-vision/src/index.ts`（唯一源文件，154 行；构建产物 `lib/index.js`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-vision（插件内 `name = "agent-agent-vision"`） |
| 主副本路径 | `self-plugins/dsh-agent-vision/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-vision/src/index.ts` |
| 版本 | `package.json` = 0.1.0 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 226–227，`id: agent-agent-vision`，无 config |
| 状态 | **draft**（实现已上线并挂载；本文为 2026-09-14 补课产物） |

---

## 1 · 定位与反定位

**定位**：把**本地图片**喂给 OpenAI 兼容 VLM（默认 DashScope `qwen3.8-flash`），回答「图里是什么」与「两张图差在哪」——2 个工具（`vision_ask` / `vision_compare`），供批量审图与省主会话上下文。

**反定位（本文不管什么）**：
- 不管**主会话亲眼看图**——那条路径是官方 `read_image`（模型原生多模态），本插件只是**辅助通道**（src 头注释明示）
- 不管图片**生成/编辑**（那属于 `dsh-comfyui`）
- 不管**视觉判定标准**——「画风四维怎么评」属于技能 `comfyui-guidance`，本文只定义通道契约
- **不是**图床/缓存层：无落盘、无本地索引、无重试队列

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| VLM | 视觉语言模型；本插件走 OpenAI 兼容 `/chat/completions` 协议 |
| 三级 key 解析 | `config.apiKey` → `process.env[apiKeyEnv]` → `credentialsFile` 按 `KEY: value` 逐行取同名键 |
| `detail: high` | 请求里 image_url 的细节档位（src 固定写死 high） |
| 辅助通道 | 不参与主会话原生多模态链路，仅作工具调用式外挂读图 |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
调用方（爱丽丝 / comfyui-guidance 技能）
   │  vision_ask{path, question?}      vision_compare{imageA, imageB, question?}
   ▼
dsh-agent-vision · apply(ctx, config)
   ├─ 读文件（fsp.readFile / stat）   → 失败即 {ok:false, error:'读文件失败: …'}
   ├─ 尺寸闸门 >20MB                  → {ok:false, error:'图片超过 20MB'}
   ├─ 扩展名 → mime 映射（缺省 image/png）
   ├─ key 三级解析                    → 全失败即 {ok:false, error:'无可用 API key…'}
   └─ fetch POST {baseUrl}/chat/completions
        │  AbortSignal.timeout(config.timeoutMs)
        ├─ !res.ok  → {ok:false, error:'HTTP <status> …', model}
        ├─ 无 content → {ok:false, error:'响应无 content: …'}
        └─ 成功      → {ok:true, model, answer}
   ▼
render：成功截断 2000 字符正文；失败显示 `VISION_ERROR: <error>`
```

不变量（invariants）：
1. **I1 只读输入**：`vision_ask`/`vision_compare` 对文件系统只做读操作，绝不写任何路径（可用「调用前后目标目录 inode/mtime 不变」一次测量判真假）。
2. **I2 尺寸闸门 fail-closed**：单图 >20MB 一定返回 `ok:false`，不发请求（`vision_ask` 按已读 buffer 长度判；`vision_compare` 先 `stat` 判）。
3. **I3 错误即返回值不抛出**：任何失败路径都落在 `{ok:false, error}` 上，工具调用不抛异常。
4. **I4 落盘面收窄（2026-09-14 批次 S4-A 修订；原表述为「零落盘」）**：本插件**不写被检视目标/工作区的任何文件**；
   唯一的写入是**自证侧车** `<DSH_HOME>/vision-trace.jsonl`（§4.4，全部 IO 失败吞错并返回 `bool`）。
   **修订理由（显式裁决）**：原 I4「零落盘」与可维护性纪律（AGENTS.md §5.22 规则 1：关键机制必须落盘自证）
   **正面冲突**，而这个冲突的代价已实测——五问里「断在哪一段 / 耗时与预算 / 是否失败」三问答不了（§10 U2）。
   裁决取向：**保留 I4 的原始意图（不碰被检视对象），放弃其字面表述（绝对零写）**——
   侧车只写宿主自己的状态目录（`<DSH_HOME>`），与 `context-reminder-state.json` / `life-core/state.json` /
   `plugin-boot.jsonl` 同址同约定；A4 的测量口径（**目标盘**文件数与 mtime 不变）**仍然成立**。
   代价：`<DSH_HOME>` 不可写时轨迹静默失败——观测层零业务影响（§7 A14 有尸体测试）。

## 4 · 契约

### 4.1 配置（`Config`，schemastery 默认值）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `apiKey` | string | `""` | 首选 key；空则降级 |
| `apiKeyEnv` | string | `QWEN_API_KEY` | 环境变量名；**也是 credentialsFile 里的键名** |
| `baseUrl` | string | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点（尾部 `/` 被剥除后拼 `/chat/completions`） |
| `credentialsFile` | string | `E:/alice/.dsh/.credentials.yaml` | 第三级：逐行 `KEY: value` 匹配 `apiKeyEnv` |
| `maxTokens` | number | `1500` | 请求 `max_tokens` |
| `model` | string | `qwen3.8-flash` | 默认模型 |
| `timeoutMs` | number | `90000` | 请求超时（`AbortSignal.timeout`） |

### 4.2 工具契约（2 个）

| 工具 | 入参 | 出参 schema | 语义 |
|------|------|-------------|------|
| `vision_ask` | `path`(必填)、`question?`、`model?` | `{ok(必填), model?, answer?, error?}`，`additionalProperties:false` | question 缺省 = 详细描述构图/色彩/风格/细节 |
| `vision_compare` | `imageA`(必填)、`imageB`(必填)、`question?`、`model?` | 同上 | 缺省 question = 对比异同 + 还原度总评 0–100 |

mime 映射：`.png→image/png`、`.jpg/.jpeg→image/jpeg`、`.webp→image/webp`、`.gif→image/gif`，**其它扩展名缺省按 `image/png`**（I2 之外的另一处「默认放行」）。
模型解析：`args.model || config.model || 'qwen-vl-max'`（第三个字面量仅在 config.model 被显式置空时可达，与 §4.1 默认值不一致，见 U1）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:226`（`id: agent-agent-vision` + `name: dsh-agent-vision`） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:apply()` → `ctx.tools.register(defineTool({name:'vision_ask'…}))` | 装载时一次性注册 |
| 插件自身 | `src/index.ts:apply()` → `ctx.tools.register(defineTool({name:'vision_compare'…}))` | 同上 |
| 依赖服务声明 | `src/index.ts:inject = ['tools']` | cordis 激活门（缺 tools 服务则插件不激活） |
| 技能（消费方） | `alice-self-assets/skills/comfyui-guidance/SKILL.md:422`（「评估用 vision_ask（画风四维…）」） | 画风评估/批量审图 |
| 外部端点 | `POST {baseUrl}/chat/completions`（`src/index.ts:126` / `:184`） | 每次工具调用 |
| 凭据读取 | `fsp.readFile(config.credentialsFile)`（`src/index.ts:readKey()`） | 前两级 key 皆空时 |
| 落盘产物 | `<DSH_HOME>/vision-trace.jsonl`（自证侧车，2026-09-14 批次 S4-A 新增，见 §4.4） | 每次 `apply()` + 每次工具调用 |
| 日志 | `ctx.logger("agent-agent-vision")`（引入但**未在实现体中调用**） | 无输出 |

### 4.4 自证轨迹契约（`<DSH_HOME>/vision-trace.jsonl`）`[MUST]`

**动机**：本插件有 **6 条早退分支 + 1 条成功分支**，对调用方**全部长一个样**（`VISION_ERROR: <一句文案>`），
而 `ctx.logger` **不落盘** ⇒ 「昨晚那次是路径写错了、图太大、还是 key 过期」只能靠外部脚本反解会话事件流
（AGENTS.md §5.22 规则 1）。本插件的 I4 因此被显式修订（§3 第 4 条）。

- **落盘路径**：`<DSH_HOME>/vision-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`；
  解析走 `src/trace.ts:resolveHome` **单一真源**）。追加式 JSONL，一行一事件。
- **阶段枚举**（`VisionTracePhase`，闭集）：`boot`（`apply()` 进程级构建自报）
  → `ask`（`vision_ask`）→ `compare`（`vision_compare`）。
- **断点枚举**（`VisionStage`，闭集，**Q3 的核心**）：
  `input`（参数非法，如空 path）→ `read`（读图失败）→ `size`（超 20MB）→ `key`（无可用 API key）
  → `request`（HTTP 非 2xx / 网络异常 / 抛错）→ `parse`（响应体不可解析）→ `done`（走完全程）。
- **行 schema**（字段固定，`boot` 行用中性值填充，`tail` 后可直接读列）：

  | 字段 | 含义 | 回答哪一问 |
  |------|------|-----------|
  | `atMs` | 写入时刻（ms epoch） | 时间线 join |
  | `phase` | `boot` / `ask` / `compare` | Q2 谁发起 |
  | `build` | `<version>@<模块 mtime ms>` | **Q1 线上跑的是哪个构建** |
  | `op` | `vision_ask` / `vision_compare` / `apply` | Q2 |
  | `stage` | 断点枚举（见上） | **Q3 断在哪一段** |
  | `model` | 实际模型名（`resolveModel(args.model, config.model)`） | **Q2 投给哪个模型** |
  | `endpoint` | 目标**主机名**（`hostOf`，见隐私） | Q2 |
  | `images` | 调用方给的图片路径（**过 `redactText`**） | Q4 |
  | `imageBytes` | 输入图片总字节数（0 = 未读到） | Q4 |
  | `questionChars` | 问题**字符数**（**只记长度不记内容**） | Q4 |
  | `answerChars` | 回答字符数（失败为 0） | **Q4 结果质量** |
  | `httpStatus` | HTTP 状态码（0 = 未发出请求） | Q3 |
  | `durationMs` | 调用耗时（ms） | Q5 |
  | `ok` | 工具返回的 `ok` | Q3 |
  | `error?` | 工具 error 文案（**过 `redactText` + 截断 500**） | Q3 |

- **隐私红线（本模块的设计重心，三条都是构造性保证而非尽力而为）**：
  ① **绝不记录图片内容**——不记 base64、不记像素、不记字节样本，只记路径与字节数（§7 A16 断言轨迹行长度上界）；
  ② **绝不记录凭据**——`endpoint` 只取 `new URL(baseUrl).hostname`，**按构造**排除 `user:pass@`（用户信息）
     与 `?token=…`（查询串）；`apiKey` 无论来自 config / env / 凭据文件都不记（连长度/前缀都不记）；
  ③ 路径与 error 落盘前一律过 `redactText`（§7 A15 隐私尸体测试端到端验证三者）。
- **不变量**：① **`stage` 闭集**——「断在哪一段」是可聚合的枚举，不是自由文本；
  ② **观测绝不反噬主流程**——`appendTraceEntry` 全部 IO 失败吞错并返回 `false`；
     业务异常**原样重抛**（观测层不吞业务错，但先记一笔失败轨迹）；
  ③ **业务返回形状逐字不变**（`stage`/`meta` 只存在于轨迹，绝不进工具返回值——output.schema 是
     `additionalProperties: false`，混入即校验失败）。
- **调用点清单**：`src/index.ts:110` / `:153` `visionTraced(...)`（**唯一收口**，包住两个执行体）
  + `src/index.ts:198` boot 行。**新增工具必须经 `visionTraced()` 落笔**——绕开它 = 新的观测盲区。
  执行体只负责在**事实发生处**写观测面 `meta`（`stage`/`imageBytes`/`httpStatus`）；合成与落盘收在
  `src/trace.ts:composeVisionEntry`（纯函数，**实现与单测共用同一真源**——测试驱动真实合成逻辑，
  而不是照抄一份「我以为是那样」的判定）。
- **查询方式**：`tail -3 <DSH_HOME>/vision-trace.jsonl`（最近三次调用的五问）。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本插件能读**任意路径**的文件（只要 web 进程权限允许）并把内容 base64 外发给 `baseUrl`。它**不做**路径白名单、不做敏感图过滤、不做网络出口限制——**读图范围 = 进程权限范围**。
- 不越界清单：不写文件、不改配置、不建索引、不重试、不自动清理、不代理其它工具。
- 失败面（逐类必选其一，无静默分支）：
  - 读失败 → `{ok:false, error:'读文件失败: …'}`（**拒绝 + 报错**）
  - 超尺寸 → `{ok:false, error:'图片超过 20MB'}`（拒绝 + 报错）
  - 无 key → `{ok:false, error:'无可用 API key（config.apiKey / env … / credentialsFile 三级解析均失败）'}`（拒绝 + 报错）
  - `credentialsFile` 读失败 → **静默忽略**（`catch { /* 忽略 */ }`，`src/index.ts:67`）——这是唯一一处静默，语义上等价「该级无 key」，由更下层的「无 key」错误兜住，可接受但需登记。
  - HTTP 非 2xx / 无 content / 网络异常 → 各自 `{ok:false, error:'HTTP …' / '响应无 content: …' / '请求失败: …'}`（拒绝 + 报错）
- 凭据纪律：key 只经内存与请求头，**不落盘、不进日志**（符合 AGENTS.md 记忆边界「凭据不落盘」）。

## 6 · 与既有机制的关系

- **AGENTS.md**：本插件属「辅助通道」定位，与 §5.9「验证不交还用户」互补——它能**批量**看，但主会话的最终视觉裁量仍可走官方 `read_image`。
- **组合变更纪律（§5.11）**：改本插件源码 = 组合变更；改完必须重建 + 完整预检 + 重启。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：比对 `self-plugins/dsh-agent-vision/lib/index.js` mtime 与 **3080 监听进程启动时间**——产物必须早于进程启动，否则线上跑的是旧构建（§5.11 第 6 条）。本轮实测：lib = `2026-09-01 20:10:02`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **产物早于进程，判为已生效**。
  2. 工具级：调用一次 `vision_ask`（真实本地图片），返回 `ok:true` 且 `answer` 非空（或返回可判读的 `VISION_ERROR`）证明注册与调用链活着。
  3. 组合级：`.preflight-invoked.json` 的 `atMs` 在调用 `preflight_check` 后必须前进（证明预检真跑了，不是短路）。
- **回退（出问题怎么退）**：
  1. 运行期：从组合移除该行（`plugin_stop` / 手工删 patch 行）+ 哨兵重启——**不删源码**，保留留痕。
  2. 代码级：`git -C E:/alice/self-plugins/dsh-agent-vision log --oneline` 找上一个好提交 → `git revert <sha>`（或 `checkout <sha> -- src/`）→ `pnpm build` → 预检 → 哨兵重启。
  3. 配置级：错误只可能来自 `config.apiKey/baseUrl/model`；配置改动走 `plugin_configure`（自带预检 + 哨兵重启），改回旧值即回退。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 2 个（`vision_ask`、`vision_compare`） | 会话工具列表中检索 `vision_` 前缀命中 2 条；源码 `ctx.tools.register` 计数 = 2 | 已实测（源码计数） |
| A2 | 单图 >20MB 必被拒 | `npm test` → `isOversize: 边界——恰好 20MB 不算超，多 1 字节算超`（纯逻辑层）；端到端仍需造 21MB PNG 真调一次 | 纯逻辑**已实测**（2026-09-14）；端到端待验收 |
| A3 | 三级 key 解析顺序生效 | `npm test` → `resolveApiKey` 4 条用例（config > env > 凭据文件 / 三级皆空 → 空串 / 子串名不误取 / CRLF） | 已实测（2026-09-14，离线层） |
| A4 | **不写被检视目标/工作区**（I1；I4 已于 2026-09-14 收窄为「只写 `<DSH_HOME>` 侧车」，见 §3） | 调用前后 `stat` 目标盘 `E:\alice\_tmp_review` 的 mtime 与文件数不变；另：唯一的写入点由 `tests/trace.test.mjs` 钉住为 `<DSH_HOME>/vision-trace.jsonl`（落盘路径纯函数） | **待验收**（目标盘部分需真机；侧车路径已由单测钉住） |
| A5 | 当前进程加载的是最新构建 | `lib/index.js` mtime `2026-09-01 20:10:02` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数；本次补课重建后需重新部署核对） |
| A6 | 挂载行存在且唯一 | `grep -n "dsh-agent-vision" .dsh/profiles/web/cordis.patch.yml` → 1 命中（行 227） | 已实测 |
| A7 | 组合行 id 与插件内 `name` 一致 | `npm test` → `入口契约`：断言 `mod.name === 'agent-agent-vision'`（与 patch `id` 逐字绑定）+ patch 侧 `id: agent-agent-vision` | 已实测（2026-09-14，双向） |
| A8 | 失败/退化路径被机器锁住（S6 判据） | `npm test` → 20/20 pass：无扩展名 / 未知扩展名 / CRLF 凭据 / 三级 key 全空 / 非 JSON 响应 / HTTP 500 正文截断 / 缺 content / `undefined` 正文不抛 | 已实测（2026-09-14） |
| A9 | 两个工具共用**同一份**判定（不漂移） | `npm test` → `不变量①：工具接线不得内联判定逻辑`；尸体样本 = 修前内联四段（MIME 映射 / 凭据行解析 / `JSON.parse(txt)` / `20*1024*1024`）必须全被抓出 | 已实测（2026-09-14） |
| A10 | 响应解析无旁路 + HTTP 分支仍带 `model`（历史输出形状） | `npm test` → `不变量②`：`parseChatResponse(` 在 index.ts 出现恰 2 次 + **两条 HTTP 分支** + **两次**带 model 的错误返回（2026-09-14 批次 S4-A 改为锚定独立事实，比原单次 `assert.match` 更强，见 §9） | 已实测（2026-09-14） |
| A11 | 每次调用落一行自证轨迹（五问可一条命令答） | `npm test` → `tests/trace.test.mjs:离线组合` 真写出 7 行；线上：`tail -3 $DSH_HOME/vision-trace.jsonl` 可读 `build/op/stage/model/endpoint/images/imageBytes/questionChars/answerChars/httpStatus/durationMs/ok` | **待线上验收**（离线已锁；本批不部署，由派发者统一部署） |
| A12 | **7 条分支的断点分类可判**（`stage` 闭集） | `npm test` → `composeVisionEntry`（真实合成函数）逐分支断言 + 离线组合断言 stage 序列恰为 `['input','read','size','key','request','parse','done']` | **已实测（离线）** |
| A13 | 观测绝不反噬主流程（IO 失败不抛） | `npm test` → `尸体测试：父路径是普通文件 → 返回 false 且不抛`（`assert.doesNotThrow` + `=== false`） | **已实测** |
| A14 | 观测层失败/异常不改变业务返回 | `composeVisionEntry` 的 `thrown` 分支：`ok=false` + `error` 前缀 `抛错: `；包装器随后**原样重抛**（业务异常不被观测层吞掉） | **已实测（离线）** |
| A15 | **凭据不落盘**（隐私红线，端到端尸体测试） | `npm test` → `隐私尸体测试端到端`：图片路径含 `sk-live-…`、error 含 `Bearer <32位>`、`baseUrl` 含 `user:p@ssw0rd@…?api_key=hunter2secret` → 断言落盘原文 `includes(secret) === false`（逐个），且 `[redacted]` 确实出现、`endpoint === 'api.example.com'` | **已实测** |
| A16 | **绝不记录图片内容** | `npm test` → `隐私保证：轨迹行里绝不出现图片内容`：构造一行并断言 `line.length < 600` 且不含 `base64`（图片 base64 必然远超此上界） | **已实测** |
| A17 | 断点判定的最小真源可离线驱动 | `npm test` → 包装器是 `apply` 内闭包（依赖 cordis ctx）不可离线调用，故测试直接驱动它调用的**同一** `composeVisionEntry`——避免测试里出现第二份判定逻辑（技能 C2 判据单一真源） | **已实测** |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-agent-vision/src/index.ts`（IO 接线：读图 / 读凭据 / fetch / 工具注册）**+ `src/pure.ts`（纯判定层：`mimeOf` / `keyFromCredentials` / `resolveApiKey` / `resolveModel` / `resolveQuestion` / `buildChatBody` / `parseChatResponse` / `isOversize` / `errorMessage`）+ `src/trace.ts`（自证轨迹层：`resolveHome` / `hostOf` / `redactText` / `describeImages` / `summarizeVisionResult` / **`composeVisionEntry`**（合成单一真源）+ 薄 IO，2026-09-14 批次 S4-A 新增）**；三者无同语义副本。产物 `lib/index.js` + `lib/pure.js` + `lib/trace.js`。测试：`tests/pure.test.mjs`（16）+ `tests/contract.test.mjs`（4）+ `tests/trace.test.mjs`（**21**）（`npm test`，**41 例**）。
- 未实现/未验证部分**显式标注**：
  - **自证落盘已补（2026-09-14 批次 S4-A）**：`<DSH_HOME>/vision-trace.jsonl`（§4.4），五问可一条命令答。
    此前「无侧车 ⇒ A2/A3/A4 只能靠真实调用取证」的缺口已闭环（§10 U2）。**仍待线上验收**：
    本批不部署（由派发者统一部署），轨迹行尚未在真实 web 进程里产出。
  - **I4 被显式修订**（§3 第 4 条）：原「零落盘」与 §5.22 规则 1 冲突——裁决为「保留不碰被检视对象的意图，
    放弃绝对零写的字面表述」。这是本批**唯一一处不变量级别的语义变更**，理由与代价已写在 §3。
  - `ctx.logger` 已创建但实现体内零调用 → 装载成功/失败在日志里**不可分辨**。
  - README 未记载 `baseUrl/model/maxTokens/timeoutMs/credentialsFile` 等配置字段（README 只列 `model`）——文档缺口，属 README 范畴，本文件未回改 README。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：辅助通道定位（主会话走官方 `read_image`）；2 工具；三级 key 解析；20MB 闸门。
  - 语义**被补充**：组合挂载点（patch 行 226–227）、消费方技能（`comfyui-guidance` 行 422）、「零落盘」这一事实与其作为可维护性缺口的判定。
  - 语义**被修正**：无（此前无文档，无旧表述可推翻）。
  - 教训（同时回写技能 `semantic-doc-first`）：**「无落盘 = 无自证」本身就是一条必须写进语义文档的边界**——否则下一次排障会默认「有日志可查」。
- **2026-09-14 · 可维护性补课（S3 有测试 / S6 失败路径）：判定逻辑收成单一真源 + 20 例回归**
  - **抽层（行为不变的搬家）**：新增 `src/pure.ts` —— 两个工具原先**各内联一份**的判定（MIME 映射、20MB 常量、三级 key 解析、请求体拼装、响应解析）收成单一真源：`mimeOf` / `keyFromCredentials` / `resolveApiKey` / `resolveModel` / `resolveQuestion` / `buildChatBody` / `parseChatResponse` / `isOversize` / `errorMessage` + 三个默认文案常量。`index.ts` 只留 IO（`import('node:fs/promises')` / `process.env` / `fetch`）。
  - **语义被确认**：错误文案**逐字保留**（`读文件失败: ` / `图片超过 20MB` / `无可用 API key（…三级解析均失败）` / `HTTP <status> <300 字>` / `响应无 content: ` / `请求失败: `），输出形状不变（HTTP 分支带 `model`、其余错误分支不带）。
  - **机制变更（显式列出，对外可见结果相同）**：`parseChatResponse` 把「2xx 但正文非 JSON」从**抛出异常由外层 catch 成 `请求失败:`**改为**函数内直接返回 `请求失败: <parse 报错>`**（文案一致，只是不再靠异常传信号）。好处：该路径可离线断言（此前只能靠真网络）。
  - **行为变更（显式列出，仅此一条）**：`resolveApiKey` 的凭据文件读取路径改为「前两级皆空时才读」——**与历史实现一致**；差异仅在实现结构（原来在读文件前先做一次 `String(config.apiKey || '')`）。读失败仍静默回落（`catch {}`），由下层「无可用 API key」兜住。**无功能改动**。
  - **语义被补充（新不变量 ①）**：**判定逻辑单一真源**——工具接线不得内联 MIME 映射 / 凭据行解析 / `JSON.parse(txt)` / `20*1024*1024`（两份内联必然漂移）。由 `tests/contract.test.mjs` 守卫，尸体样本 = 修前那四段内联片段必须全被抓出（已实测），并反向断言检测器模式在真源上可命中（防空转）。
  - **语义被补充（新不变量 ②）**：**入口命名契约**——`export const name = "agent-agent-vision"`（双前缀）与 profile patch 的 `- id: agent-agent-vision`（`.dsh/profiles/web/cordis.patch.yml:226`）**逐字绑定**；「顺手修正」成 `agent-vision` 会让组合行失配。已用测试断言钉住。
  - **语义被确认（未改）**：`mimeOf` 对无扩展名/未知扩展名回落 `image/png`（`.bmp` 会被当 png 送出）；`resolveApiKey` 对纯空白 config 值判为「已配置」（未 trim）——两条都用「文档化 quirk」用例钉住现状，风险登记 §10。
  - **教训**：同构工具函数（`vision_ask`/`vision_compare`）的**重复内联**是可测性的头号敌人——重复的那一份既不会被测到，也不会在改另一份时被想起。抽单一真源后，20 例秒级回归覆盖了原先只能靠真调网才能碰到的分支。

- **2026-09-14 · 批次 S4-A：自证轨迹层（观测层新增；**唯一一处不变量修订 = I4**）**
  - **语义被修订（I4，显式裁决）**：原 I4「零落盘」**与 §5.22 规则 1 正面冲突**，且冲突代价已实测——
    五问里三问答不了（U2）。裁决为「保留原始意图（不碰被检视对象），放弃字面表述（绝对零写）」；
    唯一写入点收窄为 `<DSH_HOME>/vision-trace.jsonl`。**A4 的测量口径（目标盘不变）仍然成立**。
    记录取向的理由：**纪律冲突要显式裁决并留痕，不能两边都写**——否则文档自相矛盾，下一次排障时
    会拿「I4 说零落盘」当证据去否定轨迹的存在。
  - **语义被补充（新不变量 ③）**：**断点必须是闭集枚举而不是自由文本**。本插件有 6 条早退分支，
    此前它们的**唯一外部表征**都是 `VISION_ERROR: <文案>`——文案会改、会被翻译、会被拼接，
    故「断在哪一段」不能靠文案辨认，必须有 `VisionStage` 闭集（`input/read/size/key/request/parse/done`）。
  - **语义被补充（隐私的构造性保证）**：原 §5「凭据纪律」只是一句承诺（「key 不落盘、不进日志」）。
    本批把它升级为**构造性**的三条：① 图片只记路径与字节数（不记内容）；② `endpoint` 用
    `URL.hostname` 取主机名——**按构造**排除 `user:pass@` 与 `?token=`（比「记完整 URL 再擦除」可靠，
    擦除是尽力而为）；③ 路径与 error 过 `redactText`。并配端到端隐私尸体测试（A15）+ 行长度上界断言（A16）。
  - **语义被修正（我自己的预期错 / 契约测试的字面耦合）**：`tests/contract.test.mjs:不变量②` 原先把
    「HTTP 分支 + 返回形状」写成**一个连续字面量**（`kind === 'http') return { … }`）。观测层给该分支加
    `{ meta.stage = 'request'; … }` 外壳后字面量失配——**守卫意图（HTTP 分支必须带 `model`）完全未变**。
    处置：改为锚定**两个独立事实**（两条 `kind === 'http')` + 两次带 `model` 的错误返回），
    **比原来更强**（原断言只 `match` 一次，对第二个工具是盲的），且不再绑在语法糖上。
    **不得**为过测试而删断言或放松强度。
  - **行为变更清单**：**无**——`git diff -U1 src/index.ts` 逐行核对：所有 `-`/`+` 配对**只是插入
    `meta.*` 赋值**，原语句逐字未动；`stage` 只活在轨迹里，**绝不进工具返回值**
    （output.schema 是 `additionalProperties: false`，混入即校验失败）。
  - **教训**：**契约测试不要断言「源码的连续字面量」**——它把守卫绑在了与语义无关的语法糖上
    （同一类问题在 §5.22 的「措辞匹配游戏」里出现过）。守卫应锚定**独立的事实**，越接近语义越耐用。

## 10 · 未决问题

- **U1 第三级模型字面量**：`args.model || config.model || 'qwen-vl-max'` 里的 `'qwen-vl-max'` 与 §4.1 默认 `qwen3.8-flash` 冲突（仅当 config.model 被显式置空时可达）。倾向：删掉该字面量、直接依赖 schemastery 默认值。需实现者裁决。
- **U2 可维护性缺口（✅ 已闭环 2026-09-14 批次 S4-A）**：机制不自证（无 `vision-trace.jsonl`、logger 零调用），
  五问中「断在哪一段/耗时与预算」答不了（§5.22）。**已按倾向实现**：`<DSH_HOME>/vision-trace.jsonl`（§4.4）。
  **I4 的裁决结果**：收窄为「不写被检视对象，只写 `<DSH_HOME>` 侧车」（§3 第 4 条）——
  即原 U2 悬置的「I4 是否要让位」问题**已裁决**：让位的是字面表述，不是意图。
  **遗留**：需一次线上验收（真实 web 进程里 `tail` 出轨迹行）。
- **U3 20MB 闸门与 base64 膨胀**：20MB 原图 → base64 后 ~27MB，是否应按**编码后**体积设闸？需实测 DashScope 上限后裁决。
- **U4（新，2026-09-14）未知扩展名被当 png 送出**：`mimeOf('/tmp/a.bmp')` 返回 `image/png`（历史语义，已用 quirk 用例钉住）。真按 png 送出会让供应商按错误 MIME 解码。是否改为「未知扩展名 → 明确拒绝」待定调（改就是行为变更，会影响当前可用面）。
- **U5（新，2026-09-14）纯空白 key 未 trim**：`config.apiKey = '   '` 会被判为「已配置」并跳过 env/凭据文件回落（`env` 值同理未 trim）——`Bearer    ` → 401。修法一行（各层 `String(x || '').trim()`），但属行为变更，待定调。
- **U6（新，2026-09-14）`errorMessage(undefined)` 产出字符串 `"undefined"`**：调用方会拼成 `读文件失败: undefined`。是否改为兜底文案待定调（已用 quirk 用例钉住现状）。
- **U7（新，2026-09-14）`logger` 仍零调用**（U2 的子项）：本次抽层未动日志面——装载成功/失败仍不可分辨；与 U2 的 I4「零落盘」裁决一并处理。**更新（批次 S4-A）**：装载面已由 `boot` 轨迹行覆盖（构建自报），故「装载是否发生」现在可查；`ctx.logger` 仍零调用，但**不再是唯一的装载证据**。
- **U8（新，2026-09-14 批次 S4-A）轨迹文件无轮转**：`vision-trace.jsonl` 为纯追加，无上界。
  本插件调用频率低（辅助通道），短期无风险；长期应按 `dsh-plugin-bootreport` 的「有界裁剪（`keepLines + 50`）」
  加上限，断言写「有界」而非「恰好等于」。需裁决是否本轮补。
- **U9（新，2026-09-14 批次 S4-A）`questionChars` 记的是「调用方给的原始长度」**：执行体真正发出的是
  `resolveQuestion(args.question, DEFAULT_*)` 的结果（缺省文案被补上时更长）。取舍：原始长度对
  「模型这次问得多细」更有解释力，且**不落问题内容**（隐私）；若要精确对齐请求体长度需再取一次 `q.length`。
  倾向：保持现状（Q4 的价值在**量级对照**，不在精确值），但登记以求裁决。

## 附 · 快速取证命令

```bash
# Q1–Q5 一条命令（最近三次调用）
tail -3 "$DSH_HOME/vision-trace.jsonl"
# 只看失败笔次并按断点聚合（Q3：哪一段最常断）
grep '"ok":false' "$DSH_HOME/vision-trace.jsonl" | grep -o '"stage":"[a-z]*"' | sort | uniq -c | sort -rn
# 只看慢调用（Q5：对照 config.timeoutMs = 90000）
grep -o '"durationMs":[0-9]*' "$DSH_HOME/vision-trace.jsonl" | awk -F: '$2 > 30000' | tail -5
```
