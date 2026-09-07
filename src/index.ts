/**
 * dsh-agent-vision：多模态视觉插件——把本地图片喂给 OpenAI 兼容 VLM 做读图/描述/双图对比。
 * 2026-09-01 起为辅助通道（批量审图/省主会话上下文）；主会话亲眼看图走官方 read_image
 * （qwen3.8-flash 原生多模态，settings.yaml input 声明已开）。默认模型 qwen3.8-flash。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
        try { buf = await fsP.readFile(p) } catch (e: any) { return { ok: false, error: '读文件失败: ' + String(e?.message ?? e) } }
        if (buf.length > 20 * 1024 * 1024) return { ok: false, error: '图片超过 20MB' }
        const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
        const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
        const mime = mimeMap[ext] ?? 'image/png'
        let key = String(config.apiKey || '')
        const envName = String(config.apiKeyEnv || 'QWEN_API_KEY')
        if (!key) key = String(process.env[envName] ?? '')
        if (!key) {
          try {
            const txtCred = await fsP.readFile(String(config.credentialsFile || ''), 'utf8')
            for (const line of txtCred.split(/\r?\n/)) {
              const ci = line.indexOf(':')
              if (ci > 0 && line.slice(0, ci).trim() === envName) { key = line.slice(ci + 1).trim(); break }
            }
          } catch { /* 忽略 */ }
        }
        if (!key) return { ok: false, error: '无可用 API key（config.apiKey / env ' + envName + ' / credentialsFile 三级解析均失败）' }
        const modelName = String(args.model || config.model || 'qwen-vl-max')
        const q = String(args.question ?? '请详细描述这张图片：主体与人物特征、姿态表情、服装、构图与视角、色彩光线、艺术风格、背景与次要元素。')
        const content = [
          { type: 'text', text: q },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64'), detail: 'high' } },
        ]
        try {
          const base = String(config.baseUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content }], max_tokens: Number(config.maxTokens || 1500) }), signal: AbortSignal.timeout(Number(config.timeoutMs || 90000)) })
          const txt = await res.text()
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + txt.slice(0, 300), model: modelName }
          const j = JSON.parse(txt)
          const answer = j?.choices?.[0]?.message?.content
          if (typeof answer !== 'string') return { ok: false, error: '响应无 content: ' + txt.slice(0, 300) }
          return { ok: true, model: modelName, answer }
        } catch (e: any) { return { ok: false, error: '请求失败: ' + String(e?.message ?? e) } }
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
        const readImg = async (p: string) => {
          const b = await fsP.readFile(p)
          const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
          return { b, mime: mimeMap[ext] ?? 'image/png' }
        }
        let a: { b: Buffer, mime: string }
        let b2: { b: Buffer, mime: string }
        try {
          const pa = String(args.imageA ?? '').trim()
          const pb = String(args.imageB ?? '').trim()
          if (!pa || !pb) return { ok: false, error: 'imageA/imageB 必填' }
          const sa = await fsP.stat(pa)
          const sb = await fsP.stat(pb)
          if (sa.size > 20 * 1024 * 1024 || sb.size > 20 * 1024 * 1024) return { ok: false, error: '单图超过 20MB' }
          a = await readImg(pa)
          b2 = await readImg(pb)
        } catch (e: any) { return { ok: false, error: '读图失败: ' + String(e?.message ?? e) } }
        let key = String(config.apiKey || '')
        const envName = String(config.apiKeyEnv || 'QWEN_API_KEY')
        if (!key) key = String(process.env[envName] ?? '')
        if (!key) {
          try {
            const txtCred = await fsP.readFile(String(config.credentialsFile || ''), 'utf8')
            for (const line of txtCred.split(/\r?\n/)) {
              const ci = line.indexOf(':')
              if (ci > 0 && line.slice(0, ci).trim() === envName) { key = line.slice(ci + 1).trim(); break }
            }
          } catch { /* 忽略 */ }
        }
        if (!key) return { ok: false, error: '无可用 API key（三级解析失败）' }
        const modelName = String(args.model || config.model || 'qwen-vl-max')
        const q = String(args.question ?? '第一张是原图，第二张是反推提示词重新生成的图。请对比两张图的异同：主体与姿态、服装、构图与镜头、色彩光线、艺术风格、场景细节；并给出还原度总评（0-100）。')
        const content = [
          { type: 'text', text: q },
          { type: 'image_url', image_url: { url: 'data:' + a.mime + ';base64,' + a.b.toString('base64'), detail: 'high' } },
          { type: 'image_url', image_url: { url: 'data:' + b2.mime + ';base64,' + b2.b.toString('base64'), detail: 'high' } },
        ]
        try {
          const base = String(config.baseUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content }], max_tokens: Number(config.maxTokens || 1500) }), signal: AbortSignal.timeout(Number(config.timeoutMs || 90000)) })
          const txt = await res.text()
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + txt.slice(0, 300), model: modelName }
          const j = JSON.parse(txt)
          const answer = j?.choices?.[0]?.message?.content
          if (typeof answer !== 'string') return { ok: false, error: '响应无 content: ' + txt.slice(0, 300) }
          return { ok: true, model: modelName, answer }
        } catch (e: any) { return { ok: false, error: '请求失败: ' + String(e?.message ?? e) } }
      },
    }))
}
