/**
 * 删除传播（墓碑）与跨目录会话合并的回归测试。
 *
 * 这两块针对的是「并集语义的副作用」：
 *   1. 删掉的会话会被下一次同步拉回来 → 用墓碑把删除也变成可传播的事实；
 *   2. 同一个会话在两台机器上落在不同工作区目录 → 按 session id 合并内容。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { dataPaths } from '../lib/config.js'
import { encodeFrames, splitFrames, linesOf, SESSION_FILE } from '../lib/sessions.js'
import { planSync, applyPlan, readLocalTombstones, readRepoTombstones } from '../lib/merge.js'

const SETTINGS = {
  profile: 'desktop',
  include: { sessions: true, workspace: false, plugins: false, settings: false },
  sessions: { strategy: 'union', maxPerFileMB: 64 },
}

/** 造一个临时 DSH_HOME + 镜像仓库。 */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-tomb-'))
  const paths = dataPaths(home)
  const mirror = path.join(home, 'mirror')
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })
  fs.mkdirSync(paths.sessions, { recursive: true })
  fs.mkdirSync(paths.pluginHome, { recursive: true })
  return { home, paths, mirror }
}

/** 写一个会话文件（lines 是 JSONL 行内容）。 */
function writeSession(root, ws, sid, lines) {
  const dir = path.join(root, ws, sid)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SESSION_FILE)
  fs.writeFileSync(file, encodeFrames(lines.map((n) => JSON.stringify({ n }))))
  return file
}

/** 读回会话的行内容。 */
function readSession(root, ws, sid) {
  const file = path.join(root, ws, sid, SESSION_FILE)
  if (!fs.existsSync(file)) return null
  return linesOf(splitFrames(fs.readFileSync(file)).frames).map((l) => JSON.parse(l).n)
}

const wsA = '--D-code-demo--'
const wsB = '--E-code-demo--'
const sid = 'session-0001'

test('本机删除会话 → 墓碑同步删除远端副本', () => {
  const { paths, mirror } = sandbox()
  writeSession(paths.sessions, wsA, sid, [1, 2])
  writeSession(mirror + '/sessions', wsA, sid, [1, 2])

  // 上一次同步结束时本机还有这个会话
  fs.writeFileSync(paths.state, JSON.stringify({ version: 1, knownSessions: { [`${wsA}/${sid}`]: true } }))

  // 用户把它删了
  fs.rmSync(path.join(paths.sessions, wsA, sid), { recursive: true, force: true })

  const { plan, stats } = planSync({ paths, settings: SETTINGS, mirror })
  const removal = plan.decisions.find((d) => d.action === 'remove')
  assert.ok(removal, '应产生一条删除决策')
  assert.equal(removal.key, `${wsA}/${sid}`)
  assert.equal(removal.writeRepo, true, '远端那份也要删')

  applyPlan(plan, { paths, mirror })

  assert.equal(readSession(mirror + '/sessions', wsA, sid), null, '镜像里的会话应被删除')
  assert.deepEqual(Object.keys(readLocalTombstones(paths)), [`${wsA}/${sid}`], '本机应记下墓碑')
  assert.ok(stats.sessions.deleted >= 1)

  const tomb = JSON.parse(fs.readFileSync(path.join(mirror, 'sessions', '_tombstones.json'), 'utf8'))
  assert.deepEqual(Object.keys(tomb.deleted), [`${wsA}/${sid}`], '墓碑要推给远端')

  // 再跑一次：不该反复删、也不该复活
  const again = planSync({ paths, settings: SETTINGS, mirror })
  assert.equal(again.plan.decisions.filter((d) => d.action === 'remove').length, 0)
})

test('远端墓碑 → 删掉本机这份（删前备份）', () => {
  const { paths, mirror } = sandbox()
  writeSession(paths.sessions, wsA, sid, [1, 2])

  const future = new Date(Date.now() + 60_000).toISOString()
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(mirror, 'sessions', '_tombstones.json'), JSON.stringify({ version: 1, deleted: { [`${wsA}/${sid}`]: future } }))
  writeSession(mirror + '/sessions', wsA, sid, [1, 2])

  const { plan } = planSync({ paths, settings: SETTINGS, mirror })
  const removal = plan.decisions.find((d) => d.action === 'remove')
  assert.ok(removal)
  assert.equal(removal.writeLocal, true)

  const { backup } = applyPlan(plan, { paths, mirror })
  assert.equal(readSession(paths.sessions, wsA, sid), null, '本机那份应被删除')
  assert.ok(backup.saved.includes(`sessions/${wsA}/${sid}/${SESSION_FILE}`), '删除前必须备份')
})

test('删除之后本机又写过 → 以写入为准，复活', () => {
  const { paths, mirror } = sandbox()
  const file = writeSession(paths.sessions, wsA, sid, [1, 2, 3])

  const past = new Date(Date.now() - 60_000).toISOString()
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(mirror, 'sessions', '_tombstones.json'), JSON.stringify({ version: 1, deleted: { [`${wsA}/${sid}`]: past } }))
  writeSession(mirror + '/sessions', wsA, sid, [1])

  const { plan, stats } = planSync({ paths, settings: SETTINGS, mirror })
  assert.equal(plan.decisions.filter((d) => d.action === 'remove').length, 0, '不该删本地')
  assert.equal(stats.sessions.resurrected, 1)
  assert.ok(fs.existsSync(file))

  applyPlan(plan, { paths, mirror })
  assert.deepEqual(Object.keys(readRepoTombstones(mirror)), [], '墓碑应被清掉')
  assert.deepEqual(readSession(mirror + '/sessions', wsA, sid), [1, 2, 3], '远端应补上本机的新事件')
})

test('同一会话落在不同工作区目录 → 按 session id 合并内容', () => {
  const { paths, mirror } = sandbox()
  writeSession(paths.sessions, wsA, sid, [1, 2])
  writeSession(mirror + '/sessions', wsB, sid, [1, 3])

  const { plan, stats } = planSync({ paths, settings: SETTINGS, mirror })
  const merges = plan.decisions.filter((d) => d.kind === 'session' && d.action === 'merge')
  assert.equal(merges.length, 2, '本地一份、远端一份，各写回')
  assert.equal(stats.sessions.crossSlug, 1)
  assert.ok(
    stats.warnings.some((w) => w.includes('工作区目录不同')),
    '要提示两端路径不一致',
  )

  applyPlan(plan, { paths, mirror })
  assert.deepEqual(readSession(paths.sessions, wsA, sid), [1, 2, 3])
  assert.deepEqual(readSession(mirror + '/sessions', wsB, sid), [1, 2, 3])
})

test('没有墓碑时不产生墓碑决策（避免空提交）', () => {
  const { paths, mirror } = sandbox()
  writeSession(paths.sessions, wsA, sid, [1])
  writeSession(mirror + '/sessions', wsA, sid, [1])

  const { plan } = planSync({ paths, settings: SETTINGS, mirror })
  assert.equal(plan.decisions.length, 0, '两侧一致时不该有任何决策')
})

test('被同步排除的数据仍然写不进镜像（墓碑机制不绕过黑名单）', () => {
  const { paths, mirror } = sandbox()
  assert.throws(() => {
    const { plan } = planSync({ paths, settings: SETTINGS, mirror })
    plan.decisions.push({ kind: 'session', action: 'push', rel: 'sessions/x/y/node_modules/a', buffer: Buffer.from('x') })
    applyPlan(plan, { paths, mirror })
  }, /拒绝写入被排除的路径/)
})
