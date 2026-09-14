/**
 * VLM 读图自证轨迹（可维护性 S4 证据层 · 2026-09-14 批次 S4-A）。
 *
 * 动机：`vision_ask` / `vision_compare` 的每次调用有 **6 条早退分支**
 * （path 为空 → 读文件失败 → 超尺寸 → 无 API key → HTTP 失败 → 解析失败）与 1 条成功分支，
 * 但对调用方**全部长一个样**：`VISION_ERROR: <一句文案>`。只写 `ctx.logger`（**宿主 logger 不落盘**）
 * ⇒「昨晚那次是路径写错了、图太大、还是 key 过期」只能靠外部脚本反解会话事件流（AGENTS.md §5.22 规则 1）。
 *
 * 修法：每次调用落一行 JSONL 侧车——`<DSH_HOME>/vision-trace.jsonl`。
 * 阶段枚举：`boot`（进程级构建自报）→ `ask`（vision_ask）→ `compare`（vision_compare）；
 * 断点分类走 `VisionStage` 闭集（见下）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑哪个构建 → `build`（`<version>@<模块 mtime ms>`）
 *   Q2 谁发起         → `phase` + `op` + `model` + `endpoint`（投给哪个模型/哪个主机）
 *   Q3 断在哪一段      → **`stage`（闭集：input/read/size/key/request/parse/done）** + `httpStatus` + `error`
 *   Q4 结果质量        → `answerChars`（回答字符数）+ `questionChars` + `images`/`imageBytes`（按需）
 *   Q5 耗时与预算      → `durationMs`（对照 `Config.timeoutMs`）
 *
 * **隐私红线（本模块的设计重心）**：
 *   ① **绝不记录图片内容**（不记 base64、不记尺寸像素、不记字节样本）——只记路径与字节数；
 *   ② **绝不记录凭据**：`endpoint` 只记**主机名**（`URL.hostname` 天然排除 `user:pass@` 与 `?token=`）；
 *      `error` 与路径落盘前一律过 `redactText`；
 *   ③ 不记 `apiKey`（无论来自 config / env / 凭据文件），也不记其长度/前缀。
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`——写不进去也不影响读图。
 *
 * @module dsh-agent-vision/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举：一次进程从 boot 起，每次调用一行。 */
export type VisionTracePhase = 'boot' | 'ask' | 'compare'

/**
 * 断点分类（闭集）：**Q3 的核心**——「断在哪一段」不是一句笼统 error，而是可聚合的枚举。
 * `input` 参数非法 / `read` 读图失败 / `size` 超限 / `key` 无凭据 /
 * `request` HTTP 或网络失败 / `parse` 响应体不可解析 / `done` 走完全程。
 */
export type VisionStage = 'input' | 'read' | 'size' | 'key' | 'request' | 'parse' | 'done'

/** 一行读图轨迹。字段**固定**（boot 行用中性值填充），便于 `tail` 后直接读列。 */
export interface VisionTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: VisionTracePhase
  /** 构建标识 `<version>@<模块 mtime ms>`（Q1）。 */
  build: string
  /** 工具名（`vision_ask` / `vision_compare` / `apply`）。 */
  op: string
  /** 断点分类（Q3）。 */
  stage: VisionStage
  /** 实际使用的模型名（Q2；由 `resolveModel(args.model, config.model)` 解析）。 */
  model: string
  /** 目标主机名**仅主机**（Q2；`user:pass@` 与查询参数被 `URL.hostname` 天然排除，防凭据落盘）。 */
  endpoint: string
  /** 输入图片路径（Q4；**绝不记录图片内容**）。 */
  images: string[]
  /** 输入图片总字节数（0 = 未读到文件，Q4 量级）。 */
  imageBytes: number
  /** 问题字符数（Q4 输入量级——**只记长度不记内容**）。 */
  questionChars: number
  /** 回答字符数（Q4 质量；失败为 0）。 */
  answerChars: number
  /** HTTP 状态码（0 = 未发出请求，Q3）。 */
  httpStatus: number
  /** 调用耗时（ms；boot=0）。 */
  durationMs: number
  /** 是否成功（工具返回的 `ok`）。 */
  ok: boolean
  /** 失败原因（原样透出工具 error 文案，**已过 `redactText`**）。 */
  error?: string
}

/** 本模块需要的最小配置面。 */
export interface TraceConfig {
  baseUrl: string
  model: string
  timeoutMs: number
}

/** 一次调用的观测面（由执行体填充；纯观测，**不参与任何业务判定**）。 */
export interface VisionRunMeta {
  stage: VisionStage
  model: string
  imageBytes: number
  questionChars: number
  answerChars: number
  httpStatus: number
}

