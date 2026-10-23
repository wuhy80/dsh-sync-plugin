/**
 * 路由层 HTTP 端到端：真实 http.Server 挂上 makeRoutes() 的 6 条路由，逐个请求。
 *
 * 用临时 DSH_HOME（不碰真实 ~/.dsh），远端用本地裸仓库冒充。
 * 校验：状态读取 / 设置读写 / token 掩码 / 方法校验(405) / 未配置远端(400) /
 *       检测 / 预演 / 真实同步（两侧收敛）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-http-'))
const home = path.join(tmp, 'home')
const bare = path.join(tmp, 'remote.git')
process.env.DSH_HOME = home

const { dataPaths, writeSettings } = await import('../lib/config.js')
const { encodeFrames, splitFrames, linesOf, SESSION_FILE } = await import('../lib/sessions.js')
const { makeRoutes } = await import('../lib/routes.js')
const { run } = await import('../lib/proc.js')

// 造数据
const paths = dataPaths()
const wsDir = path.join(paths.sessions, '--D-code-demo--', 'session-demo-1')
fs.mkdirSync(wsDir, { recursive: true })
fs.writeFileSync(path.join(wsDir, SESSION_FILE), encodeFrames(['{"e":1}', '{"e":2}']))
fs.mkdirSync(path.dirname(paths.workspace), { recursive: true })
fs.writeFileSync(paths.workspace, `${JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { w1: { path: 'D:\\code\\demo', title: 'demo', sessionIds: ['session-demo-1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
}, null, 2)}\n`)
const prof = paths.profile('desktop')
fs.mkdirSync(prof.root, { recursive: true })
fs.writeFileSync(prof.packageJson, `${JSON.stringify({ name: 'p', dependencies: { 'dsh-a': '^1.0.0' }, dsh: { profile: { bundles: ['b1'] } } }, null, 2)}\n`)
fs.writeFileSync(prof.patch, '# patch\n- id: x\n  name: x\n')

const bareInit = await run('git', ['init', '--bare', '-q', '-b', 'main', bare])
assert.equal(bareInit.code, 0, bareInit.stderr)

writeSettings({
  remote: `file://${bare.replace(/\\/g, '/')}`,
  branch: 'main',
  token: '',
  profile: 'desktop',
  include: { sessions: true, workspace: true, plugins: true, settings: true },
  sessions: { strategy: 'union' },
}, paths)

// 起服务：按 path 精确匹配分发（与 DSH 行为一致）
const routes = makeRoutes({ paths, log: () => {} })
const server = http.createServer((req, res) => {
  const route = routes.find((r) => r.path === req.url.split('?')[0])
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const BASE = `http://127.0.0.1:${port}/api/dsh-sync`

const call = async (method, sub, body) => {
  const res = await fetch(`${BASE}${sub}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

// 1. 状态
let r = await call('GET', '/state')
assert.equal(r.status, 200, JSON.stringify(r.data))
assert.equal(r.data.settings.token, '', 'token 未配置时应为空串')
assert.equal(r.data.overview.local.sessions, 1, '本地会话数')
console.log('GET /state ✓ 本地会话', r.data.overview.local.sessions, '| git', Boolean(r.data.gitVersion))

// 2. 方法校验
r = await call('GET', '/settings')
assert.equal(r.status, 405, 'GET /settings 应为 405')
console.log('GET /settings → 405 ✓')

// 3. 改设置（token 掩码语义：传 *** 表示不变）
r = await call('PUT', '/settings', { branch: 'main', profile: 'desktop', token: '***' })
assert.equal(r.status, 200)
assert.equal(r.data.settings.branch, 'main')
const onDisk = JSON.parse(fs.readFileSync(paths.settings, 'utf8'))
assert.equal(onDisk.token, '', '传 *** 不应把掩码写进设置')
console.log('PUT /settings ✓ 掩码未落盘')

// 4. 检测
r = await call('POST', '/probe')
assert.equal(r.status, 200, JSON.stringify(r.data))
assert.ok(r.data.gitVersion && r.data.gitVersion.startsWith('git version'), 'git 版本')
assert.equal(r.data.mirrorReady.ready, true, '镜像应就绪')
assert.equal(r.data.privacy.state, 'unknown', '非 GitHub 远端应判 unknown')
console.log('POST /probe ✓', r.data.privacy.state)

// 5. 预演（首次：本地全部要推送）
r = await call('POST', '/plan')
assert.equal(r.status, 200, JSON.stringify(r.data))
const firstPlan = r.data.decisions.length
assert.ok(firstPlan >= 3, `首次预演应有 ≥3 项，实际 ${firstPlan}`)
console.log('POST /plan ✓ 首次', firstPlan, '项')

// 6. 真实同步 → 推送
r = await call('POST', '/sync', {})
assert.equal(r.status, 200, JSON.stringify(r.data))
assert.equal(r.data.pushed.ok, true, `推送失败：${JSON.stringify(r.data.pushed)}`)
assert.equal(r.data.commit.committed, true, '应有提交')
const firstSha = r.data.commit.sha
console.log('POST /sync ✓ 提交', firstSha, '| 写入镜像', r.data.applied.written.repo, '本地', r.data.applied.written.local)

// 7. 再预演：应无待办
r = await call('POST', '/plan')
assert.equal(r.status, 200)
assert.equal(r.data.decisions.length, 0, `同步后不应再有计划项：${JSON.stringify(r.data.decisions)}`)
console.log('二次 /plan ✓ 0 项（两侧一致）')

// 8. 模拟另一台机器：在镜库里加一帧 → 预演应报 1 项 pull，同步后本地拿到
const repoSession = path.join(paths.mirror, 'sessions', '--D-code-demo--', 'session-demo-1', SESSION_FILE)
const extra = '{"e":"from-other-machine"}'
fs.writeFileSync(repoSession, Buffer.concat([fs.readFileSync(repoSession), encodeFrames([extra])]))
r = await call('POST', '/plan')
assert.equal(r.status, 200)
assert.equal(r.data.decisions.length, 1, `期望 1 项，实际 ${JSON.stringify(r.data.decisions)}`)
assert.equal(r.data.decisions[0].action, 'pull')
r = await call('POST', '/sync', {})
assert.equal(r.status, 200, JSON.stringify(r.data))
const localLines = linesOf(splitFrames(fs.readFileSync(path.join(paths.sessions, '--D-code-demo--', 'session-demo-1', SESSION_FILE))).frames)
assert.deepEqual(localLines, ['{"e":1}', '{"e":2}', extra], '本地应拿到另一台机器的事件')
console.log('远端新增 → 同步 ✓ 本地行数', localLines.length)

// 9. 未配置远端 → 400
writeSettings({ ...JSON.parse(fs.readFileSync(paths.settings, 'utf8')), remote: '' }, paths)
r = await call('POST', '/plan')
assert.equal(r.status, 400, '未配置远端应 400')
console.log('未配置远端 → 400 ✓')

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n✅ 路由层 HTTP 端到端通过')
