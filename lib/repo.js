/**
 * Git 传输层：镜像仓库放在 $DSH_HOME/dsh-sync/repo，不碰用户的工作目录。
 *
 * 安全约定（与上游实践一致）：
 * - token 只走环境变量（见 proc.gitEnv），不进 argv、不进 URL 文件；
 * - 推送前若配置了 token，先用 GitHub API 校验仓库是**私有**，公共仓库一律拒绝；
 * - 每次写入前把将被覆盖的本地文件备份到 backup/<时间戳>/。
 */

import fs from 'node:fs'
import path from 'node:path'
import { git, run, scrub } from './proc.js'
import { stamp } from './config.js'

/** 从远端地址解析 owner/repo（支持 https 与 scp 形态）。 */
export function parseOwnerRepo(remote) {
  const s = String(remote ?? '').trim()
  let m = s.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  m = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  m = s.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  return null
}

/** 用 GitHub API 判定仓库是否私有；无 token 或非 GitHub 远端时返回 unknown。 */
export async function checkPrivate({ remote, token }) {
  const parsed = parseOwnerRepo(remote)
  if (!parsed) return { state: 'unknown', reason: '非 GitHub 远端（SSH 私库请自行确认）' }
  if (!token) return { state: 'unknown', reason: '未配置 token，无法调用 API 校验' }
  const r = await run('node', [
    '-e',
    `
    const [owner, repo, token] = process.argv.slice(1);
    fetch('https://api.github.com/repos/' + owner + '/' + repo, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-sync' },
    }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      console.log(JSON.stringify({ status: res.status, private: body.private, full: body.full_name }));
    }).catch((e) => console.log(JSON.stringify({ status: 0, error: String(e) })));
    `,
    parsed.owner,
    parsed.repo,
    token,
  ], { timeout: 30000 })
  if (r.code !== 0) return { state: 'unknown', reason: scrub(r.stderr, [token]) || 'API 调用失败' }
  try {
    const body = JSON.parse(r.stdout.trim().split('\n').pop())
    if (body.status === 200 && body.private === true) return { state: 'private', repo: body.full }
    if (body.status === 200 && body.private === false) return { state: 'public', repo: body.full }
    if (body.status === 404) return { state: 'missing', reason: '仓库不存在或 token 无权访问' }
    return { state: 'unknown', reason: `API ${body.status}` }
  } catch {
    return { state: 'unknown', reason: 'API 响应解析失败' }
  }
}

/** 确保镜像仓库存在并绑定远端；返回 { ready, created, error }。 */
export async function ensureMirror({ mirror, remote, branch, token }) {
  const exists = fs.existsSync(path.join(mirror, '.git'))
  if (!exists) {
    fs.mkdirSync(mirror, { recursive: true })
    const init = await git(['init', '-q', '-b', branch], { cwd: mirror })
    if (init.code !== 0) return { ready: false, error: scrub(init.stderr, [token]) }
  }
  // 远端随设置变化，每次都对齐
  const setUrl = await git(['remote', 'get-url', 'origin'], { cwd: mirror })
  if (setUrl.code !== 0) {
    const add = await git(['remote', 'add', 'origin', remote], { cwd: mirror })
    if (add.code !== 0) return { ready: false, error: scrub(add.stderr, [token]) }
  } else if (setUrl.stdout.trim() !== remote) {
    const set = await git(['remote', 'set-url', 'origin', remote], { cwd: mirror })
    if (set.code !== 0) return { ready: false, error: scrub(set.stderr, [token]) }
  }
  await git(['config', 'user.name', 'dsh-sync'], { cwd: mirror })
  await git(['config', 'user.email', 'dsh-sync@localhost'], { cwd: mirror })
  return { ready: true, created: !exists }
}

/** 拉取远端（快进合并；失败返回详细信息，绝不 force）。 */
export async function fetchAndFastForward({ mirror, branch, remote, token }) {
  const fetch = await git(['fetch', 'origin', branch, '--prune'], { cwd: mirror, token, remote })
  if (fetch.code !== 0) {
    // 远端还没有这个分支（首次推送前的空仓库）：不算失败
    const ls = await git(['ls-remote', '--heads', 'origin', branch], { cwd: mirror, token, remote })
    if (ls.code === 0 && !ls.stdout.trim()) return { ok: true, emptyRemote: true }
    return { ok: false, step: 'fetch', detail: scrub(fetch.stderr, [token]) }
  }
  const check = await git(['rev-parse', '--verify', `origin/${branch}`], { cwd: mirror })
  if (check.code !== 0) {
    // 远端还没有这个分支（首次推送）：不算错误
    return { ok: true, emptyRemote: true }
  }
  const merge = await git(['merge', '--ff-only', `origin/${branch}`], { cwd: mirror, token, remote })
  if (merge.code === 0) return { ok: true, fastForwarded: true }
  // 分叉：走 rebase（仓库里只有同步产物，冲突策略见 merge 层）
  const rebase = await git(['rebase', `origin/${branch}`], { cwd: mirror, token, remote })
  if (rebase.code === 0) return { ok: true, rebased: true }
  return { ok: false, step: 'rebase', detail: scrub(rebase.stderr, [token]) }
}

/** 工作区状态：{ dirty, ahead, behind, files }。 */
export async function mirrorStatus({ mirror, branch, remote, token }) {
  const st = await git(['status', '--porcelain'], { cwd: mirror })
  const dirty = st.code === 0 ? st.stdout.split('\n').filter(Boolean) : []
  let ahead = 0
  let behind = 0
  const rev = await git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], { cwd: mirror, token, remote })
  if (rev.code === 0) {
    const m = rev.stdout.trim().split(/\s+/)
    behind = Number(m[0] ?? 0) || 0
    ahead = Number(m[1] ?? 0) || 0
  }
  return { dirty, dirtyCount: dirty.length, ahead, behind }
}

/** 提交全部改动；没有改动返回 { committed: false }。 */
export async function commitAll({ mirror, message }) {
  await git(['add', '-A'], { cwd: mirror })
  const st = await git(['status', '--porcelain'], { cwd: mirror })
  const lines = st.code === 0 ? st.stdout.split('\n').filter(Boolean) : []
  if (!lines.length) return { committed: false }
  const commit = await git(['commit', '-q', '-m', message], { cwd: mirror })
  if (commit.code !== 0) return { committed: false, error: commit.stderr.trim() }
  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: mirror })
  return { committed: true, sha: head.stdout.trim(), files: lines.length }
}

/** 推送。 */
export async function pushMirror({ mirror, branch, remote, token }) {
  const push = await git(['push', 'origin', `HEAD:${branch}`], { cwd: mirror, token, remote })
  if (push.code !== 0) return { ok: false, detail: scrub(`${push.stdout}\n${push.stderr}`, [token]) }
  return { ok: true }
}

/** 把将被覆盖的本地文件备份到 backup/<stamp>/，返回备份目录。 */
export function backupFiles(localPaths, backupRoot, label = 'sync') {
  const dir = path.join(backupRoot, `${stamp()}-${label}`)
  const saved = []
  for (const [rel, abs] of Object.entries(localPaths)) {
    if (!abs || !fs.existsSync(abs)) continue
    const dest = path.join(dir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(abs, dest)
    saved.push(rel)
  }
  return { dir, saved }
}

/** 原子写文件（同目录临时文件 + rename）。 */
export function writeAtomic(absPath, data) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, absPath)
}
