/**
 * dsh-agent-vision：多模态视觉插件——把本地图片喂给 OpenAI 兼容 VLM 做读图/描述/双图对比。
 * 2026-09-01 起为辅助通道（批量审图/省主会话上下文）；主会话亲眼看图走官方 read_image
 * （qwen3.8-flash 原生多模态，settings.yaml input 声明已开）。默认模型 qwen3.8-flash。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildChatBody, errorMessage, isOversize, MAX_IMAGE_BYTES, mimeOf, parseChatResponse,
  resolveApiKey, resolveModel, resolveQuestion,
  DEFAULT_COMPARE_QUESTION, DEFAULT_DESCRIBE_QUESTION,
} from './pure.ts'
import { fileURLToPath } from 'node:url'
import {
  buildStamp, composeVisionEntry, hostOf, newVisionMeta, questionLength, readPackageVersion,
  visionTrace,
  type VisionRunMeta,
} from './trace.ts'

export const name = "agent-agent-vision"
export const inject = ["tools"] as const

const OWN_FILE = fileURLToPath(import.meta.url)
/** 进程级构建自报 `<version>@<模块 mtime ms>`（Q1：线上跑的是哪个构建）。 */
const BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

export interface Config {
  apiKey: string
  apiKeyEnv: string
  baseUrl: string
  credentialsFile: string
  maxTokens: number
  model: string
  timeoutMs: number
}
export const Config = z.object({
  apiKey: z.string().default(""),
  apiKeyEnv: z.string().default("QWEN_API_KEY"),
  baseUrl: z.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  credentialsFile: z.string().default("E:/alice/.dsh/.credentials.yaml"),
  maxTokens: z.number().default(1500),
  model: z.string().default("qwen3.8-flash"),
  timeoutMs: z.number().default(90000),
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("agent-agent-vision")

  // 三级 API key 解析：config → 环境变量 → 凭据文件（解析规则在 src/pure.ts，可离线单测）；
  // 凭据文件只在前面都拿不到时才读（与历史实现一致），读失败静默回落空串。
  const readKey = async (): Promise<string> => {
    const envName = String(config.apiKeyEnv || 'QWEN_API_KEY')
    const direct = resolveApiKey({ configKey: config.apiKey, envKey: process.env[envName], envName })
    if (direct) return direct
    let credText = ''
    try {
      const fsP = await import('node:fs/promises')
      credText = await fsP.readFile(String(config.credentialsFile || ''), 'utf8')
    } catch { /* 忽略 */ }
    return resolveApiKey({ configKey: config.apiKey, envKey: process.env[envName], credentialsText: credText, envName })
  }

  /**
   * 观测收口（**单点落笔**）：两个工具执行体都经此包装。
   * 执行体只负责在**事实发生处**写观测面 `meta`（stage/imageBytes/httpStatus）——
   * 业务分支一条不动，`meta` 不参与任何判定；落盘只在这一处发生。
   * 业务异常原样重抛（观测层不吞业务错），但先记一笔失败轨迹。
   * **隐私**：`endpoint` 只记主机名、`images`/`error` 落盘前过 `redactText`、绝不记录图片内容或凭据。
   */
  async function visionTraced<R extends { ok: boolean }>(
    phase: 'ask' | 'compare',
    op: string,
    args: { path?: string; imageA?: string; imageB?: string; question?: string; model?: string },
    run: (meta: VisionRunMeta) => Promise<R>,
  ): Promise<R> {
    const meta = newVisionMeta(resolveModel(args.model, config.model))
    meta.questionChars = questionLength(args.question)
    const startedAtMs = Date.now()
    let result: R | undefined
    let thrown: unknown = null
    try {
      result = await run(meta)
    } catch (err) {
      thrown = err
      meta.stage = 'request'
    }
    // 合成与落盘走 composeVisionEntry（纯函数，与单测共用同一真源：路径/主机名/error 的脱敏都在那里）
    visionTrace(composeVisionEntry({
      phase, build: BUILD, op, meta, args, config,
      durationMs: Date.now() - startedAtMs, result, thrown,
    }))
    if (thrown !== null) throw thrown
    return result as R
  }

  ctx.tools.register(defineTool({
      name: "vision_ask",
      description: "读一张本地图片并用 VLM 回答（path 绝对路径；question 缺省=详细描述构图/色彩/风格/细节）。返回 {ok, model, answer}。",
      parameters: {"model":{"type":"string"},"path":{"required":true,"type":"string"},"question":{"type":"string"}},
      output: {
        schema: {"properties":{"answer":{"type":"string"},"error":{"type":"string"},"model":{"type":"string"},"ok":{"type":"boolean","required":true}},"additionalProperties":false,"type":"object"},
        render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? String(v.answer ?? '').slice(0, 2000) : ('VISION_ERROR: ' + String(v.error ?? 'unknown')) }],
      },
      async execute(args: {
  model?: string
  path: string
  question?: string
}) {
        return visionTraced('ask', 'vision_ask', args, async (meta) => {
        const fsP = await import('node:fs/promises')
        const p = String(args.path ?? '').trim()
        if (!p) return { ok: false, error: 'path 为空' }
        let buf: Buffer
        try { buf = await fsP.readFile(p) } catch (e: any) { meta.stage = 'read'; return { ok: false, error: '读文件失败: ' + errorMessage(e) } }
        meta.imageBytes = buf.length
        if (isOversize(buf.length)) { meta.stage = 'size'; return { ok: false, error: '图片超过 20MB' } }
        const mime = mimeOf(p)
        const key = await readKey()
        if (!key) { meta.stage = 'key'; return { ok: false, error: '无可用 API key（config.apiKey / env ' + String(config.apiKeyEnv || 'QWEN_API_KEY') + ' / credentialsFile 三级解析均失败）' } }
        const modelName = resolveModel(args.model, config.model)
        const q = resolveQuestion(args.question, DEFAULT_DESCRIBE_QUESTION)
        const body = buildChatBody({ model: modelName, question: q, images: [{ mime, base64: buf.toString('base64') }], maxTokens: Number(config.maxTokens || 1500) })
        try {
          const base = String(config.baseUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(config.timeoutMs || 90000)) })
          meta.httpStatus = res.status
          const txt = await res.text()
          const parsed = parseChatResponse({ ok: res.ok, status: res.status }, txt)
          if (parsed.kind === 'ok') { meta.stage = 'done'; return { ok: true, model: modelName, answer: parsed.answer } }
          if (parsed.kind === 'http') { meta.stage = 'request'; return { ok: false, error: parsed.error, model: modelName } }
          meta.stage = 'parse'
          return { ok: false, error: parsed.error }
        } catch (e: any) { meta.stage = 'request'; return { ok: false, error: '请求失败: ' + errorMessage(e) } }
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: "vision_compare",
      description: "双图对比：imageA（参照/原图）与 imageB（对照/生成图）一起喂给 VLM，返回异同分析（主体/构图/色彩/风格/细节）。",
      parameters: {"imageA":{"required":true,"type":"string"},"imageB":{"required":true,"type":"string"},"model":{"type":"string"},"question":{"type":"string"}},
      output: {
        schema: {"properties":{"answer":{"type":"string"},"error":{"type":"string"},"model":{"type":"string"},"ok":{"type":"boolean","required":true}},"additionalProperties":false,"type":"object"},
        render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? String(v.answer ?? '').slice(0, 2000) : ('VISION_ERROR: ' + String(v.error ?? 'unknown')) }],
      },
      async execute(args: {
  imageA: string
  imageB: string
  model?: string
  question?: string
}) {
        return visionTraced('compare', 'vision_compare', args, async (meta) => {
        const fsP = await import('node:fs/promises')
        const readImg = async (p: string) => ({ b: await fsP.readFile(p), mime: mimeOf(p) })
        let a: { b: Buffer, mime: string }
        let b2: { b: Buffer, mime: string }
        try {
          const pa = String(args.imageA ?? '').trim()
          const pb = String(args.imageB ?? '').trim()
          if (!pa || !pb) return { ok: false, error: 'imageA/imageB 必填' }
          const sa = await fsP.stat(pa)
          const sb = await fsP.stat(pb)
          if (isOversize(sa.size) || isOversize(sb.size)) { meta.stage = 'size'; return { ok: false, error: '单图超过 20MB' } }
          a = await readImg(pa)
          b2 = await readImg(pb)
          meta.imageBytes = sa.size + sb.size
        } catch (e: any) { meta.stage = 'read'; return { ok: false, error: '读图失败: ' + errorMessage(e) } }
        const key = await readKey()
        if (!key) { meta.stage = 'key'; return { ok: false, error: '无可用 API key（三级解析失败）' } }
        const modelName = resolveModel(args.model, config.model)
        const q = resolveQuestion(args.question, DEFAULT_COMPARE_QUESTION)
        const body = buildChatBody({
          model: modelName,
          question: q,
          images: [
            { mime: a.mime, base64: a.b.toString('base64') },
            { mime: b2.mime, base64: b2.b.toString('base64') },
          ],
          maxTokens: Number(config.maxTokens || 1500),
        })
        try {
          const base = String(config.baseUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(config.timeoutMs || 90000)) })
          meta.httpStatus = res.status
          const txt = await res.text()
          const parsed = parseChatResponse({ ok: res.ok, status: res.status }, txt)
          if (parsed.kind === 'ok') { meta.stage = 'done'; return { ok: true, model: modelName, answer: parsed.answer } }
          if (parsed.kind === 'http') { meta.stage = 'request'; return { ok: false, error: parsed.error, model: modelName } }
          meta.stage = 'parse'
          return { ok: false, error: parsed.error }
        } catch (e: any) { meta.stage = 'request'; return { ok: false, error: '请求失败: ' + errorMessage(e) } }
        })
      },
    }))

  // 进程级构建自报（Q1）：boot 行用中性值填充，字段与调用行完全同形（tail 后可直接读列）。
  visionTrace({
    phase: 'boot', build: BUILD, op: 'apply', stage: 'done',
    model: resolveModel('', config.model), endpoint: hostOf(config.baseUrl),
    images: [], imageBytes: 0, questionChars: 0, answerChars: 0, httpStatus: 0,
    durationMs: 0, ok: true,
  })
}
