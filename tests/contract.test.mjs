/**
 * dsh-agent-vision · 契约守卫（单一真源 + 入口契约）。
 *
 * ① **判定逻辑单一真源**：`vision_ask` / `vision_compare` 原先把同一套判定（扩展名→MIME、
 *    三级 key 解析、20MB 上限、响应解析）**各内联一份**——两份必然漂移（改了 A 忘了 B）。
 *    守卫：`index.ts` 不得再出现内联的 MIME 映射 / 凭据行解析 / `JSON.parse(txt)` + `choices` 取值。
 * ② **入口命名契约**：`name` 导出是 `agent-agent-vision`（双前缀）——它与 profile patch 的
 *    `- id: agent-agent-vision` **逐字绑定**（`.dsh/profiles/web/cordis.patch.yml:226`）。
 *    有人「顺手修正」成 `agent-vision` 而不同步 patch，会让组合行失配。本守卫把这条关系钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const pureSrc = readFileSync(join(root, 'src', 'pure.ts'), 'utf8')

/** 检测器：源码里出现内联判定片段即违规（应改为从 src/pure.ts 调用）。 */
function findInlinedDecisions(source) {
  const offenders = []
  if (/mimeMap\s*:?\s*Record<string,\s*string>/.test(source) || /['"]\.png['"]\s*:\s*['"]image\/png['"]/.test(source)) {
    offenders.push('内联 MIME 映射（应为 mimeOf）')
  }
  if (/line\.indexOf\(':'\)/.test(source)) offenders.push('内联凭据行解析（应为 keyFromCredentials）')
  if (/JSON\.parse\(txt\)/.test(source)) offenders.push('内联响应解析（应为 parseChatResponse）')
  if (/20\s*\*\s*1024\s*\*\s*1024/.test(source)) offenders.push('内联 20MB 常量（应为 MAX_IMAGE_BYTES）')
  return offenders
}

test('不变量①：工具接线不得内联判定逻辑（单一真源在 src/pure.ts）', () => {
  const offenders = findInlinedDecisions(indexSrc)
  assert.deepEqual(offenders, [], `内联判定会让两份工具漂移：\n${offenders.join('\n')}`)
  assert.match(indexSrc, /from '\.\/pure\.ts'/, '前提：index.ts 必须从纯逻辑层导入（否则本守卫空转）')
})

test('不变量①·尸体样本：修前的内联片段必须被检测器抓到（证明守卫不是空转）', () => {
  const corpse = [
    "const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg' }",
    "for (const line of txtCred.split(/\\r?\\n/)) { const ci = line.indexOf(':'); }",
    'const j = JSON.parse(txt)',
    'if (sa.size > 20 * 1024 * 1024) return { ok: false }',
  ].join('\n')
  const offenders = findInlinedDecisions(corpse)
  assert.equal(offenders.length, 4, `四类内联片段都必须被抓出，实际：${JSON.stringify(offenders)}`)
  // 反向对照：这些模式在**真源**（src/pure.ts）里必然存在——证明检测器正则在真源码上是活的，
  // 不是永远匹配不到的死规则。
  assert.ok(findInlinedDecisions(pureSrc).length >= 3, '检测器的模式必须在真源上也能命中（否则守卫空转）')
})

test('不变量②：两个工具必须都经 parseChatResponse 解析响应（无旁路）', () => {
  const hits = indexSrc.match(/parseChatResponse\(/g) ?? []
  assert.equal(hits.length, 2, `vision_ask 与 vision_compare 各一处，实际 ${hits.length}`)
  // 2026-09-14 批次 S4-A 修正：原断言把「HTTP 分支 + 返回形状」写成一个连续字面量
  // （`kind === 'http') return { ... }`）。观测层给该分支加了 `{ meta.stage = 'request'; … }` 外壳后，
  // 字面量失配——但**守卫的意图（HTTP 分支必须带上 model，保住历史输出形状）完全未变**。
  // 故改为锚定两个**独立事实**：① 两个工具各有一条 HTTP 分支；② 两个工具各返回一次带 model 的错误体。
  // 这比原来只 assert.match 一次**更强**（原断言对第二个工具是盲的），且不再绑在语法糖上。
  assert.equal((indexSrc.match(/kind === 'http'\)/g) ?? []).length, 2, '两个工具各需一条 HTTP 分支')
  assert.equal(
    (indexSrc.match(/return \{ ok: false, error: parsed\.error, model: modelName \}/g) ?? []).length,
    2,
    'HTTP 分支必须带上 model（历史输出形状）——两个工具都要',
  )
})

test('入口契约：name/apply/inject + 两个工具注册名 + patch id 一致性', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'agent-agent-vision', 'name 导出与 profile patch 的 id 逐字绑定，改动必须同步 patch')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['tools'])
  const registered = indexSrc.match(/name:\s*"(vision_\w+)"/g) ?? []
  assert.deepEqual(registered.map((s) => s.replace(/name:\s*"/, '').replace(/"$/, '')), ['vision_ask', 'vision_compare'])
})
