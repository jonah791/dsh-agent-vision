/**
 * dsh-agent-vision · 纯逻辑套件（离线、无网络、无文件）。
 *
 * 覆盖正常路径 + 失败/退化路径（空路径、无扩展名、非 JSON 响应、HTTP 错误、
 * 缺 content、超大图边界、三级 key 全失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COMPARE_QUESTION, DEFAULT_DESCRIBE_QUESTION, MAX_IMAGE_BYTES, MIME_BY_EXT,
  buildChatBody, errorMessage, isOversize, keyFromCredentials, mimeOf, parseChatResponse,
  resolveApiKey, resolveModel, resolveQuestion,
} from '../lib/pure.js'

test('mimeOf: 常见扩展名映射（大小写不敏感）', () => {
  assert.equal(mimeOf('/tmp/a.png'), 'image/png')
  assert.equal(mimeOf('/tmp/a.JPG'), 'image/jpeg')
  assert.equal(mimeOf('/tmp/a.jpeg'), 'image/jpeg')
  assert.equal(mimeOf('C:\\pics\\b.WebP'), 'image/webp')
  assert.equal(mimeOf('/tmp/a.gif'), 'image/gif')
})

test('mimeOf: 退化输入——无扩展名 / 未知扩展名 / 空串 一律回落 image/png（历史语义）', () => {
  assert.equal(mimeOf('/tmp/image'), 'image/png', '无点号时 lastIndexOf=-1 → slice(-1) 取末字符，仍回落默认')
  assert.equal(mimeOf(''), 'image/png')
  assert.equal(mimeOf('/tmp/a.bmp'), 'image/png', '未知扩展名（真的不支持的格式）也当 png 送出——登记为 §10 未决')
  assert.equal(mimeOf('/tmp/.hidden'), 'image/png')
})

test('isOversize: 边界——恰好 20MB 不算超，多 1 字节算超', () => {
  assert.equal(isOversize(MAX_IMAGE_BYTES), false)
  assert.equal(isOversize(MAX_IMAGE_BYTES + 1), true)
  assert.equal(isOversize(0), false)
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024, '上限常量必须是 20MiB（两条读图路径共用）')
})

test('keyFromCredentials: 从 YAML 文本按名取值（首个命中即止，值两端去空白）', () => {
  const text = ['# 注释', 'QWEN_API_KEY: sk-abc', 'OTHER: zzz', 'QWEN_API_KEY: sk-later'].join('\n')
  assert.equal(keyFromCredentials(text, 'QWEN_API_KEY'), 'sk-abc')
  assert.equal(keyFromCredentials('QWEN_API_KEY:    sk-spaced   ', 'QWEN_API_KEY'), 'sk-spaced')
})

test('keyFromCredentials: 失败/退化路径——CRLF / 无名行 / 命中但空值 / 名字是子串 都不误取', () => {
  assert.equal(keyFromCredentials('QWEN_API_KEY: sk\r\nOTHER: 1', 'QWEN_API_KEY'), 'sk', 'CRLF 必须处理')
  assert.equal(keyFromCredentials('QWEN_API_KEY:', 'QWEN_API_KEY'), '', '命中但空值 → 空串（视为未配置）')
  assert.equal(keyFromCredentials('QWEN_API_KEY_SUFFIX: sk-x', 'QWEN_API_KEY'), '', '名字必须整体相等，不得前缀命中')
  assert.equal(keyFromCredentials(': orphan', 'QWEN_API_KEY'), '', '冒号在行首（ci=0）不算')
  assert.equal(keyFromCredentials('', 'QWEN_API_KEY'), '')
  assert.equal(keyFromCredentials(undefined, 'QWEN_API_KEY'), '', '坏输入不得抛')
})

test('resolveApiKey: 正常路径——config > env > 凭据文件，逐级回落', () => {
  assert.equal(resolveApiKey({ configKey: 'k1', envKey: 'k2', credentialsText: 'X: k3', envName: 'X' }), 'k1')
  assert.equal(resolveApiKey({ configKey: '', envKey: 'k2', credentialsText: 'X: k3', envName: 'X' }), 'k2')
  assert.equal(resolveApiKey({ configKey: '', envKey: undefined, credentialsText: 'X: k3', envName: 'X' }), 'k3')
})

test('resolveApiKey: 失败路径——三级都空 → 空串（调用方据此返回「无可用 API key」）', () => {
  assert.equal(resolveApiKey({ configKey: '', envKey: '', credentialsText: '', envName: 'X' }), '')
  assert.equal(resolveApiKey({ envName: 'X' }), '')
  assert.equal(resolveApiKey({ configKey: '', envKey: undefined, credentialsText: 'OTHER: k', envName: 'X' }), '')
})

test('resolveApiKey: 文档化 quirk——纯空白值视为已配置（未 trim，登记 §10）', () => {
  // 历史语义：`String(config.apiKey || '')` 对 '   ' 判真 → 不再回落 env。此处钉住现状（未改行为）。
  assert.equal(resolveApiKey({ configKey: '   ', envKey: 'k2', envName: 'X' }), '   ')
})

test('resolveModel / resolveQuestion: 参数 > 配置/默认', () => {
  assert.equal(resolveModel(undefined, 'qwen3.8-flash'), 'qwen3.8-flash')
  assert.equal(resolveModel('arg-model', 'qwen3.8-flash'), 'arg-model')
  assert.equal(resolveModel(undefined, ''), 'qwen-vl-max', '配置也空 → 兜底模型')
  assert.equal(resolveQuestion(undefined, DEFAULT_DESCRIBE_QUESTION), DEFAULT_DESCRIBE_QUESTION)
  assert.equal(resolveQuestion('自定义', DEFAULT_DESCRIBE_QUESTION), '自定义')
  assert.equal(resolveQuestion('', DEFAULT_DESCRIBE_QUESTION), '', '空串是显式参数，不回落默认（现状语义）')
  assert.notEqual(DEFAULT_DESCRIBE_QUESTION, DEFAULT_COMPARE_QUESTION)
})

test('buildChatBody: 单图（describe）——文本在前、图片紧随、detail=high、data URL 形态', () => {
  const body = buildChatBody({ model: 'm1', question: 'q', images: [{ mime: 'image/png', base64: 'AAA' }], maxTokens: 1500 })
  assert.equal(body.model, 'm1')
  assert.equal(body.max_tokens, 1500)
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'q' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'high' } },
  ])
})

test('buildChatBody: 双图（compare）——顺序即 A→B（换序会颠倒「原图/生成图」语义）', () => {
  const body = buildChatBody({
    model: 'm', question: 'q',
    images: [{ mime: 'image/jpeg', base64: 'A' }, { mime: 'image/webp', base64: 'B' }],
    maxTokens: 10,
  })
  const urls = body.messages[0].content.slice(1).map((c) => c.image_url.url)
  assert.deepEqual(urls, ['data:image/jpeg;base64,A', 'data:image/webp;base64,B'])
})

test('buildChatBody: 退化输入——空图列表只出文本（不产出空 image_url）', () => {
  const body = buildChatBody({ model: 'm', question: 'q', images: [], maxTokens: 1 })
  assert.equal(body.messages[0].content.length, 1)
  assert.equal(body.role, undefined)
})

test('parseChatResponse: 正常路径——choices[0].message.content 取出答案', () => {
  const r = parseChatResponse({ ok: true, status: 200 }, JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
  assert.deepEqual(r, { kind: 'ok', answer: 'answer' })
})

test('parseChatResponse: 失败路径——HTTP 非 2xx / 非 JSON / 缺 content 各自可辨识（拒收且带原因）', () => {
  const http = parseChatResponse({ ok: false, status: 500 }, 'x'.repeat(500))
  assert.equal(http.kind, 'http')
  assert.equal(http.error.length, 'HTTP 500 '.length + 300, '正文截断到 300 字')
  const parse = parseChatResponse({ ok: true, status: 200 }, '<html>not json</html>')
  assert.equal(parse.kind, 'parse')
  assert.match(parse.error, /^请求失败: /)
  assert.equal(parseChatResponse({ ok: true, status: 200 }, JSON.stringify({ choices: [] })).kind, 'no-content')
  assert.equal(parseChatResponse({ ok: true, status: 200 }, JSON.stringify({ choices: [{ message: { content: 42 } }] })).kind, 'no-content', 'content 非字符串必须拒收')
  assert.equal(parseChatResponse({ ok: true, status: 200 }, '').kind, 'parse', '空正文不是合法 JSON')
})

test('parseChatResponse: 退化输入——null/undefined 正文不抛（一律分类返回）', () => {
  assert.equal(parseChatResponse({ ok: true, status: 200 }, undefined).kind, 'parse')
  assert.equal(parseChatResponse({ ok: false, status: 401 }, undefined).kind, 'http')
  assert.doesNotThrow(() => parseChatResponse({ ok: true, status: 200 }, null))
})

test('errorMessage: 统一取 message；非 Error 输入原样字符串化（不产出 "undefined"）', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage(undefined), 'undefined', '现状语义：undefined 变字符串（调用方前缀中文标签）')
  assert.equal(errorMessage({ code: 'EACCES' }), '[object Object]')
})
