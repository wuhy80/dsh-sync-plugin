/**
 * 会话合并：多帧 zstd 追加日志的「行级并集」。
 *
 * 实测事实（2026-10-22，本机 8.7 MB 会话）：
 *   - `session.v4.jsonl.zstd` 不是单个 zstd 流，而是**一串独立帧**的顺序拼接：
 *     该文件含 3550 个帧、解开共 5973 行 JSONL，逐帧解码 0 失败。
 *   - DSH 每次追加就把新事件压成一帧接在末尾，因此文件天然是「追加日志」。
 *
 * 这决定了合并不必走「保留冲突副本」，可以直接做**行级并集**：
 *   1. 两侧逐帧解压 → 行数组；
 *   2. 取最长公共前缀（会话是追加日志，前缀必然逐字节一致）；
 *   3. 前缀 + 本地尾段 + 远端独有尾段（按内容去重）→ 一条都不丢，也不会重放本地已有的行；
 *   4. 重新按块压成帧写回（默认 256 行/帧）。
 *
 * 一侧是另一侧前缀时走**快速路径**：直接返回较长那份的原始字节（零重编码风险）。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const FRAME_LINES = 256

/** 会话文件后缀（只认这个；其它文件原样镜像，不参与合并）。 */
export const SESSION_FILE = 'session.v4.jsonl.zstd'

/**
 * 帧内容是否可信：非空、以换行结尾、每行都是合法 JSON（单行一个事件）。
 *
 * 依据（2026-10-22 实测真实会话）：3550 帧全部非空且以 '\n' 结尾。
 * 截断/半写/被污染的帧解出来会缺尾巴或出半行 JSON —— 这种帧**不参与合并**，
 * 宁可在上层走 keep-local 让两侧都不动，也不要把残缺内容并进另一台机器。
 */
export function frameLooksValid(text) {
  if (!text || !text.endsWith('\n')) return false
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      JSON.parse(line)
    } catch {
      return false
    }
  }
  return true
}

/**
 * 把缓冲区切成帧并逐帧解码。
 * magic 可能出现在压缩数据内部，所以解码失败时把候选区间向后扩一帧再试。
 * @returns {{ frames: {raw: Buffer, text: string}[], broken: number }}
 */
export function splitFrames(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i)
    i += 4
  }
  if (!starts.length) return { frames: [], broken: 0 }
  if (starts[0] !== 0) starts.unshift(0)

  const frames = []
  let broken = 0
  let k = 0
  while (k < starts.length) {
    let ok = false
    for (let j = k + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length
      if (end <= starts[k]) continue
      try {
        const text = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
        if (!frameLooksValid(text)) {
          // 解开了但内容不完整（截断 / 半行 JSON）：按损坏处理，让上层拒绝合并
          broken++
          frames.push({ raw: buf.subarray(starts[k], end), text: '', broken: true })
          k = j
          ok = true
          break
        }
        frames.push({ raw: buf.subarray(starts[k], end), text })
        k = j
        ok = true
        break
      } catch {
        /* 扩一帧重试 */
      }
    }
    if (!ok) {
      broken++
      frames.push({ raw: buf.subarray(starts[k]), text: '', broken: true })
      k = starts.length
    }
  }
  return { frames, broken }
}

/** 拆行：去掉尾部空行，保留行内容原样（不改字节，避免破坏事件哈希）。 */
export function linesOf(frames) {
  const out = []
  for (const f of frames) {
    if (!f.text) continue
    for (const line of f.text.split('\n')) {
      if (line.length) out.push(line)
    }
  }
  return out
}

/** 编码回帧：每 FRAME_LINES 行一帧。 */
export function encodeFrames(lines, perFrame = FRAME_LINES) {
  const parts = []
  for (let i = 0; i < lines.length; i += perFrame) {
    const chunk = `${lines.slice(i, i + perFrame).join('\n')}\n`
    parts.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')))
  }
  return Buffer.concat(parts)
}

/** 公共前缀长度。 */
export function commonPrefix(a, b) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * 合并两个会话文件内容。
 * @param {Buffer} localBuf
 * @param {Buffer} remoteBuf
 * @param {{ strategy?: 'union'|'fork' }} [options]
 * @returns {{ buffer: Buffer, mode: string, added: number, localLines: number, remoteLines: number, prefix: number }}
 */
