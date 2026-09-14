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
4. **I4 零落盘**：本插件不写任何侧车文件/日志文件（只有 `ctx.logger` 输出，宿主 logger 不落盘）——**这也是它的可维护性缺口**（§10 U2）。

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
| 外部端点 | `POST {baseUrl}/chat/completions`（`src/index.ts:78` / `:144`） | 每次工具调用 |
| 凭据读取 | `fsp.readFile(config.credentialsFile)`（`src/index.ts:62` / `:127`） | 前两级 key 皆空时 |
| 落盘产物 | **无**（无侧车文件、无缓存、无 outbox） | — |
| 日志 | `ctx.logger("agent-agent-vision")`（引入但**未在实现体中调用**） | 无输出 |

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
| A4 | 不写任何文件（I1/I4） | 调用前后 `stat` 目标盘 `E:\alice\_tmp_review` 的 mtime 与文件数不变 | **待验收** |
| A5 | 当前进程加载的是最新构建 | `lib/index.js` mtime `2026-09-01 20:10:02` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数；本次补课重建后需重新部署核对） |
| A6 | 挂载行存在且唯一 | `grep -n "dsh-agent-vision" .dsh/profiles/web/cordis.patch.yml` → 1 命中（行 227） | 已实测 |
| A7 | 组合行 id 与插件内 `name` 一致 | `npm test` → `入口契约`：断言 `mod.name === 'agent-agent-vision'`（与 patch `id` 逐字绑定）+ patch 侧 `id: agent-agent-vision` | 已实测（2026-09-14，双向） |
| A8 | 失败/退化路径被机器锁住（S6 判据） | `npm test` → 20/20 pass：无扩展名 / 未知扩展名 / CRLF 凭据 / 三级 key 全空 / 非 JSON 响应 / HTTP 500 正文截断 / 缺 content / `undefined` 正文不抛 | 已实测（2026-09-14） |
| A9 | 两个工具共用**同一份**判定（不漂移） | `npm test` → `不变量①：工具接线不得内联判定逻辑`；尸体样本 = 修前内联四段（MIME 映射 / 凭据行解析 / `JSON.parse(txt)` / `20*1024*1024`）必须全被抓出 | 已实测（2026-09-14） |
| A10 | 响应解析无旁路 + HTTP 分支仍带 `model`（历史输出形状） | `npm test` → `不变量②`：`parseChatResponse(` 在 index.ts 出现恰 2 次 + HTTP 分支字面量 | 已实测（2026-09-14） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-agent-vision/src/index.ts`（IO 接线：读图 / 读凭据 / fetch / 工具注册）**+ `src/pure.ts`（纯判定层：`mimeOf` / `keyFromCredentials` / `resolveApiKey` / `resolveModel` / `resolveQuestion` / `buildChatBody` / `parseChatResponse` / `isOversize` / `errorMessage`）**；两者无同语义副本。产物 `lib/index.js` + `lib/pure.js`。测试：`tests/pure.test.mjs` + `tests/contract.test.mjs`（`npm test`，20 例）。
- 未实现/未验证部分**显式标注**：
  - 无自证落盘（无侧车轨迹）→ **A2/A3/A4 只能靠真实调用取证，没有事后可查的日志**（§10 U2）。
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

## 10 · 未决问题

- **U1 第三级模型字面量**：`args.model || config.model || 'qwen-vl-max'` 里的 `'qwen-vl-max'` 与 §4.1 默认 `qwen3.8-flash` 冲突（仅当 config.model 被显式置空时可达）。倾向：删掉该字面量、直接依赖 schemastery 默认值。需实现者裁决。
- **U2 可维护性缺口**：机制不自证（无 `vision-trace.jsonl`、logger 零调用），五问中「断在哪一段/耗时与预算」答不了（§5.22）。倾向：补一行落盘（吞错），但会与 I4「零落盘」冲突——**先裁决 I4 是否要让位**。
- **U3 20MB 闸门与 base64 膨胀**：20MB 原图 → base64 后 ~27MB，是否应按**编码后**体积设闸？需实测 DashScope 上限后裁决。
- **U4（新，2026-09-14）未知扩展名被当 png 送出**：`mimeOf('/tmp/a.bmp')` 返回 `image/png`（历史语义，已用 quirk 用例钉住）。真按 png 送出会让供应商按错误 MIME 解码。是否改为「未知扩展名 → 明确拒绝」待定调（改就是行为变更，会影响当前可用面）。
- **U5（新，2026-09-14）纯空白 key 未 trim**：`config.apiKey = '   '` 会被判为「已配置」并跳过 env/凭据文件回落（`env` 值同理未 trim）——`Bearer    ` → 401。修法一行（各层 `String(x || '').trim()`），但属行为变更，待定调。
- **U6（新，2026-09-14）`errorMessage(undefined)` 产出字符串 `"undefined"`**：调用方会拼成 `读文件失败: undefined`。是否改为兜底文案待定调（已用 quirk 用例钉住现状）。
- **U7（新，2026-09-14）`logger` 仍零调用**（U2 的子项）：本次抽层未动日志面——装载成功/失败仍不可分辨；与 U2 的 I4「零落盘」裁决一并处理。
