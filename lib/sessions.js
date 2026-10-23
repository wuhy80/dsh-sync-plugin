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
  const merged = [...a.slice(0, prefix), ...localTail, ...remoteOnly]
  return {
    buffer: encodeFrames(merged),
    mode: 'union',
    added: remoteOnly.length,
    localLines: a.length,
    remoteLines: b.length,
    prefix,
  }
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
