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

export const name = "agent-agent-vision"
export const inject = ["tools"] as const

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
        const fsP = await import('node:fs/promises')
        const p = String(args.path ?? '').trim()
        if (!p) return { ok: false, error: 'path 为空' }
        let buf: Buffer
        try { buf = await fsP.readFile(p) } catch (e: any) { return { ok: false, error: '读文件失败: ' + errorMessage(e) } }
        if (isOversize(buf.length)) return { ok: false, error: '图片超过 20MB' }
        const mime = mimeOf(p)
        const key = await readKey()
        if (!key) return { ok: false, error: '无可用 API key（config.apiKey / env ' + String(config.apiKeyEnv || 'QWEN_API_KEY') + ' / credentialsFile 三级解析均失败）' }
        const modelName = resolveModel(args.model, config.model)
        const q = resolveQuestion(args.question, DEFAULT_DESCRIBE_QUESTION)
        const body = buildChatBody({ model: modelName, question: q, images: [{ mime, base64: buf.toString('base64') }], maxTokens: Number(config.maxTokens || 1500) })
        try {
          const base = String(config.baseUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(config.timeoutMs || 90000)) })
          const txt = await res.text()
          const parsed = parseChatResponse({ ok: res.ok, status: res.status }, txt)
          if (parsed.kind === 'ok') return { ok: true, model: modelName, answer: parsed.answer }
          if (parsed.kind === 'http') return { ok: false, error: parsed.error, model: modelName }
          return { ok: false, error: parsed.error }
        } catch (e: any) { return { ok: false, error: '请求失败: ' + errorMessage(e) } }
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
          if (isOversize(sa.size) || isOversize(sb.size)) return { ok: false, error: '单图超过 20MB' }
          a = await readImg(pa)
          b2 = await readImg(pb)
        } catch (e: any) { return { ok: false, error: '读图失败: ' + errorMessage(e) } }
        const key = await readKey()
        if (!key) return { ok: false, error: '无可用 API key（三级解析失败）' }
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
          const txt = await res.text()
          const parsed = parseChatResponse({ ok: res.ok, status: res.status }, txt)
          if (parsed.kind === 'ok') return { ok: true, model: modelName, answer: parsed.answer }
          if (parsed.kind === 'http') return { ok: false, error: parsed.error, model: modelName }
          return { ok: false, error: parsed.error }
        } catch (e: any) { return { ok: false, error: '请求失败: ' + errorMessage(e) } }
      },
    }))
}