export function mergeSessionBuffers(localBuf, remoteBuf, options = {}) {
  const { strategy = 'union' } = options
  const local = splitFrames(localBuf)
  const remote = splitFrames(remoteBuf)

  // 解不开的帧不参与合并（交给上层保留原件、告警）
  if (local.broken || remote.broken) {
    return {
      buffer: localBuf,
      mode: 'unmergeable',
      added: 0,
      localLines: 0,
      remoteLines: 0,
      prefix: 0,
    }
  }

  const a = linesOf(local.frames)
  const b = linesOf(remote.frames)
  const prefix = commonPrefix(a, b)

  // 快速路径：一方是另一方的前缀 → 直接取长的那份原始字节
  if (prefix === a.length) {
    if (prefix === b.length) {
      return { buffer: localBuf, mode: 'identical', added: 0, localLines: a.length, remoteLines: b.length, prefix }
    }
    return { buffer: remoteBuf, mode: 'remote-ahead', added: b.length - prefix, localLines: a.length, remoteLines: b.length, prefix }
  }
  if (prefix === b.length) {
    return { buffer: localBuf, mode: 'local-ahead', added: 0, localLines: a.length, remoteLines: b.length, prefix }
  }

  // 真正分叉：前缀 + 本地尾 + 远端独有尾（按整行去重）
  if (strategy === 'fork') {
    return { buffer: localBuf, mode: 'fork-local-kept', added: b.length - prefix, localLines: a.length, remoteLines: b.length, prefix }
  }

  const localTail = a.slice(prefix)
  const seen = new Set(localTail)
  const remoteOnly = b.slice(prefix).filter((line) => !seen.has(line))
  const ordered = orderByTime(a.slice(0, prefix), localTail, remoteOnly)
  return {
    buffer: encodeFrames(ordered.lines),
    mode: 'union',
    added: remoteOnly.length,
    localLines: a.length,
    remoteLines: b.length,
    prefix,
    // true = 两侧尾段按事件时间做了归并；false = 退回「本地尾段在前」
    interleaved: ordered.interleaved,
  }
}

/** 从会话行里取事件时间（epoch ms）：优先 `time`，其次 `createdAt`。 */
function eventTime(line) {
  try {
    const j = JSON.parse(line)
    const value = j?.time ?? j?.createdAt
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** 时间序列是否非递减（时钟被拨回/乱序时就不要按时间归并）。 */
function nonDecreasing(times) {
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) return false
  }
  return true
}

/**
 * 前缀 + 两侧尾段：能判定时间就按时间归并（各自内部顺序保持不变），
 * 否则退回「本地尾段在前 + 远端独有行」。
 *
 * 为什么：两台机器续写过同一个会话时，「本地全在前、远端全在后」会打乱真实发生顺序；
 * 按事件时间归并更接近事实，而且稳定（相同时间戳本地优先）。
 * 只要有一行取不到时间、或某一侧不是非递减，就不冒险，走老路径。
 */
function orderByTime(head, localTail, remoteTail) {
  const fallback = () => ({ lines: [...head, ...localTail, ...remoteTail], interleaved: false })
  if (localTail.length === 0 || remoteTail.length === 0) return fallback()

  const lt = localTail.map(eventTime)
  const rt = remoteTail.map(eventTime)
  if (lt.includes(null) || rt.includes(null)) return fallback()
  if (!nonDecreasing(lt) || !nonDecreasing(rt)) return fallback()

  const lines = [...head]
  let i = 0
  let j = 0
  while (i < localTail.length && j < remoteTail.length) {
    if (lt[i] <= rt[j]) lines.push(localTail[i++])
    else lines.push(remoteTail[j++])
  }
  while (i < localTail.length) lines.push(localTail[i++])
  while (j < remoteTail.length) lines.push(remoteTail[j++])
  return { lines, interleaved: true }
}

/** 读文件并合并（文件不存在时按空处理）。 */
export function mergeSessionFiles(localPath, remotePath, options = {}) {
  const localBuf = fs.existsSync(localPath) ? fs.readFileSync(localPath) : Buffer.alloc(0)
  const remoteBuf = fs.existsSync(remotePath) ? fs.readFileSync(remotePath) : Buffer.alloc(0)
  if (!localBuf.length && !remoteBuf.length) {
    return { buffer: Buffer.alloc(0), mode: 'empty', added: 0, localLines: 0, remoteLines: 0, prefix: 0 }
  }
  if (!localBuf.length) {
    return { buffer: remoteBuf, mode: 'adopt-remote', added: 0, localLines: 0, remoteLines: 0, prefix: 0 }
  }
  if (!remoteBuf.length) {
    return { buffer: localBuf, mode: 'keep-local', added: 0, localLines: 0, remoteLines: 0, prefix: 0 }
  }
  return mergeSessionBuffers(localBuf, remoteBuf, options)
}

/**
 * 扫描会话根目录：返回 `<工作区slug>/<会话id>` → 文件绝对路径 的映射。
 * 只收 SESSION_FILE；其它文件（备份等）不参与同步。
 * @param {string} root
 */
export function scanSessions(root) {
  const out = new Map()
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const s of sessions) {
      const file = path.join(wsDir, s.name, SESSION_FILE)
      if (fs.existsSync(file)) out.set(`${ws.name}/${s.name}`, file)
    }
  }
  return out
}