/** 新建观测面（默认值 = 「什么都没发生」，便于测试直接构造）。 */
export function newVisionMeta(model = ''): VisionRunMeta {
  return { stage: 'input', model, imageBytes: 0, questionChars: 0, answerChars: 0, httpStatus: 0 }
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（单一真源——**不要在多处各写一份**）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数）。 */
export function visionTracePath(home: string): string {
  return join(home, 'vision-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 文本截断（摘要用；超长补省略号）。 */
export function truncate(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 凭据脱敏（纯函数，**隐私红线**）：落盘前按形状擦除。
 * 覆盖：显式键值对（`token=` / `api_key:` / `Authorization:`）、`Bearer`、
 * 常见厂商前缀（`sk-` / `ghp_` / `github_pat_` / `AKIA`）、以及 ≥32 位高熵串。
 */
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|passwd|passphrase|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

/**
 * 目标主机名（纯函数，**隐私设计**）：只取 `URL.hostname`——
 * 它**按构造**排除 `user:pass@`（用户信息）与 `?token=…`（查询串），
 * 比「记完整 baseUrl 再擦除」更可靠（擦除是尽力而为，构造排除是必然）。
 * 非法/空 URL → 空串（不抛）。
 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(String(baseUrl ?? '')).hostname
  } catch {
    return ''
  }
}

/** 输入图片路径（纯函数，Q4）：`vision_ask` 取 `path`，`vision_compare` 取 `imageA`/`imageB`。 */
export function describeImages(
  phase: 'ask' | 'compare',
  args: { path?: string; imageA?: string; imageB?: string },
): string[] {
  if (phase === 'ask') {
    const p = String(args.path ?? '').trim()
    return p === '' ? [] : [redactText(p)]
  }
  const out: string[] = []
  for (const raw of [args.imageA, args.imageB]) {
    const p = String(raw ?? '').trim()
    if (p !== '') out.push(redactText(p))
  }
  return out
}

/** 问题字符数（纯函数，Q4）：**只记长度不记内容**（问题里可能含隐私描述）。 */
export function questionLength(question: string | undefined): number {
  return String(question ?? '').length
}

/**
 * 结果摘要（纯函数，Q3/Q4）：工具返回值 → `{ ok, answerChars, error? }`。
 * 脏数据设防（缺陷形状 D4）：`answer` 非字符串、返回体非对象一律不抛。
 */
export function summarizeVisionResult(result: unknown): { ok: boolean; answerChars: number; error?: string } {
  if (result === null || typeof result !== 'object') return { ok: false, answerChars: 0 }
  const r = result as { ok?: unknown; answer?: unknown; error?: unknown }
  const ok = r.ok === true
  const answerChars = typeof r.answer === 'string' ? r.answer.length : 0
  if (ok) return { ok: true, answerChars }
  const error = typeof r.error === 'string' ? redactText(truncate(r.error, 500)) : undefined
  return { ok: false, answerChars, ...(error !== undefined ? { error } : {}) }
}

/** 错误对象 → 人话（非 Error 输入也不抛）。 */
export function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}

/** `composeVisionEntry` 的入参（执行体只填 `meta`，其余由包装器提供）。 */
export interface VisionComposeInput {
  phase: 'ask' | 'compare'
  build: string
  op: string
  /** 观测面（由执行体在事实发生处填充）。 */
  meta: VisionRunMeta
  /** 原始工具入参（用于算路径与问题长度）。 */
  args: { path?: string; imageA?: string; imageB?: string; question?: string }
  /** 配置面（只用 baseUrl——**只取其主机名**）。 */
  config: { baseUrl: string }
  durationMs: number
  /** 工具返回值（未拿到时为 undefined）。 */
  result?: unknown
  /** 抛出的异常（无异常时为 null/undefined）。 */
  thrown?: unknown
}

/**
 * 轨迹行合成（纯函数，**实现与测试共用的单一真源**）：
 * 把「执行体填的观测面 + 返回值/异常 + 入参 + 配置」合成一行轨迹（不含 `atMs`）。
 *
 * 隐私保证在此处成立：`endpoint` 走 `hostOf`（只主机名）、`images` 走 `describeImages`（过 `redactText`）、
 * `error` 走 `redactText` + `truncate`——**图片内容、凭据、请求体都不在合成路径上**。
 */
export function composeVisionEntry(input: VisionComposeInput): Omit<VisionTraceEntry, 'atMs'> {
  const { meta } = input
  const summary = summarizeVisionResult(input.result)
  const thrown = input.thrown === null || input.thrown === undefined ? null : input.thrown
  const error = thrown !== null
    ? redactText(truncate('抛错: ' + messageOf(thrown), 500))
    : summary.error
  return {
    phase: input.phase,
    build: input.build,
    op: input.op,
    stage: meta.stage,
    model: meta.model,
    endpoint: hostOf(input.config.baseUrl),
    images: describeImages(input.phase, input.args),
    imageBytes: meta.imageBytes,
    questionChars: meta.questionChars,
    answerChars: summary.ok ? summary.answerChars : 0,
    httpStatus: meta.httpStatus,
    durationMs: input.durationMs,
    ok: thrown === null && summary.ok,
    ...(error !== undefined ? { error } : {}),
  }
}

/** 稳定序列化（键序固定 + 单行 JSON）。 */
export function serializeTraceEntry(entry: VisionTraceEntry): string {
  const ordered: VisionTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    op: entry.op,
    stage: entry.stage,
    model: entry.model,
    endpoint: entry.endpoint,
    images: entry.images,
    imageBytes: entry.imageBytes,
    questionChars: entry.questionChars,
    answerChars: entry.answerChars,
    httpStatus: entry.httpStatus,
    durationMs: entry.durationMs,
    ok: entry.ok,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛。 */
export function parseTraceEntries(text: string): VisionTraceEntry[] {
  const out: VisionTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as VisionTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): VisionTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：观测绝不反噬读图）。 */
export function appendTraceEntry(path: string, entry: VisionTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔读图轨迹（薄接线：补 atMs，路径缺省 `<DSH_HOME>/vision-trace.jsonl`）。 */
export function visionTrace(
  entry: Omit<VisionTraceEntry, 'atMs'>,
  opts: { path?: string; home?: string; now?: number } = {},
): boolean {
  const path = opts.path ?? visionTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, { atMs: opts.now ?? Date.now(), ...entry })
}
