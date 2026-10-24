/**
 * 首次同步的回归测试。
 *
 * 场景：两台机器各自都已经攒了很多内容（会话、工作区、插件清单、设置层），
 * 第一次连同一个私有仓库。要求是「并集合并、不覆盖」，而不是整份覆盖。
 *
 * 真分叉的部分仍按保守策略处理（保留本地 + 远端另存），这里锁住的是
 * 「包含关系直接采用超集」这条快路径，以及首次同步的可观测性。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { threeWayMergeText } from '../lib/datasets.js'
import { dataPaths } from '../lib/config.js'
import { planSync } from '../lib/merge.js'

const PATCH_LOCAL = ['a: 1', 'b: 2'].join('\n')
const PATCH_REMOTE_SUPERSET = ['a: 1', 'b: 2', 'c: 3'].join('\n')
const PATCH_LOCAL_SUPERSET = ['a: 1', 'b: 2', 'z: 9'].join('\n')
const PATCH_DIVERGED = ['a: 1', 'b: 222'].join('\n')

test('首次同步 · 远端是本地子集 → 保持本地，不产生冲突', () => {
  const out = threeWayMergeText(null, PATCH_LOCAL, 'a: 1')
  assert.equal(out.text, PATCH_LOCAL)
  assert.equal(out.conflicts, 0)
  assert.equal(out.adopted, 'local')
})

test('首次同步 · 本地是远端子集 → 采用远端（纯增量）', () => {
  const out = threeWayMergeText(null, PATCH_LOCAL, PATCH_REMOTE_SUPERSET)
  assert.equal(out.text, PATCH_REMOTE_SUPERSET)
  assert.equal(out.conflicts, 0)
  assert.equal(out.adopted, 'remote')
})

test('首次同步 · 本地是超集 → 保持本地，不产生冲突', () => {
  const out = threeWayMergeText(null, PATCH_LOCAL_SUPERSET, PATCH_LOCAL)
  assert.equal(out.text, PATCH_LOCAL_SUPERSET)
  assert.equal(out.conflicts, 0)
})

test('首次同步 · 真分叉 → 保留本地并标冲突（调用方另存远端）', () => {
  const out = threeWayMergeText(null, PATCH_LOCAL, PATCH_DIVERGED)
  assert.equal(out.text, PATCH_LOCAL)
  assert.equal(out.conflicts, 1)
})

test('首次同步 · 相同内容不产生冲突也不变化', () => {
  const out = threeWayMergeText(null, PATCH_LOCAL, PATCH_LOCAL)
  assert.equal(out.text, PATCH_LOCAL)
  assert.equal(out.conflicts, 0)
})

/** 造一个临时 DSH_HOME + 镜像。 */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-first-'))
  const paths = dataPaths(home)
  const mirror = path.join(home, 'mirror')
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })
  fs.mkdirSync(paths.sessions, { recursive: true })
  fs.mkdirSync(paths.pluginHome, { recursive: true })
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
  return { home, paths, mirror }
}

const SETTINGS = {
  profile: 'desktop',
  include: { sessions: true, workspace: true, plugins: false, settings: false },
  sessions: { strategy: 'union', maxPerFileMB: 64 },
}

test('首次同步会被标记（stats.firstSync），并给出不覆盖的提示', () => {
  const { paths, mirror } = sandbox()
  fs.mkdirSync(path.join(mirror, 'sessions'), { recursive: true })

  const { stats } = planSync({ paths, settings: SETTINGS, mirror })
  assert.equal(stats.firstSync, true)
  assert.ok(stats.warnings.some((w) => w.includes('首次同步')))
})

test('合并进来的工作区指向本机不存在的路径 → 只报告（stats.workspace.missingPaths）', () => {
  const { home, paths, mirror } = sandbox()
  const localPath = path.join(home, 'real-workspace')
  fs.mkdirSync(localPath, { recursive: true })

  const local = {
    tables: { workspaces: { 'w-local': { id: 'w-local', title: '本地', path: localPath, updatedAt: '2026-10-01T00:00:00.000Z' } } },
  }
  const remote = {
    tables: {
      workspaces: {
        'w-local': { id: 'w-local', title: '本地', path: localPath, updatedAt: '2026-10-01T00:00:00.000Z' },
        'w-remote': { id: 'w-remote', title: '另一台的', path: 'Z:\\不存在的目录', updatedAt: '2026-10-02T00:00:00.000Z' },
      },
    },
  }
  fs.mkdirSync(path.join(mirror, 'workspace'), { recursive: true })
  fs.mkdirSync(path.dirname(paths.workspace), { recursive: true })
  fs.writeFileSync(paths.workspace, `${JSON.stringify(local, null, 2)}\n`)
  fs.writeFileSync(path.join(mirror, 'workspace', 'workspace.json'), `${JSON.stringify(remote, null, 2)}\n`)

  const { stats } = planSync({ paths, settings: SETTINGS, mirror })
  assert.deepEqual(stats.workspace.missingPaths, ['Z:\\不存在的目录'])
})
