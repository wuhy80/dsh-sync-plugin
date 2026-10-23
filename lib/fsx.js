/**
 * 路径工具：Windows 长路径（>240 字符）与跨进程锁。
 *
 * 为什么需要：镜像仓库里会话落在 `repo/sessions/<slug>/<sessionId>/...`，
 * slug 由工作区绝对路径派生，深层目录很容易把总路径推过 260 字符上限。
 * Node 的 fs 支持 `\\?\` 前缀绕过该限制，但**不能**用在相对路径上。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'
const LONG_THRESHOLD = 240

/** 给可能超长的 Windows 绝对路径加上 `\\?\` 前缀（其它平台原样返回）。 */
export function winPath(p) {
  if (!WIN) return p
  const s = String(p)
  if (s.startsWith('\\\\?\\')) return s
  const abs = path.isAbsolute(s) ? s : path.resolve(s)
  return abs.length >= LONG_THRESHOLD ? `\\\\?\\${abs}` : abs
}

/** 是否存在（长路径安全）。 */
export function exists(p) {
  try {
    return fs.existsSync(winPath(p))
  } catch {
    return false
  }
}

/** 读文件（长路径安全）。 */
export function readFile(p, encoding = 'utf8') {
  return fs.readFileSync(winPath(p), encoding)
}

/** 读文本，不存在返回 null。 */
export function readIf(p) {
  try {
    if (!p || !exists(p)) return null
    return readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** 递归建目录（长路径安全）。 */
export function mkdirp(p) {
  fs.mkdirSync(winPath(p), { recursive: true })
}

/**
 * 原子写：同目录临时文件 + rename（长路径安全）。
 * 临时名带 pid + 时间戳，避免并发写互相覆盖。
 */
export function writeAtomic(absPath, data) {
  const target = winPath(absPath)
  mkdirp(path.dirname(absPath))
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, target)
}

/** 复制文件（长路径安全）。 */
export function copyFile(src, dest) {
  mkdirp(path.dirname(dest))
  fs.copyFileSync(winPath(src), winPath(dest))
}

// ── 跨进程锁 ──────────────────────────────────────────────────────────────

/**
 * 用独占创建（`wx`）实现跨进程互斥。
 *
 * 进程内互斥只能防住同一个 DSH 实例；两个实例同时同步仍会撞 git。
 * 锁文件里记录 pid/主机/时间，超过 staleMs 或 pid 已不存在时视为陈旧锁可直接抢占
 * （同步耗时通常 <1 分钟，30 分钟阈值足够保守）。
 *
 * @param {string} lockPath
 * @param {{ staleMs?: number, now?: number }} [options]
 * @returns {{ ok: true, release: () => void } | { ok: false, holder: object | null }}
 */
export function acquireLock(lockPath, options = {}) {
  const { staleMs = 30 * 60 * 1000, now = Date.now() } = options
  const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), at: now })

  const tryCreate = () => {
    mkdirp(path.dirname(lockPath))
    const fd = fs.openSync(winPath(lockPath), 'wx')
    fs.writeSync(fd, payload)
    fs.closeSync(fd)
  }

  try {
    tryCreate()
    return { ok: true, release: () => releaseLock(lockPath, process.pid) }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  // 已存在：判断是否陈旧
  let holder = null
  try {
    holder = JSON.parse(readFile(lockPath, 'utf8'))
  } catch {
    holder = null
  }

  const stale = !holder || now - Number(holder.at ?? 0) > staleMs || !pidAlive(holder.pid)
  if (stale) {
    try {
      fs.rmSync(winPath(lockPath), { force: true })
      tryCreate()
      return { ok: true, release: () => releaseLock(lockPath, process.pid) }
    } catch {
      /* 抢占失败：当作被占用 */
    }
  }
  return { ok: false, holder }
}

/** 释放锁（只删自己持有的那把）。 */
export function releaseLock(lockPath, pid = process.pid) {
  try {
    const holder = JSON.parse(readFile(lockPath, 'utf8'))
    if (Number(holder?.pid) !== Number(pid)) return false
    fs.rmSync(winPath(lockPath), { force: true })
    return true
  } catch {
    return false
  }
}

/** pid 是否还活着（Windows/POSIX 都用 signal 0）。 */
function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM' // 存在但无权限 → 视为活着
  }
}
