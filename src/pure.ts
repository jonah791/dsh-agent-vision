/** dsh-agent-vision · 纯逻辑层（无 IO：文件读取/环境变量/网络由调用方注入）。
 *
 * `vision_ask` / `vision_compare` 两个工具原先各自内联了同一套判定（扩展名→MIME、三级 API key 解析、
 * 20MB 上限、请求体拼装、响应解析），重复两份且无法离线验证。这里收成单一真源；
 * `index.ts` 只留 `fs.readFile` / `process.env` / `fetch` 三处 IO。
 */

/** 单图上限（读文件与 stat 两条路径共用，避免两处各写一个 20MB 漂移）。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export const DEFAULT_DESCRIBE_QUESTION = '请详细描述这张图片：主体与人物特征、姿态表情、服装、构图与视角、色彩光线、艺术风格、背景与次要元素。'
export const DEFAULT_COMPARE_QUESTION = '第一张是原图，第二张是反推提示词重新生成的图。请对比两张图的异同：主体与姿态、服装、构图与镜头、色彩光线、艺术风格、场景细节；并给出还原度总评（0-100）。'

/** 扩展名 → MIME（未知扩展名回落 image/png，保持历史语义）。 */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * 从路径推 MIME。**未知/无扩展名一律回落 image/png**（历史语义：VLM 供应商按 base64 嗅探，
 * 猜错不影响可用性；但 `.bmp` 这类真的不支持的格式会被当成 png 送出去——见 semantic.md §10）。
 */
export function mimeOf(path: string): string {
  const p = String(path)
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'image/png'
}

/** 单图是否超限（边界：恰好 20MB 不算超）。 */
export function isOversize(bytes: number): boolean {
  return Number(bytes) > MAX_IMAGE_BYTES
}

/** 从 `.credentials.yaml` 文本中按 `KEY: value` 取出 `envName` 对应的值（逐行，首个命中即止）。 */
export function keyFromCredentials(text: string, envName: string): string {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const ci = line.indexOf(':')
    if (ci > 0 && line.slice(0, ci).trim() === envName) return line.slice(ci + 1).trim()
  }
  return ''
}

/**
 * API key 三级解析：`config.apiKey` → 环境变量 → 凭据文件文本。
 * 任一级得到**非空字符串**即止（空字符串视为未配置）。
 */
export function resolveApiKey(args: {
  configKey?: string
  envKey?: string | undefined
  credentialsText?: string
  envName: string
}): string {
  let key = String(args.configKey || '')
  if (!key) key = String(args.envKey ?? '')
  if (!key) key = keyFromCredentials(args.credentialsText ?? '', args.envName)
  return key
}

/** 模型名：工具参数 > 配置 > 兜底 `qwen-vl-max`。 */
export function resolveModel(argModel: string | undefined, configModel: string): string {
  return String(argModel || configModel || 'qwen-vl-max')
}

/** 提问文案：工具参数 > 该工具的默认文案。 */
export function resolveQuestion(argQuestion: string | undefined, fallback: string): string {
  return String(argQuestion ?? fallback)
}

/**
 * 请求体拼装（OpenAI 兼容 `/chat/completions`）：文本在前，图片按传入顺序紧随，
 * `detail: 'high'`；data URL 形态 `data:<mime>;base64,<b64>`。
 */
export function buildChatBody(args: {
  model: string
  question: string
  images: ReadonlyArray<{ mime: string; base64: string }>
  maxTokens: number
}): { model: string; messages: Array<{ role: 'user'; content: Array<Record<string, unknown>> }>; max_tokens: number } {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: args.question }]
  for (const img of args.images) {
    content.push({ type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.base64, detail: 'high' } })
  }
  return { model: args.model, messages: [{ role: 'user', content }], max_tokens: args.maxTokens }
}

export type ChatResponseResult =
  | { kind: 'ok'; answer: string }
  | { kind: 'http'; error: string }
  | { kind: 'parse'; error: string }
  | { kind: 'no-content'; error: string }

/**
 * 响应解析（**错误文案逐字保留**历史实现）：
 * - HTTP 非 2xx → `kind:'http'`，`HTTP <status> <正文前 300 字>`
 * - 2xx 但正文不是 JSON → `kind:'parse'`，`请求失败: <JSON.parse 的报错>`
 *   （历史实现让 JSON.parse 抛出、被外层 catch 成「请求失败」——对外文案不变，只是不再靠异常传信号）
 * - 2xx 且 JSON 里没有 `choices[0].message.content` 字符串 → `kind:'no-content'`
 */
export function parseChatResponse(res: { ok: boolean; status: number }, text: string): ChatResponseResult {
  const txt = String(text ?? '')
  if (!res.ok) return { kind: 'http', error: 'HTTP ' + res.status + ' ' + txt.slice(0, 300) }
  let j: unknown
  try {
    j = JSON.parse(txt)
  } catch (e) {
    return { kind: 'parse', error: '请求失败: ' + String((e as Error)?.message ?? e) }
  }
  const answer = (j as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content
  if (typeof answer !== 'string') return { kind: 'no-content', error: '响应无 content: ' + txt.slice(0, 300) }
  return { kind: 'ok', answer }
}

/** 统一的异常→文案（历史实现各处都用 `String(e?.message ?? e)`）。 */
export function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message
  return String(m ?? e)
}
