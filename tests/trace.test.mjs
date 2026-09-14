/**
 * VLM 读图轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：纯函数（路径 / 截断 / 脱敏 / **主机名提取** / 图片描述 / 问题长度 / 结果摘要 /
 * **轨迹行合成 composeVisionEntry** / 序列化 / 解析）
 * + 真实落盘与回读 + 退化路径（脏数据/坏行/半行/空文件/缺失文件/目录误当文件/非法 URL）
 * + **尸体测试**（父路径是普通文件 → false 且不抛）
 * + **隐私尸体测试**（图片路径含凭据 + error 含 token + baseUrl 含 userinfo/query → 落盘行里搜不到）
 * + 一条离线组合（**用真实合成函数**复刻 7 条分支的断点分类）。
 *
 * 说明：包装器 `visionTraced` 是 `apply` 内的闭包（依赖 cordis ctx），不可离线调用；
 * 故本测试直接驱动它调用的**同一**合成函数 `composeVisionEntry`——实现与测试共用单一真源，
 * 而不是在测试里照抄一份「我以为是那样」的判定逻辑（技能 C2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTraceEntry,
  buildStamp,
  composeVisionEntry,
  describeImages,
  hostOf,
  mtimeOf,
  newVisionMeta,
  parseTraceEntries,
  questionLength,
  readPackageVersion,
  readTraceEntries,
  redactText,
  resolveHome,
  serializeTraceEntry,
  summarizeVisionResult,
  truncate,
  visionTrace,
  visionTracePath,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'vision-trace-test-'))
const CFG = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-flash' }
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'ask',
  build: '0.1.0@123',
  op: 'vision_ask',
  stage: 'done',
  model: 'qwen3.8-flash',
  endpoint: 'dashscope.aliyuncs.com',
  images: ['E:/alice/_tmp_review/a.png'],
  imageBytes: 2048,
  questionChars: 12,
  answerChars: 300,
  httpStatus: 200,
  durationMs: 1500,
  ok: true,
  ...entry,
})

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '  ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('visionTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(visionTracePath('/h/.dsh'), join('/h', '.dsh', 'vision-trace.jsonl'))
})

test('newVisionMeta：默认 = 「什么都没发生」（stage=input，其余 0）', () => {
  assert.deepEqual(newVisionMeta('m'), {
    stage: 'input', model: 'm', imageBytes: 0, questionChars: 0, answerChars: 0, httpStatus: 0,
  })
})

test('truncate / redactText：截断与凭据擦除（普通路径与文案不误伤）', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(redactText('Bearer sk-live-abcdefgh'), 'Bearer [redacted]')
  assert.equal(redactText('api_key=hunter2secret'), 'api_key=[redacted]')
  assert.equal(redactText('a'.repeat(40)), '[redacted]')
  assert.equal(redactText('VISION_ERROR: 读文件失败'), 'VISION_ERROR: 读文件失败')
  assert.equal(redactText('E:/alice/_tmp_review/a.png'), 'E:/alice/_tmp_review/a.png')
})

test('hostOf：只取主机名——userinfo 与查询串被 URL.hostname 按构造排除（隐私关键）', () => {
  assert.equal(hostOf('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'dashscope.aliyuncs.com')
  // 带凭据的 URL：绝不把 user:pass 或 ?token= 落盘
  assert.equal(hostOf('https://user:pass@api.example.com/v1'), 'api.example.com')
  assert.equal(hostOf('https://api.example.com/v1?api_key=sk-live-abcdefgh'), 'api.example.com')
  assert.equal(hostOf('http://127.0.0.1:8080/v1'), '127.0.0.1')
  // 非法/空 → 空串，不抛
  assert.equal(hostOf(''), '')
  assert.equal(hostOf('not a url'), '')
  assert.equal(hostOf(undefined), '')
})

test('describeImages：ask 取 path / compare 取两图 / 空串不计 / 过脱敏', () => {
  assert.deepEqual(describeImages('ask', { path: ' E:/a.png ' }), ['E:/a.png'])
  assert.deepEqual(describeImages('ask', { path: '   ' }), [])
  assert.deepEqual(describeImages('ask', {}), [])
  assert.deepEqual(describeImages('compare', { imageA: 'E:/a.png', imageB: 'E:/b.png' }), ['E:/a.png', 'E:/b.png'])
  assert.deepEqual(describeImages('compare', { imageA: 'E:/a.png', imageB: '  ' }), ['E:/a.png'])
  assert.deepEqual(describeImages('compare', {}), [])
  // 路径里若夹带凭据形状串 → 被擦除
  assert.deepEqual(describeImages('ask', { path: 'E:/x/sk-live-abcdefgh.png' }), ['E:/x/[redacted].png'])
})

test('questionLength：只记长度不记内容（问题可能含隐私描述）', () => {
  assert.equal(questionLength('这张图里有什么？'), 8)
  assert.equal(questionLength(undefined), 0)
  assert.equal(questionLength(''), 0)
})

test('summarizeVisionResult：成功 / 失败 / 脏数据，且 error 过脱敏+截断', () => {
  assert.deepEqual(summarizeVisionResult({ ok: true, answer: 'abc' }), { ok: true, answerChars: 3 })
  assert.deepEqual(summarizeVisionResult({ ok: false, error: '读文件失败: ENOENT' }), { ok: false, answerChars: 0, error: '读文件失败: ENOENT' })
  // 脏数据（D4）：非对象 / null / answer 非字符串 / ok 非布尔
  assert.deepEqual(summarizeVisionResult(null), { ok: false, answerChars: 0 })
  assert.deepEqual(summarizeVisionResult('boom'), { ok: false, answerChars: 0 })
  assert.deepEqual(summarizeVisionResult(undefined), { ok: false, answerChars: 0 })
  assert.deepEqual(summarizeVisionResult({ ok: true, answer: 42 }), { ok: true, answerChars: 0 })
  assert.deepEqual(summarizeVisionResult({ ok: 'yes', error: 7 }), { ok: false, answerChars: 0 })
  // error 里的凭据被擦除 + 超长截断
  const leaked = summarizeVisionResult({ ok: false, error: 'auth failed: Bearer sk-live-abcdefgh' })
  assert.equal(leaked.error.includes('sk-live-abcdefgh'), false)
  assert.match(leaked.error, /\[redacted\]/)
  assert.ok(summarizeVisionResult({ ok: false, error: 'x'.repeat(900) }).error.length <= 201)
})

test('composeVisionEntry：7 条分支的断点分类（**驱动真实合成函数**）', () => {
  const mk = (over) => composeVisionEntry({
    phase: 'ask', build: '0.1.0@1', op: 'vision_ask',
    meta: newVisionMeta('qwen3.8-flash'), args: { path: 'E:/a.png', question: '描述' },
    config: CFG, durationMs: 5, ...over,
  })
  // input：path 为空（执行体直接返回，未设 stage ⇒ 保持默认 input）
  // 真实语义：`images` 记的是**调用方给的路径**，与命中哪条分支无关；
  // 故 input 分支要用「真的空 path」做夹具（path 非空却报 input 是不可能的组合）。
  const input = mk({ args: { path: '', question: '描述' }, result: { ok: false, error: 'path 为空' } })
  assert.equal(input.stage, 'input')
  assert.equal(input.ok, false)
  assert.deepEqual(input.images, [])            // 空路径不记
  // read：读文件失败
  const read = mk({ meta: { ...newVisionMeta('m'), stage: 'read' }, result: { ok: false, error: '读文件失败: ENOENT' } })
  assert.equal(read.stage, 'read')
  assert.equal(read.imageBytes, 0)              // 没读到 → 0 字节
  // size：超尺寸（此时字节数已知）
  const size = mk({ meta: { ...newVisionMeta('m'), stage: 'size', imageBytes: 30 * 1024 * 1024 }, result: { ok: false, error: '图片超过 20MB' } })
  assert.equal(size.stage, 'size')
  assert.equal(size.imageBytes, 30 * 1024 * 1024)
  // key：无可用 API key（此时尚未发请求 → httpStatus 0）
  const key = mk({ meta: { ...newVisionMeta('m'), stage: 'key', imageBytes: 10 }, result: { ok: false, error: '无可用 API key（三级解析均失败）' } })
  assert.equal(key.stage, 'key')
  assert.equal(key.httpStatus, 0)
  assert.equal(key.ok, false)
  // request：HTTP 401（httpStatus 有值）
  const req = mk({ meta: { ...newVisionMeta('m'), stage: 'request', httpStatus: 401 }, result: { ok: false, error: 'HTTP 401', model: 'm' } })
  assert.equal(req.stage, 'request')
  assert.equal(req.httpStatus, 401)
  // parse：响应体不可解析
  const parse = mk({ meta: { ...newVisionMeta('m'), stage: 'parse', httpStatus: 200 }, result: { ok: false, error: '响应体不是 JSON' } })
  assert.equal(parse.stage, 'parse')
  assert.equal(parse.httpStatus, 200)
  // done：成功（回答字符数来自真实返回体）
  const done = mk({ meta: { ...newVisionMeta('m'), stage: 'done', httpStatus: 200, imageBytes: 2048, questionChars: 2 }, result: { ok: true, model: 'm', answer: 'x'.repeat(120) } })
  assert.equal(done.stage, 'done')
  assert.equal(done.ok, true)
  assert.equal(done.answerChars, 120)
  assert.equal(done.imageBytes, 2048)
  assert.equal(done.questionChars, 2)
  // 抛错（观测层不吞）：ok=false + error 前缀 + stage 由包装器置 request
  const boom = mk({ thrown: new Error('fetch failed'), meta: { ...newVisionMeta('m'), stage: 'request' } })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /^抛错: fetch failed/)
  // 无 result 且无 thrown（退化输入）→ 不抛，ok=false
  assert.equal(mk({}).ok, false)
})

test('composeVisionEntry：compare 分支记两图与总字节数，endpoint 只主机名', () => {
  const e = composeVisionEntry({
    phase: 'compare', build: '0.1.0@1', op: 'vision_compare',
    meta: { ...newVisionMeta('m'), stage: 'done', imageBytes: 3000, httpStatus: 200 },
    args: { imageA: 'E:/a.png', imageB: 'E:/b.png', question: 'q' },
    config: { baseUrl: 'https://user:pass@api.example.com/v1?token=abc' },
    durationMs: 900,
    result: { ok: true, model: 'm', answer: 'ok' },
  })
  assert.equal(e.phase, 'compare')
  assert.deepEqual(e.images, ['E:/a.png', 'E:/b.png'])
  assert.equal(e.imageBytes, 3000)
  assert.equal(e.endpoint, 'api.example.com')   // userinfo 与 token 都不在
  assert.equal(e.answerChars, 2)
})

test('serializeTraceEntry：单行 + 键序固定 + error 缺省不污染', () => {
  const line = serializeTraceEntry(base({}))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'op', 'stage', 'model', 'endpoint', 'images', 'imageBytes',
    'questionChars', 'answerChars', 'httpStatus', 'durationMs', 'ok',
  ])
  const withErr = JSON.parse(serializeTraceEntry(base({ ok: false, stage: 'read', error: '读文件失败: ENOENT' })))
  assert.equal(Object.keys(withErr).at(-1), 'error')
})

test('parseTraceEntries：坏行/半行/空行/null/字符串全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, '  ', '{"atMs":1,"phase":"ask"', '{"phase":"ask"}', 'null', '"str"', '###'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].op, 'vision_ask')
})

test('readTraceEntries：缺失文件/目录误当文件 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'vision-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry：正常追加可回读；空文件读回空数组', () => {
  const path = join(tmp, 'ok', 'vision-trace.jsonl')
  const emptyPath = join(tmp, 'empty-trace.jsonl')
  writeFileSync(emptyPath, '', 'utf8')
  assert.deepEqual(readTraceEntries(emptyPath), [])
  assert.equal(appendTraceEntry(path, base({ phase: 'boot', op: 'apply' })), true)
  assert.equal(appendTraceEntry(path, base({ phase: 'compare', op: 'vision_compare', stage: 'key', ok: false, error: '无可用 API key' })), true)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.phase), ['boot', 'compare'])
  assert.equal(back[1].stage, 'key')
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬读图）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'vision-trace.jsonl'), base({})), false)
    assert.equal(visionTrace(base({}), { path: join(blocker, 'vision-trace.jsonl'), now: 1 }), false)
  })
})

test('visionTrace：注入 now 落一行；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'vision-trace.jsonl')
  const { atMs, ...withoutAt } = base({ phase: 'compare', op: 'vision_compare' })
  assert.equal(atMs, 1_700_000_000_000)
  assert.equal(visionTrace(withoutAt, { path, now: 42 }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 42)
  assert.equal(line.op, 'vision_compare')
  assert.equal(visionTrace(withoutAt, { path: join(tmp, 'blocker', 'x.jsonl'), now: 43 }), false)
})

test('隐私尸体测试端到端：图片路径含凭据 + error 含 token + baseUrl 含 userinfo → 落盘行搜不到（红线）', () => {
  const path = join(tmp, 'privacy', 'vision-trace.jsonl')
  const secrets = ['sk-live-9f8e7d6c5b4a3210', 'hunter2secret', 'AbCdEf0123456789AbCdEf0123456789', 'p@ssw0rd-in-url']
  // ① 路径里夹带凭据形状串
  const e1 = composeVisionEntry({
    phase: 'ask', build: '0.1.0@1', op: 'vision_ask',
    meta: { ...newVisionMeta('m'), stage: 'read' },
    args: { path: 'E:/x/sk-live-9f8e7d6c5b4a3210.png' }, config: CFG, durationMs: 3,
    result: { ok: false, error: '读文件失败: E:/x/sk-live-9f8e7d6c5b4a3210.png' },
  })
  assert.equal(visionTrace(e1, { path, now: 1 }), true)
  // ② 上游把 Authorization 头写进错误文案
  const e2 = composeVisionEntry({
    phase: 'ask', build: '0.1.0@1', op: 'vision_ask',
    meta: { ...newVisionMeta('m'), stage: 'request', httpStatus: 401 },
    args: { path: 'E:/a.png' },
    config: { baseUrl: 'https://user:p@ssw0rd-in-url@api.example.com/v1?api_key=hunter2secret' },
    durationMs: 8,
    result: { ok: false, error: 'Authorization: Bearer AbCdEf0123456789AbCdEf0123456789 rejected' },
  })
  assert.equal(visionTrace(e2, { path, now: 2 }), true)
  const raw = readFileSync(path, 'utf8')
  for (const s of secrets) assert.equal(raw.includes(s), false, '凭据不得落盘: ' + s)
  assert.equal(raw.includes('画像'), false)
  assert.match(raw, /\[redacted\]/)                       // 擦除确实发生了（排除「没写进去」的假绿）
  const lines = parseTraceEntries(raw)
  assert.equal(lines.length, 2)
  assert.equal(lines[1].endpoint, 'api.example.com')      // 只留主机名
  assert.equal(lines[1].httpStatus, 401)
})

test('隐私保证：轨迹行里绝不出现图片内容（base64/像素数据）', () => {
  const e = composeVisionEntry({
    phase: 'ask', build: '0.1.0@1', op: 'vision_ask',
    meta: { ...newVisionMeta('m'), stage: 'done', imageBytes: 999, httpStatus: 200 },
    args: { path: 'E:/a.png' }, config: CFG, durationMs: 10,
    result: { ok: true, model: 'm', answer: '构图居中' },
  })
  const line = serializeTraceEntry({ atMs: 1, ...e })
  // 契约：只记字节数，不记内容——行长度应与「一小段元数据」同量级（远小于任何图片 base64）
  assert.ok(line.length < 600, '轨迹行不该含图片内容: len=' + String(line.length))
  assert.equal(line.includes('base64'), false)
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf（版本读不到退化为 unknown@mtime）', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')
  const self = join(root, 'lib', 'index.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '0.1.0')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '0.1.0'), '0.1.0@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
})

test('离线组合：复刻执行体的 7 条分支 → 轨迹行能把「断在哪一段」一次读出来', () => {
  const path = join(tmp, 'combo', 'vision-trace.jsonl')
  const run = (meta, result, thrown) => visionTrace(composeVisionEntry({
    phase: 'ask', build: '0.1.0@1', op: 'vision_ask', meta,
    args: { path: 'E:/a.png', question: 'q' }, config: CFG, durationMs: 11, result, thrown,
  }), { path, now: 7 })
  // 与 index.ts 中各分支写入 meta 的方式一致
  assert.equal(run(newVisionMeta('m'), { ok: false, error: 'path 为空' }), true)                                   // input
  assert.equal(run({ ...newVisionMeta('m'), stage: 'read' }, { ok: false, error: '读文件失败' }), true)             // read
  assert.equal(run({ ...newVisionMeta('m'), stage: 'size', imageBytes: 1 }, { ok: false, error: '图片超过 20MB' }), true)
  assert.equal(run({ ...newVisionMeta('m'), stage: 'key' }, { ok: false, error: '无可用 API key' }), true)          // key
  assert.equal(run({ ...newVisionMeta('m'), stage: 'request', httpStatus: 429 }, { ok: false, error: 'HTTP 429' }), true)
  assert.equal(run({ ...newVisionMeta('m'), stage: 'parse', httpStatus: 200 }, { ok: false, error: '解析失败' }), true)
  assert.equal(run({ ...newVisionMeta('m'), stage: 'done', imageBytes: 5, httpStatus: 200 }, { ok: true, model: 'm', answer: 'AB' }), true)
  const stages = readTraceEntries(path).map((e) => e.stage)
  assert.deepEqual(stages, ['input', 'read', 'size', 'key', 'request', 'parse', 'done'])
  const lines = readTraceEntries(path)
  // Q1–Q5 逐项可从同一行读出
  assert.equal(lines[0].build, '0.1.0@1')                 // Q1 构建
  assert.equal(lines[6].model, 'm')                       // Q2 模型
  assert.equal(lines[6].endpoint, 'dashscope.aliyuncs.com') // Q2 投给谁
  assert.equal(lines[4].httpStatus, 429)                  // Q3 断点（HTTP + stage）
  assert.equal(lines[6].answerChars, 2)                   // Q4 回答字符数
  assert.equal(lines[6].durationMs, 11)                   // Q5 耗时
  assert.equal(lines[0].ok, false)
  assert.equal(lines[6].ok, true)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
