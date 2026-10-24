/**
 * 跨机路径映射的回归测试。
 *
 * 现实场景：Windows 上工作区在 `D:\code\llm-news`，Mac 上在 `/Users/wuhy/code/llm-news`。
 * 只搬注册表的话，Mac 会得到一个指向 Window 路径的工作区（打不开），里面的会话也
 * 挂不到本机 slug（点开是空的）。这里锁住：路径能映射、会话能改挂、镜像里保留原路径。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parsePathMap, mapPath, slugOf } from '../lib/paths.js'
import { dataPaths } from '../lib/config.js'
import { planSync, applyPlan } from '../lib/merge.js'
import { encodeFrames, SESSION_FILE } from '../lib/sessions.js'

test('slugOf 与本机真实会话目录一致', () => {
  assert.equal(slugOf('D:\\code\\llm-news'), '--D-code-llm-news--')
  assert.equal(slugOf('C:\\Users\\Administrator\\.dsh\\profiles\\desktop'), '--C-Users-Administrator-.dsh-profiles-desktop--')
  assert.equal(slugOf('D:\\githubCode\\octocat\\Hello-World'), '--D-githubCode-octocat-Hello-World--')
  assert.equal(slugOf('/Users/wuhy/code/llm-news'), '--Users-wuhy-code-llm-news--')
})

test('parsePathMap：三种分隔写法、注释、最长前缀优先', () => {
  const rules = parsePathMap([
    '# 注释',
    'D:\\code => /Users/wuhy/code',
    'D:\\code\\special -> /Volumes/special',
    'C:\\Users=  /Users/wuhy',
    '',
  ])
  assert.equal(rules.length, 3)
  assert.equal(rules[0].from, 'D:/code/special', '最长前缀排最前')
  assert.equal(rules.find((rule) => rule.from === 'D:/code').to, '/Users/wuhy/code')
})

test('mapPath：命中前缀且本机存在才映射', () => {
  const rules = parsePathMap(['D:\\code => /Users/wuhy/code'])
  const exists = (p) => p === '/Users/wuhy/code/llm-news'
  assert.equal(mapPath('D:\\code\\llm-news', rules, exists), '/Users/wuhy/code/llm-news')
  assert.equal(mapPath('D:\\code\\missing', rules, exists), null, '目标不存在就不映射')
  assert.equal(mapPath('E:\\other', rules, exists), null, '不在规则下返回 null')
})

test('mapPath：Windows → Windows 也成立（保留反斜杠风格）', () => {
  const rules = parsePathMap(['D:\\code => E:\\work'])
  assert.equal(mapPath('D:\\code\\x', rules, () => true), 'E:\\work\\x')
})

/** 造一个「本机 + 镜像」沙盒：远端工作区在 D:\code\demo，映射到 <tmp>/mapped/demo。 */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-map-'))
  const paths = dataPaths(home)
  const mirror = path.join(home, 'mirror')
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(mirror, 'workspace'), { recursive: true })
  fs.mkdirSync(paths.sessions, { recursive: true })
  fs.mkdirSync(paths.pluginHome, { recursive: true })
  const localDemo = path.join(home, 'mapped', 'demo')
  fs.mkdirSync(localDemo, { recursive: true })
  return { home, paths, mirror, localDemo }
}

test('路径映射：工作区落到本机目录，会话改挂到本机 slug，镜像保留原路径', () => {
  const { home, paths, mirror, localDemo } = sandbox()
  const remotePath = 'D:\\code\\demo'
  const remoteSlug = slugOf(remotePath)
  const localSlug = slugOf(localDemo)

  // 镜像：一个远端工作区 + 它在远端 slug 下的一个会话
  const remoteWs = {
    tables: { workspaces: { w1: { id: 'w1', title: 'demo', path: remotePath, sessionIds: ['session-1'], updatedAt: '2026-10-01T00:00:00.000Z' } } },
  }
  fs.writeFileSync(path.join(mirror, 'workspace', 'workspace.json'), `${JSON.stringify(remoteWs, null, 2)}\n`)
  const sessionDir = path.join(mirror, 'sessions', remoteSlug, 'session-1')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, SESSION_FILE), encodeFrames([JSON.stringify({ type: 'session', createdAt: 1, data: 'hello' })]))

  // 本机：没有 workspace.json（首次接到远端）
  const settings = {
    profile: 'desktop',
    pathMap: [`D:\\code => ${path.join(home, 'mapped')}`],
    include: { sessions: true, workspace: true, plugins: false, settings: false },
    sessions: { strategy: 'union', maxPerFileMB: 64, relocate: true },
  }

  const { plan, stats } = planSync({ paths, settings, mirror })
  assert.equal(stats.workspace.mapped.length, 1, '工作区应被映射')

  const localDecision = plan.decisions.find((d) => d.kind === 'session' && String(d.key).startsWith(localSlug))
  assert.ok(localDecision, '会话应改挂到本机 slug')
  assert.equal(localDecision.key, `${localSlug}/session-1`)

  const wsDecision = plan.decisions.find((d) => d.kind === 'workspace')
  assert.ok(wsDecision, '工作区注册表要写本地')
  assert.match(wsDecision.localText, /demo/, '本机视角带映射后的路径')
  assert.ok(wsDecision.localText.includes(localDemo.replace(/\\/g, '\\\\')), '本机路径已映射')
  assert.ok(wsDecision.repoText.includes('D:\\\\code\\\\demo'), '镜像保留远端原路径')

  applyPlan(plan, { paths, mirror })
  assert.ok(fs.existsSync(path.join(paths.sessions, localSlug, 'session-1', SESSION_FILE)), '会话已落到本机 slug')
  assert.ok(!fs.existsSync(path.join(paths.sessions, remoteSlug, 'session-1', SESSION_FILE)), '不在本机重复留远端 slug 副本')

  const written = JSON.parse(fs.readFileSync(path.join(mirror, 'workspace', 'workspace.json'), 'utf8'))
  assert.equal(written.tables.workspaces.w1.path, remotePath, '镜像里的路径不能被本机路径覆盖')
})

test('映射不上时保持原样，并报告缺失路径', () => {
  const { home, paths, mirror } = sandbox()
  const remoteWs = {
    tables: { workspaces: { w1: { id: 'w1', title: 'demo', path: 'D:\\code\\demo', sessionIds: [], updatedAt: '2026-10-01T00:00:00.000Z' } } },
  }
  fs.writeFileSync(path.join(mirror, 'workspace', 'workspace.json'), `${JSON.stringify(remoteWs, null, 2)}\n`)

  const settings = {
    profile: 'desktop',
    pathMap: [],
    include: { sessions: true, workspace: true, plugins: false, settings: false },
    sessions: { strategy: 'union', maxPerFileMB: 64, relocate: true },
  }
  const { stats } = planSync({ paths, settings, mirror })
  assert.deepEqual(stats.workspace.mapped, [])
  assert.deepEqual(stats.workspace.missingPaths, ['D:\\code\\demo'])
})
