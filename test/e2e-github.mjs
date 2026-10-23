/**
 * 真实 GitHub 往返（SSH）：验证 token/SSH 认证、私库判定、跨网络 push/pull、会话并集。
 *
 * 用临时 DSH_HOME 造数据，推到真实私有仓库 wuhy80/dsh-sync。
 * 结束后把仓库内容清空（普通提交，不用 force），保证你第一次真实同步从干净状态开始。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REMOTE = 'git@github.com:wuhy80/dsh-sync.git'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-gh-'))
const homeA = path.join(tmp, 'home-a')
const homeB = path.join(tmp, 'home-b')

const { dataPaths, writeSettings, readSettings } = await import('../lib/config.js')
const { encodeFrames, splitFrames, linesOf, SESSION_FILE } = await import('../lib/sessions.js')
const { ensureMirror, fetchAndFastForward, commitAll, pushMirror, mirrorStatus, checkPrivate } = await import('../lib/repo.js')
const { planSync, applyPlan } = await import('../lib/merge.js')
const { git } = await import('../lib/proc.js')

const WS = '--D-code-machine--'
const SID = 'session-shared-1'

function seedHome(home, lines, wsId) {
  const paths = dataPaths(home)
  const dir = path.join(paths.sessions, WS, SID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, SESSION_FILE), encodeFrames(lines))
  fs.mkdirSync(path.dirname(paths.workspace), { recursive: true })
  fs.writeFileSync(paths.workspace, `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: wsId, workspaceIds: [wsId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [wsId]: { path: `D:\\code\\${wsId}`, title: wsId, sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
  }, null, 2)}\n`)
  const prof = paths.profile('desktop')
  fs.mkdirSync(prof.root, { recursive: true })
  fs.writeFileSync(prof.packageJson, `${JSON.stringify({ name: 'p', dependencies: { 'dsh-a': '^1.0.0' }, dsh: { profile: { bundles: ['b1'] } } }, null, 2)}\n`)
  fs.writeFileSync(prof.patch, '# patch\n')
  writeSettings({ remote: REMOTE, branch: 'main', profile: 'desktop', include: { sessions: true, workspace: true, plugins: true, settings: true }, sessions: { strategy: 'union' } }, paths)
  return paths
}

async function syncOnce(home, label) {
  const paths = dataPaths(home)
  const settings = readSettings(paths)
  const ready = await ensureMirror({ mirror: paths.mirror, remote: settings.remote, branch: settings.branch })
  assert.equal(ready.ready, true, `${label}: 镜像不可用 ${ready.error ?? ''}`)
  const fetched = await fetchAndFastForward({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
  assert.equal(fetched.ok, true, `${label}: 拉取失败 ${fetched.detail ?? ''}`)
  const { plan } = planSync({ paths, settings, mirror: paths.mirror })
  const applied = applyPlan(plan, { paths, mirror: paths.mirror })
  const commit = await commitAll({ mirror: paths.mirror, message: `${label} sync` })
  let pushed = { ok: true, skipped: true }
  if (commit.committed) pushed = await pushMirror({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
  assert.equal(pushed.ok, true, `${label}: 推送失败 ${pushed.detail ?? ''}`)
  return { paths, plan, applied, commit, pushed, settings }
}

const lines = (path) => linesOf(splitFrames(fs.readFileSync(path)).frames)
const sessionPath = (paths) => path.join(paths.sessions, WS, SID, SESSION_FILE)

// 0) 私库判定（无 token 时应为 unknown，而不是误判 public）
const privacy = await checkPrivate({ remote: REMOTE, token: '' })
console.log('0) 私库判定（无 token）:', privacy.state)
assert.equal(privacy.state, 'unknown')

// 1) A 首次推送
const pathsA = seedHome(homeA, ['{"e":1}', '{"e":2}'], 'w-a')
const a1 = await syncOnce(homeA, 'A1')
console.log('1) A 首次同步:', a1.commit.committed ? `提交 ${a1.commit.sha}` : '无提交', '| 计划', a1.plan.decisions.length, '项')

// 2) B 拉取（远端领先）
const pathsB = seedHome(homeB, ['{"e":1}'], 'w-b')
const b1 = await syncOnce(homeB, 'B1')
console.log('2) B 首同步:', '计划', b1.plan.decisions.length, '项 | 会话 stats', JSON.stringify(b1.plan.decisions.filter((d) => d.kind === 'session').map((d) => d.action)))
assert.deepEqual(lines(sessionPath(pathsB)), ['{"e":1}', '{"e":2}'], 'B 应拉到 A 的完整会话')

// 3) B 追加事件并推送
fs.appendFileSync(sessionPath(pathsB), encodeFrames(['{"e":"from-B"}']))
const b2 = await syncOnce(homeB, 'B2')
console.log('3) B 追加后同步:', b2.commit.committed ? `提交 ${b2.commit.sha}` : '无提交')

// 4) A 再同步 → 拿到 B 的事件
const a2 = await syncOnce(homeA, 'A2')
const aLines = lines(sessionPath(pathsA))
const bLines = lines(sessionPath(pathsB))
console.log('4) A 再同步后行数:', aLines.length, '| B:', bLines.length)
assert.deepEqual(aLines, bLines, '两台机器会话应完全一致')
assert.ok(aLines.includes('{"e":"from-B"}'), 'A 应拿到 B 的新事件')

// 5) 工作区键合并（w-a + w-b 都在）
const wsA = JSON.parse(fs.readFileSync(pathsA.workspace, 'utf8'))
const wsB = JSON.parse(fs.readFileSync(pathsB.workspace, 'utf8'))
assert.deepEqual(wsA.global.workspaceIds.sort(), ['w-a', 'w-b'], `工作区应并集：${JSON.stringify(wsA.global.workspaceIds)}`)
assert.deepEqual(wsA.global.workspaceIds.sort(), wsB.global.workspaceIds.sort(), '两侧工作区应一致')
console.log('5) 工作区并集:', wsA.global.workspaceIds.join(' + '))

// 6) 远端确实收到了（网络侧证明）
const ls = await git(['ls-remote', '--heads', 'origin', 'main'], { cwd: pathsA.mirror, remote: REMOTE })
assert.equal(ls.code, 0, `ls-remote 失败：${ls.stderr}`)
assert.ok(ls.stdout.trim().length > 0, '远端 main 应存在')
const logCount = await git(['rev-list', '--count', 'HEAD'], { cwd: pathsA.mirror })
console.log('6) 远端 main tip:', ls.stdout.trim().split(/\s+/)[0].slice(0, 8), '| 本地提交数:', logCount.stdout.trim())

const st = await mirrorStatus({ mirror: pathsA.mirror, branch: 'main', remote: REMOTE })
assert.equal(st.dirtyCount, 0, `同步后应干净：${st.dirtyCount}`)
assert.equal(st.ahead, 0, `不应残留未推送提交：${st.ahead}`)
console.log('7) 状态干净且已全部推送 ✓')

// 8) 清空测试数据（普通提交，不用 force），保证真实同步从干净状态开始
const mirrorA = pathsA.mirror
await git(['rm', '-r', '--quiet', '--cached', '.'], { cwd: mirrorA })
await git(['clean', '-fdx'], { cwd: mirrorA })
const after = await commitAll({ mirror: mirrorA, message: 'chore: 清空冒烟数据，等待首次真实同步' })
if (after.committed) {
  const pushed = await pushMirror({ mirror: mirrorA, branch: 'main', remote: REMOTE })
  assert.equal(pushed.ok, true, `清理推送失败：${pushed.detail}`)
}
console.log('8) 已清空仓库内容（HEAD 为空，历史保留）:', after.committed ? after.sha : '无需提交')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n✅ 真实 GitHub 往返通过')
