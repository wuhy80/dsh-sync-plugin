/**
 * 两处边界修复的回归测试：
 *
 * 1. 工作区的 `path` 是本机属性 —— 另一台机器的路径在本机不存在，
 *    不能被「较新的一侧」整份覆盖（否则本机工作区指向对方的目录）。
 * 2. 两台机器续写过同一个会话时，尾段按事件时间归并，而不是
 *    「本地全在前、远端全在后」；判不了时间就安全退回老行为。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeWorkspace } from '../lib/datasets.js'
import { encodeFrames, mergeSessionBuffers, splitFrames, linesOf } from '../lib/sessions.js'

const line = (time, text) => JSON.stringify({ time, data: text })
const toBuf = (lines) => encodeFrames(lines)
const readBack = (buf) => linesOf(splitFrames(buf).frames).map((l) => JSON.parse(l).data)

test('工作区 path：远端更新更晚也不覆盖本机路径', () => {
  const local = {
    tables: { workspaces: { w1: { id: 'w1', title: 'demo', path: 'D:\\local\\demo', updatedAt: '2026-01-01T00:00:00.000Z' } } },
  }
  const remote = {
    tables: { workspaces: { w1: { id: 'w1', title: 'demo!', path: 'Z:\\other\\demo', updatedAt: '2026-12-31T00:00:00.000Z' } } },
  }
  const { merged, stats } = mergeWorkspace(local, remote)
  const w = merged.tables.workspaces.w1
  assert.equal(w.path, 'D:\\local\\demo', '本机路径必须保留')
  assert.equal(w.title, 'demo!', '其余字段仍取较新的一侧')
  assert.equal(stats.pathConflicts.length, 1, '冲突仍要报出来')
})

test('工作区 path：本地没有路径时才采用远端的', () => {
  const local = { tables: { workspaces: { w1: { id: 'w1', title: 'demo', updatedAt: '2026-01-01T00:00:00.000Z' } } } }
  const remote = { tables: { workspaces: { w1: { id: 'w1', title: 'demo', path: 'Z:\\other\\demo', updatedAt: '2026-12-31T00:00:00.000Z' } } } }
  const { merged } = mergeWorkspace(local, remote)
  assert.equal(merged.tables.workspaces.w1.path, 'Z:\\other\\demo')
})

test('会话分叉：两侧尾段按事件时间归并', () => {
  const head = [JSON.stringify({ type: 'session', createdAt: 1000, data: 'head' })]
  const local = [...head, line(1100, 'L1'), line(1300, 'L2')]
  const remote = [...head, line(1200, 'R1'), line(1400, 'R2')]

  const out = mergeSessionBuffers(toBuf(local), toBuf(remote))
  assert.equal(out.mode, 'union')
  assert.equal(out.interleaved, true)
  assert.deepEqual(readBack(out.buffer), ['head', 'L1', 'R1', 'L2', 'R2'])
})

test('会话分叉：时间相同 → 本地优先（稳定）', () => {
  const head = [JSON.stringify({ type: 'session', createdAt: 1000, data: 'head' })]
  const local = [...head, line(1100, 'L1')]
  const remote = [...head, line(1100, 'R1')]

  const out = mergeSessionBuffers(toBuf(local), toBuf(remote))
  assert.deepEqual(readBack(out.buffer), ['head', 'L1', 'R1'])
})

test('会话分叉：有一行取不到时间 → 安全退回「本地尾段在前」', () => {
  const head = [JSON.stringify({ type: 'session', createdAt: 1000, data: 'head' })]
  const local = [...head, line(1100, 'L1'), JSON.stringify({ data: 'no-time' })]
  const remote = [...head, line(1200, 'R1')]

  const out = mergeSessionBuffers(toBuf(local), toBuf(remote))
  assert.equal(out.interleaved, false)
  assert.deepEqual(readBack(out.buffer), ['head', 'L1', 'no-time', 'R1'])
})

test('会话分叉：某一侧时间非递增（时钟乱跳）→ 退回老行为', () => {
  const head = [JSON.stringify({ type: 'session', createdAt: 1000, data: 'head' })]
  const local = [...head, line(1300, 'L1'), line(1100, 'L2')]
  const remote = [...head, line(1200, 'R1')]

  const out = mergeSessionBuffers(toBuf(local), toBuf(remote))
  assert.equal(out.interleaved, false)
  assert.deepEqual(readBack(out.buffer), ['head', 'L1', 'L2', 'R1'])
})
