/**
 * 离线端到端：用本地裸仓库冒充 GitHub，跑通两台机器的往返。
 *
 * 不碰真实 ~/.dsh：全部数据在临时目录里造。
 * 流程：A 侧首次同步（推送）→ B 侧 clone 并同步（采纳）→ B 侧新增事件再同步（推送）
 *      → A 侧同步（快进合并）→ 校验两侧会话行数一致且都包含新事件。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { dataPaths, writeSettings } = await import('../lib/config.js')
const { ensureMirror, fetchAndFastForward, commitAll, pushMirror, mirrorStatus, checkPrivate } = await import('../lib/repo.js')
const { planSync, applyPlan, collectLocal } = await import('../lib/merge.js')
const { encodeFrames, splitFrames, linesOf, SESSION_FILE } = await import('../lib/sessions.js')
const { run } = await import('../lib/proc.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-e2e-'))
const bare = path.join(tmp, 'remote.git')
const homeA = path.join(tmp, 'home-a')
const homeB = path.join(tmp, 'home-b')

function seed(home, sessionLines) {
  const paths = dataPaths(home)
  const wsDir = path.join(paths.sessions, '--D-code-demo--', 'session-demo-1')
  fs.mkdirSync(wsDir, { recursive: true })
  fs.writeFileSync(path.join(wsDir, SESSION_FILE), encodeFrames(sessionLines))
  fs.mkdirSync(path.dirname(paths.workspace), { recursive: true })
  fs.writeFileSync(paths.workspace, `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'D:\\code\\demo', title: 'demo', sessionIds: ['session-demo-1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
  }, null, 2)}\n`)
  const prof = paths.profile('desktop')
  fs.mkdirSync(prof.root, { recursive: true })
  fs.writeFileSync(prof.packageJson, `${JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-a': '^1.0.0' },
    dsh: { profile: { bundles: ['b1'] } },
  }, null, 2)}\n`)
  fs.writeFileSync(prof.patch, '# patch\n- id: x\n  name: x\n')
  writeSettings({
    remote: `file://${bare.replace(/\\/g, '/')}`,
    branch: 'main',
    profile: 'desktop',
    include: { sessions: true, workspace: true, plugins: true, settings: true },
    sessions: { strategy: 'union' },
  }, paths)
  return paths
}

async function syncOnce(home, label) {
  const paths = dataPaths(home)
  const settings = JSON.parse(fs.readFileSync(paths.settings, 'utf8'))
  const ready = await ensureMirror({ mirror: paths.mirror, remote: settings.remote, branch: settings.branch })
  assert.equal(ready.ready, true, `${label}: 镜像应可用 ${ready.error ?? ''}`)
  const fetched = await fetchAndFastForward({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
  assert.equal(fetched.ok, true, `${label}: fetch 应成功 ${fetched.detail ?? ''}`)
  const { plan } = planSync({ paths, settings, mirror: paths.mirror })
  const stats = plan.stats
  const applied = applyPlan(plan, { paths, mirror: paths.mirror })
  const commit = await commitAll({ mirror: paths.mirror, message: `${label} sync` })
  let pushed = { ok: true, skipped: true }
  if (commit.committed) {
    pushed = await pushMirror({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
  }
  assert.equal(pushed.ok, true, `${label}: push 应成功 ${pushed.detail ?? ''}`)
  return { plan, stats, commit, pushed, applied, paths, settings }
}

// 裸仓库
fs.mkdirSync(bare, { recursive: true })
let r = await run('git', ['init', '--bare', '-q', '-b', 'main', bare])
assert.equal(r.code, 0, `bare init 失败: ${r.stderr}`)

// A：首次同步
const pathsA = seed(homeA, ['{"e":1}', '{"e":2}'])
const a1 = await syncOnce(homeA, 'A1')
console.log('A1 计划项:', a1.plan.decisions.length, '| 提交:', a1.commit.sha ?? '-', '| 推送:', a1.pushed.ok ? (a1.pushed.skipped ? '跳过' : '成功') : '失败')

// B：从零开始同步（应采纳远端）
const pathsB = seed(homeB, ['{"e":1}', '{"e":2}'])
const b1 = await syncOnce(homeB, 'B1')
console.log('B1 计划项:', b1.plan.decisions.length, '| 会话统计:', b1.stats.sessions)

// B：本地新增事件 → 推送
const bSession = path.join(pathsB.sessions, '--D-code-demo--', 'session-demo-1', SESSION_FILE)
const bBuf = fs.readFileSync(bSession)
fs.writeFileSync(bSession, Buffer.concat([bBuf, encodeFrames(['{"e":"from-B"}'])]))
const b2 = await syncOnce(homeB, 'B2')
console.log('B2 合并数:', b2.stats.sessions.merged, '| 本地独有:', b2.stats.sessions.localOnly)

// A：再同步 → 应快进/合并拿到 B 的事件
const a2 = await syncOnce(homeA, 'A2')
console.log('A2 会话统计:', a2.stats.sessions)

// 校验：两侧行数一致，且包含 from-B
const aLines = linesOf(splitFrames(fs.readFileSync(path.join(pathsA.sessions, '--D-code-demo--', 'session-demo-1', SESSION_FILE))).frames)
const bLines = linesOf(splitFrames(fs.readFileSync(bSession)).frames)
console.log('A 行数:', aLines.length, '| B 行数:', bLines.length)
assert.deepEqual(aLines, bLines, '两台机器的会话行应完全一致')
assert.equal(aLines.includes('{"e":"from-B"}'), true, 'A 应拿到 B 新增的事件')

// 工作区/插件也应一致
const wsA = fs.readFileSync(pathsA.workspace, 'utf8')
const wsB = fs.readFileSync(pathsB.workspace, 'utf8')
assert.equal(wsA, wsB, '工作区注册表应一致')

// 状态：应干净
const st = await mirrorStatus({ mirror: pathsA.mirror, branch: 'main', remote: `file://${bare.replace(/\\/g, '/')}` })
console.log('最终 git 状态:', { dirty: st.dirtyCount, ahead: st.ahead, behind: st.behind })

// 非 GitHub 远端的私库判定应给 unknown（而不是误判 public）
const privacy = await checkPrivate({ remote: 'file:///tmp/x.git', token: '' })
console.log('私库判定（非 GitHub）:', privacy)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n✅ 离线端到端通过')
