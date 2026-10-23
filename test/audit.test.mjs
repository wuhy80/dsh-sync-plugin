/**
 * 自查（对抗性）测试：专门找"什么输入会让它出错"。
 *
 * 覆盖本轮修复的 6 个问题 + 2 个边界：
 * 1) workspace.json 不是合法 JSON → 跳过并告警，不覆盖任何一侧
 * 2) 会话尾帧损坏 → keep-local，两侧都不动
 * 3) 会话超过 maxPerFileMB → 跳过合并并告警（该配置之前是死的）
 * 4) applyPlan 对 keep-local 不写镜像
 * 5) 空计划不写 meta.json（不产生空提交）
 * 6) 三路合并超大文件降级
 * 7) 凭据/缓存路径守卫
 * 8) token 可显式清空（HTTP）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-audit-'))
const home = path.join(tmp, 'home')
process.env.DSH_HOME = home

const { dataPaths, writeSettings, readSettings } = await import('../lib/config.js')
const { encodeFrames, splitFrames, linesOf, SESSION_FILE } = await import('../lib/sessions.js')
const { planSync, applyPlan, assertNotBlocked } = await import('../lib/merge.js')
const { threeWayMergeText } = await import('../lib/datasets.js')
const { makeRoutes } = await import('../lib/routes.js')
const { run } = await import('../lib/proc.js')

const paths = dataPaths()
const mirror = paths.mirror
const WS = '--D-code-audit--'
const SID = 'session-audit-1'

function reset() {
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(paths.sessions, WS, SID), { recursive: true })
  fs.mkdirSync(path.dirname(paths.workspace), { recursive: true })
  fs.mkdirSync(mirror, { recursive: true })
  const prof = paths.profile('desktop')
  fs.mkdirSync(prof.root, { recursive: true })
  fs.writeFileSync(prof.packageJson, JSON.stringify({ name: 'p', dependencies: { a: '^1.0.0' }, dsh: { profile: { bundles: [] } } }, null, 2))
  fs.writeFileSync(prof.patch, '# p\n')
  writeSettings({ remote: 'file:///tmp/x.git', branch: 'main', profile: 'desktop' }, paths)
}

const put = (root, rel, data) => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}

// ── 1) workspace.json 非法 JSON ───────────────────────────────────────────
reset()
fs.writeFileSync(paths.workspace, '{ 这不是 JSON')
put(mirror, 'workspace/workspace.json', '{"global":{"workspaceIds":["w2"]},"tables":{"workspaces":{"w2":{"path":"E:\\\\b","updatedAt":"2026-02-01T00:00:00Z"}}}}')
{
  const r = planSync({ paths, settings: readSettings(paths), mirror })
  const s = r.plan.stats
  assert.equal(r.plan.decisions.filter((d) => d.kind === 'workspace').length, 0, '非法 JSON 不应产生 workspace 决策')
  assert.equal(s.workspace.mode, 'skipped-invalid')
  assert.ok(s.warnings.some((w) => w.includes('workspace.json')), '应有告警')
  assert.equal(fs.readFileSync(paths.workspace, 'utf8'), '{ 这不是 JSON', '本地文件不能被改动')
  console.log('1) 非法 workspace.json → 跳过 + 告警 ✓')
}

// ── 2) 会话尾帧损坏 → keep-local，两侧都不动 ─────────────────────────────
reset()
const localSession = put(paths.sessions, path.join(WS, SID, SESSION_FILE), encodeFrames(['{"e":1}', '{"e":2}']))
// 真正的损坏：截断一个合法帧（尾部垃圾会被 zstd 忽略，只有截断才解不出完整内容）
const goodFrame = encodeFrames(['{"e":1}'])
const repoSession = put(mirror, path.join('sessions', WS, SID, SESSION_FILE), goodFrame.subarray(0, Math.max(8, goodFrame.length - 10)))
const repoBefore = fs.readFileSync(repoSession)
{
  const r = planSync({ paths, settings: readSettings(paths), mirror })
  const dec = r.plan.decisions.find((d) => d.kind === 'session')
  assert.ok(dec, '应产生会话决策')
  assert.equal(dec.action, 'keep-local')
  assert.equal(dec.buffer, null, 'keep-local 不应携带字节（否则会覆盖远端）')
  const applied = applyPlan(r.plan, { paths, mirror })
  // 只关心会话这一项：keep-local 绝不能写镜像（其余 kind —— 插件/设置 —— 允许正常推送）
  assert.equal(fs.readFileSync(repoSession).equals(repoBefore), true, '镜像里的会话文件必须原样')
  assert.equal(fs.readFileSync(localSession).length > 0, true, '本地文件必须存在')
  console.log('2) 会话帧损坏 → 两侧均未改动 ✓')
}

// ── 3) 超大会话跳过合并 ──────────────────────────────────────────────────
reset()
const bigLocal = put(paths.sessions, path.join(WS, SID, SESSION_FILE), encodeFrames(['{"e":1}', '{"e":2}']))
put(mirror, path.join('sessions', WS, SID, SESSION_FILE), encodeFrames(['{"e":1}', '{"e":"R"}']))
{
  const settings = { ...readSettings(paths), sessions: { strategy: 'union', maxPerFileMB: 0.00001 } }
  const r = planSync({ paths, settings, mirror })
  assert.equal(r.plan.stats.sessions.skippedOversize, 1)
  assert.equal(r.plan.decisions.filter((d) => d.kind === 'session').length, 0, '超大不应展开合并决策')
  assert.ok(r.plan.stats.warnings.some((w) => w.includes('MB')), '应有超限告警')
  console.log('3) 超大会话 → 跳过 + 告警 ✓')
}

// ── 4/5) 空计划不写 meta，不产生提交 ─────────────────────────────────────
reset()
put(paths.sessions, path.join(WS, SID, SESSION_FILE), encodeFrames(['{"e":1}']))
put(mirror, path.join('sessions', WS, SID, SESSION_FILE), encodeFrames(['{"e":1}']))
// 镜像补齐三类文件，且与本地逐字节一致 → 计划必须是空的
put(mirror, 'workspace/workspace.json', JSON.stringify({ global: { workspaceIds: [] }, tables: { workspaces: {} } }))
fs.writeFileSync(paths.workspace, fs.readFileSync(path.join(mirror, 'workspace/workspace.json')))
const prof0 = paths.profile('desktop')
put(mirror, 'plugins/desktop/package.json', fs.readFileSync(prof0.packageJson))
put(mirror, 'plugins/desktop/cordis.patch.yml', fs.readFileSync(prof0.patch))
{
  const r2 = planSync({ paths, settings: readSettings(paths), mirror })
  assert.equal(r2.plan.decisions.length, 0, `应为空计划，实际 ${JSON.stringify(r2.plan.decisions.map((d) => d.kind + ':' + d.action))}`)
  applyPlan(r2.plan, { paths, mirror })
  assert.equal(fs.existsSync(path.join(mirror, 'meta.json')), false, '空计划不应写 meta.json')
  console.log('4/5) 空计划 → 不写 meta ✓')
}

// ── 6) 三路合并大文件降级 ────────────────────────────────────────────────
{
  const big = Array.from({ length: 4100 }, (_, i) => `line-${i}`).join('\n')
  const r = threeWayMergeText(big, `${big}\nL`, `${big}\nR`)
  assert.equal(r.tooLarge, true)
  assert.equal(r.conflicts, 1)
  assert.ok(r.text.endsWith('L'), '应保留本地')
  console.log('6) 三路合并超 4000 行 → 降级保留本地 ✓')
}

// ── 7) 黑名单守卫 ────────────────────────────────────────────────────────
{
  assert.throws(() => assertNotBlocked('.credentials.yaml'), /拒绝写入/)
  assert.throws(() => assertNotBlocked('profiles/desktop/node_modules/x/y.js'), /拒绝写入/)
  assert.throws(() => assertNotBlocked('cache/foo.json'), /拒绝写入/)
  assert.doesNotThrow(() => assertNotBlocked('plugins/desktop/package.json'))
  assert.doesNotThrow(() => assertNotBlocked(path.join('sessions', WS, SID, SESSION_FILE)))
  console.log('7) 凭据/缓存路径守卫 ✓')
}

// ── 8) token 可显式清空（HTTP）───────────────────────────────────────────
reset()
{
  writeSettings({ ...readSettings(paths), token: 'ghp_secret_value' }, paths)
  const routes = makeRoutes({ paths })
  const server = http.createServer((req, res) => {
    const route = routes.find((r) => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-sync`

  let res = await fetch(`${base}/state`)
  let body = await res.json()
  assert.equal(body.settings.token, '***', '有 token 时回显掩码')

  res = await fetch(`${base}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '***' }),
  })
  assert.equal(res.status, 200)
  assert.equal(readSettings(paths).token, 'ghp_secret_value', '传掩码不应清空')

  res = await fetch(`${base}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clearToken: true }),
  })
  assert.equal(res.status, 200)
  assert.equal(readSettings(paths).token, '', 'clearToken 应清空')

  res = await fetch(`${base}/settings`, { method: 'GET' })
  assert.equal(res.status, 405, '方法校验仍然生效')
  server.close()
  console.log('8) token 掩码/清空/405 ✓')
}

// ── 9) 远端地址内嵌凭据的识别 ─────────────────────────────────────────────
{
  const { inspectRemote } = await import('../lib/repo.js')
  const bad = inspectRemote('https://user:ghp_abc123@github.com/me/x.git')
  assert.equal(bad.embedded, true)
  assert.equal(bad.scrubbed.includes('ghp_abc123'), false, '脱敏后不应残留 token')
  assert.equal(bad.scrubbed.includes('***'), true)
  assert.equal(inspectRemote('git@github.com:me/x.git').embedded, false, 'SSH 形态不应误判')
  assert.equal(inspectRemote('https://github.com/me/x.git').embedded, false)
  console.log('9) 内嵌凭据识别 + 脱敏 ✓')
}

// ── 10) 并发同步：不允许把镜像写坏 ───────────────────────────────────────
{
  reset()
  // 造一个真实可用的裸仓库当远端（否则首次 fetch 就失败，测不到互斥）
  const bare2 = path.join(tmp, 'concurrent.git')
  fs.mkdirSync(bare2, { recursive: true })
  assert.equal((await run('git', ['init', '--bare', '-q', '-b', 'main', bare2])).code, 0)
  writeSettings({ ...readSettings(paths), remote: `file://${bare2.replace(/\\/g, '/')}` }, paths)
  // 让同步有一定耗时，撞出并发窗口
  const many = Array.from({ length: 800 }, (_, i) => JSON.stringify({ type: 'e', i }))
  put(paths.sessions, path.join(WS, SID, SESSION_FILE), encodeFrames(many, 100))
  const routes2 = makeRoutes({ paths })
  const srv = http.createServer((req, res) => {
    const route = routes2.find((r) => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const b2 = `http://127.0.0.1:${srv.address().port}/api/dsh-sync`
  const hits = await Promise.all(
    [0, 1, 2].map(() => fetch(`${b2}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)),
  )
  // 至少有一个成功；其余要么 409（互斥生效）要么也成功（窗口错开）
  assert.ok(hits.includes(200), `至少一次同步成功，实际 ${hits}`)
  assert.ok(hits.every((s) => s === 200 || s === 409), `状态只能是 200/409，实际 ${hits}`)
  // 镜像仓库必须仍然可用（没有半写/锁死）
  const fsck = await run('git', ['-C', mirror, 'status', '--porcelain'])
  assert.equal(fsck.code, 0, `git status 应能执行：${fsck.stderr}`)
  const { mirrorStatus } = await import('../lib/repo.js')
  const st = await mirrorStatus({ mirror, branch: 'main', remote: `file://${bare2.replace(/\\/g, '/')}` })
  assert.equal(st.dirtyCount, 0, `同步后镜像应是干净的，实际脏文件 ${st.dirtyCount}`)
  assert.equal(st.ahead, 0, `不应残留未推送提交，实际 ahead ${st.ahead}`)
  srv.close()
  console.log(`10) 并发同步未写坏镜像（状态 ${hits.join('/')}，干净 & 已推送）✓`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n✅ 自查（对抗性）测试全部通过')
