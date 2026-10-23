import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { encodeFrames, splitFrames, linesOf, commonPrefix, mergeSessionBuffers, mergeSessionFiles } from '../lib/sessions.js'
import { mergeWorkspace, mergePluginManifest, threeWayMergeText, compareVersions, isLocalOnlySpec } from '../lib/datasets.js'

const mk = (lines) => encodeFrames(lines, 2)

// ── 会话：多帧 zstd ────────────────────────────────────────────────────────

test('splitFrames 能逐帧解回全部行（多帧追加）', () => {
  const lines = ['{"a":1}', '{"a":2}', '{"a":3}', '{"a":4}', '{"a":5}']
  const buf = mk(lines)
  const { frames, broken } = splitFrames(buf)
  assert.equal(broken, 0)
  assert.ok(frames.length >= 2, '应当是多帧')
  assert.deepEqual(linesOf(frames), lines)
})

test('splitFrames 容忍压缩数据里出现 magic 字节', () => {
  // 两帧 + 中间夹一段伪 magic 的坏字节（模拟脏数据）
  const a = zlib.zstdCompressSync(Buffer.from('{"x":1}\n'))
  const b = zlib.zstdCompressSync(Buffer.from('{"x":2}\n'))
  const dirty = Buffer.concat([a, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), b])
  const { frames } = splitFrames(dirty)
  const lines = linesOf(frames)
  assert.deepEqual(lines, ['{"x":1}', '{"x":2}'])
})

test('mergeSessionBuffers: 完全相同 → identical', () => {
  const buf = mk(['{"e":1}', '{"e":2}'])
  const r = mergeSessionBuffers(buf, buf)
  assert.equal(r.mode, 'identical')
})

test('mergeSessionBuffers: 远端更长（本地是前缀）→ remote-ahead 且用远端原始字节', () => {
  const local = mk(['{"e":1}', '{"e":2}'])
  const remote = mk(['{"e":1}', '{"e":2}', '{"e":3}'])
  const r = mergeSessionBuffers(local, remote)
  assert.equal(r.mode, 'remote-ahead')
  assert.equal(r.buffer.equals(remote), true, '应直接采用远端字节，避免重编码')
})

test('mergeSessionBuffers: 本地更长 → local-ahead', () => {
  const local = mk(['{"e":1}', '{"e":2}', '{"e":3}'])
  const remote = mk(['{"e":1}', '{"e":2}'])
  const r = mergeSessionBuffers(local, remote)
  assert.equal(r.mode, 'local-ahead')
})

test('mergeSessionBuffers: 真分叉 → 行级并集，两侧新增都保留', () => {
  const local = mk(['{"e":1}', '{"e":2}', '{"e":"L"}'])
  const remote = mk(['{"e":1}', '{"e":2}', '{"e":"R"}'])
  const r = mergeSessionBuffers(local, remote)
  assert.equal(r.mode, 'union')
  assert.equal(r.prefix, 2)
  const lines = linesOf(splitFrames(r.buffer).frames)
  assert.deepEqual(lines, ['{"e":1}', '{"e":2}', '{"e":"L"}', '{"e":"R"}'])
  assert.equal(r.added, 1)
})

test('mergeSessionBuffers: fork 策略保留本地', () => {
  const local = mk(['{"e":1}', '{"e":"L"}'])
  const remote = mk(['{"e":1}', '{"e":"R"}'])
  const r = mergeSessionBuffers(local, remote, { strategy: 'fork' })
  assert.equal(r.mode, 'fork-local-kept')
  assert.equal(linesOf(splitFrames(r.buffer).frames)[1], '{"e":"L"}')
})

test('commonPrefix', () => {
  assert.equal(commonPrefix(['a', 'b', 'c'], ['a', 'b', 'd']), 2)
  assert.equal(commonPrefix([], ['a']), 0)
})

// ── 工作区 ────────────────────────────────────────────────────────────────

test('mergeWorkspace: 键并集 + sessionIds 并集 + 取较新 updatedAt', () => {
  const local = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: ['s1'], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        w1: { path: 'D:\\a', title: 'a', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      },
    },
  }
  const remote = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w9', workspaceIds: ['w2'], archivedSessionIds: ['s2'], pinnedSessionIds: ['s3'] },
    tables: {
      workspaces: {
        w1: { path: 'D:\\a', title: 'a2', sessionIds: ['s2'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
        w2: { path: 'D:\\b', title: 'b', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      },
    },
  }
  const { merged, stats } = mergeWorkspace(local, remote)
  assert.deepEqual(merged.global.workspaceIds.sort(), ['w1', 'w2'])
  assert.deepEqual(merged.global.archivedSessionIds.sort(), ['s1', 's2'])
  assert.deepEqual(merged.global.pinnedSessionIds, ['s3'])
  assert.equal(merged.global.defaultWorkspaceId, 'w1', '默认工作区保留本地')
  assert.equal(merged.tables.workspaces.w1.title, 'a2', '取 updatedAt 较新的远端')
  assert.deepEqual(merged.tables.workspaces.w1.sessionIds.sort(), ['s1', 's2'])
  assert.equal(merged.tables.workspaces.w2.title, 'b')
  assert.equal(stats.workspacesAdded, 1)
  assert.equal(stats.workspacesUpdated, 1)
})

test('mergeWorkspace: 同一工作区不同路径要报冲突而不是改写', () => {
  const local = { global: { workspaceIds: ['w1'] }, tables: { workspaces: { w1: { path: 'D:\\a', sessionIds: [], updatedAt: '2026-03-01T00:00:00Z' } } } }
  const remote = { global: { workspaceIds: ['w1'] }, tables: { workspaces: { w1: { path: 'E:\\a', sessionIds: [], updatedAt: '2026-01-01T00:00:00Z' } } } }
  const { merged, stats } = mergeWorkspace(local, remote)
  assert.equal(merged.tables.workspaces.w1.path, 'D:\\a')
  assert.equal(stats.pathConflicts.length, 1)
})

// ── 插件清单 ──────────────────────────────────────────────────────────────

test('compareVersions', () => {
  assert.equal(compareVersions('^1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('^2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('latest', '1.0.0'), 0)
})

test('isLocalOnlySpec', () => {
  assert.equal(isLocalOnlySpec('link:D:/code/x'), true)
  assert.equal(isLocalOnlySpec('file:./x.tgz'), true)
  assert.equal(isLocalOnlySpec('^1.2.3'), false)
})

test('mergePluginManifest: 新增/版本仲裁/bundles 并集/本地 link 标记', () => {
  const local = {
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-a': '^1.0.0', 'dsh-local': 'link:D:/code/local' },
    dsh: { profile: { bundles: ['b1'] } },
  }
  const remote = {
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-a': '^1.2.0', 'dsh-b': '^0.1.0', 'dsh-local': '^9.9.9' },
    dsh: { profile: { bundles: ['b1', 'b2'] } },
  }
  const { merged, stats } = mergePluginManifest(local, remote)
  assert.equal(merged.dependencies['dsh-a'], '^1.2.0', '取更高版本')
  assert.equal(merged.dependencies['dsh-b'], '^0.1.0', '新增远端依赖')
  assert.equal(merged.dependencies['dsh-local'], 'link:D:/code/local', '本地 link 保留')
  assert.deepEqual(merged.dsh.profile.bundles, ['b1', 'b2'])
  assert.equal(merged.dshSync, undefined, '不往清单里写元数据（避免每次都制造「需合并」噪音）')
  assert.deepEqual(stats.localOnly, ['dsh-local'])
  assert.equal(stats.versionConflicts.length >= 1, true)
})

// ── 设置层三路合并 ────────────────────────────────────────────────────────

test('threeWayMergeText: 两侧改不同行 → 都保留', () => {
  const base = ['a', 'b', 'c', 'd'].join('\n')
  const local = ['a', 'B-local', 'c', 'd'].join('\n')
  const remote = ['a', 'b', 'c', 'D-remote'].join('\n')
  const r = threeWayMergeText(base, local, remote)
  assert.equal(r.conflicts, 0)
  assert.equal(r.text, ['a', 'B-local', 'c', 'D-remote'].join('\n'))
})

test('threeWayMergeText: 同一行都改 → 保留本地并计冲突', () => {
  const base = ['a', 'b', 'c'].join('\n')
  const local = ['a', 'L', 'c'].join('\n')
  const remote = ['a', 'R', 'c'].join('\n')
  const r = threeWayMergeText(base, local, remote)
  assert.equal(r.conflicts, 1)
  assert.equal(r.text, ['a', 'L', 'c'].join('\n'))
})

test('threeWayMergeText: 没有 base 时保守取本地', () => {
  const r = threeWayMergeText(null, 'local', 'remote')
  assert.equal(r.text, 'local')
  assert.equal(r.conflicts, 1)
})

test('threeWayMergeText: 一方未改 → 取另一方的编辑', () => {
  const base = ['a', 'b'].join('\n')
  const local = ['a', 'b'].join('\n')
  const remote = ['a', 'b', 'c'].join('\n')
  const r = threeWayMergeText(base, local, remote)
  assert.equal(r.text, ['a', 'b', 'c'].join('\n'))
  assert.equal(r.conflicts, 0)
})
