/**
 * 编排层：把「本地状态」与「镜像仓库状态」对比成一份计划，再执行。
 *
 * 三类数据的走向各自独立：
 *   会话   ── 帧级并集（一方是另一方前缀时直接采信较长那份）
 *   工作区 ── JSON 键合并
 *   插件   ── 依赖集合合并 + 版本仲裁；设置层三路行合并
 *
 * 每次执行前都会把将被覆盖的本地文件备份到 backup/<时间戳>/，可回滚。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataPaths, readSettings, ensureInstanceId, stamp } from './config.js'
import { mergeSessionBuffers, scanSessions, SESSION_FILE } from './sessions.js'
import { mergePluginManifest, mergeWorkspace, threeWayMergeText } from './datasets.js'
import { backupFiles, mirrorStatus, writeAtomic } from './repo.js'

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

/** 镜像仓库里的相对路径约定（单一事实来源）。 */
export function repoLayout(profile) {
  return {
    meta: 'meta.json',
    workspace: 'workspace/workspace.json',
    githubWorkspaces: 'workspace/github-workspaces.json',
    packageJson: `plugins/${profile}/package.json`,
    patch: `plugins/${profile}/cordis.patch.yml`,
    lock: `plugins/${profile}/pnpm-lock.yaml`,
    sessionsDir: 'sessions',
    baseDir: 'base',
  }
}

const readIf = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

/** 收集本地状态。 */
export function collectLocal(paths = dataPaths(), settings = readSettings(paths)) {
  const profile = settings.profile || 'desktop'
  const prof = paths.profile(profile)
  const files = {
    workspace: paths.workspace,
    githubWorkspaces: paths.githubWorkspaces,
    packageJson: prof.packageJson,
    patch: prof.patch,
    lock: prof.lock,
  }
  return {
    profile,
    sessions: scanSessions(paths.sessions),
    workspace: readIf(files.workspace),
    githubWorkspaces: readIf(files.githubWorkspaces),
    packageJson: readIf(files.packageJson),
    patch: readIf(files.patch),
    lock: readIf(files.lock),
    files,
  }
}

/** 收集镜像仓库状态。 */
export function collectRepo(mirror, profile) {
  const L = repoLayout(profile)
  const sessions = new Map()
  const root = path.join(mirror, L.sessionsDir)
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    /* 空仓库 */
  }
  for (const ws of workspaces) {
    let dirs = []
    try {
      dirs = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const d of dirs) {
      const file = path.join(root, ws.name, d.name, SESSION_FILE)
      if (fs.existsSync(file)) sessions.set(`${ws.name}/${d.name}`, file)
    }
  }
  return {
    profile,
    sessions,
    workspace: readIf(path.join(mirror, L.workspace)),
    githubWorkspaces: readIf(path.join(mirror, L.githubWorkspaces)),
    packageJson: readIf(path.join(mirror, L.packageJson)),
    patch: readIf(path.join(mirror, L.patch)),
    lock: readIf(path.join(mirror, L.lock)),
    files: {
      workspace: path.join(mirror, L.workspace),
      githubWorkspaces: path.join(mirror, L.githubWorkspaces),
      packageJson: path.join(mirror, L.packageJson),
      patch: path.join(mirror, L.patch),
      lock: path.join(mirror, L.lock),
    },
  }
}

/**
 * 生成同步计划（只读，不写盘）。
 * @returns {object} plan
 */
export function planSync({ paths = dataPaths(), settings = readSettings(paths), mirror } = {}) {
  const profile = settings.profile || 'desktop'
  const local = collectLocal(paths, settings)
  const repo = collectRepo(mirror, profile)
  const baseDir = path.join(paths.pluginHome, 'base')

  const decisions = []
  const stats = {
    sessions: { localOnly: 0, repoOnly: 0, merged: 0, identical: 0, fastForward: 0, bytesIn: 0, bytesOut: 0 },
    workspace: { mode: 'none', added: 0, updated: 0, pathConflicts: [] },
    plugins: { mode: 'none', added: [], updated: [], versionConflicts: [], localOnly: [] },
    settings: { mode: 'none', conflicts: 0, applied: 0 },
  }

  // ── 会话 ────────────────────────────────────────────────────────────────
  if (settings.include?.sessions !== false) {
    const keys = new Set([...local.sessions.keys(), ...repo.sessions.keys()])
    for (const key of keys) {
      const lPath = local.sessions.get(key)
      const rPath = repo.sessions.get(key)
      const rel = path.join('sessions', key, SESSION_FILE).replace(/\\/g, '/')
      if (lPath && !rPath) {
        const buf = fs.readFileSync(lPath)
        decisions.push({ kind: 'session', key, action: 'push', rel, buffer: buf })
        stats.sessions.localOnly++
        stats.sessions.bytesOut += buf.length
        continue
      }
      if (!lPath && rPath) {
        const buf = fs.readFileSync(rPath)
        decisions.push({ kind: 'session', key, action: 'pull', rel, buffer: buf })
        stats.sessions.repoOnly++
        stats.sessions.bytesIn += buf.length
        continue
      }
      const lBuf = fs.readFileSync(lPath)
      const rBuf = fs.readFileSync(rPath)
      if (sha1(lBuf) === sha1(rBuf)) {
        stats.sessions.identical++
        continue
      }
      const merged = mergeSessionBuffers(lBuf, rBuf, { strategy: settings.sessions?.strategy || 'union' })
      if (merged.mode === 'identical') {
        stats.sessions.identical++
        continue
      }
      // 本地是远端的前缀 = 本地更新（本机有新事件）→ 需要推送，不能当成「一致」
      if (merged.mode === 'local-ahead') {
        decisions.push({ kind: 'session', key, action: 'push', rel, buffer: merged.buffer })
        stats.sessions.localOnly++
        stats.sessions.bytesOut += merged.buffer.length
        continue
      }
      if (merged.mode === 'remote-ahead') {
        decisions.push({ kind: 'session', key, action: 'pull', rel, buffer: merged.buffer })
        stats.sessions.fastForward++
        stats.sessions.bytesIn += merged.buffer.length
        continue
      }
      if (merged.mode === 'unmergeable') {
        decisions.push({ kind: 'session', key, action: 'keep-local', rel, buffer: lBuf, note: '有帧解不开，保留本地' })
        stats.sessions.localOnly++
        continue
      }
      decisions.push({ kind: 'session', key, action: 'merge', rel, buffer: merged.buffer, note: merged.mode, added: merged.added })
      stats.sessions.merged++
      stats.sessions.bytesOut += merged.buffer.length
    }
  }

  // ── 工作区注册表 ────────────────────────────────────────────────────────
  if (settings.include?.workspace !== false) {
    if (local.workspace && repo.workspace) {
      const lj = JSON.parse(local.workspace)
      const rj = JSON.parse(repo.workspace)
      const { merged, stats: ws } = mergeWorkspace(lj, rj)
      const text = `${JSON.stringify(merged, null, 2)}\n`
      const changed = text !== local.workspace || text !== repo.workspace
      if (changed) {
        decisions.push({ kind: 'workspace', action: 'merge', rel: 'workspace/workspace.json', text })
      }
      stats.workspace = { mode: changed ? 'merge' : 'none', ...ws }
    } else if (local.workspace && !repo.workspace) {
      decisions.push({ kind: 'workspace', action: 'push', rel: 'workspace/workspace.json', text: local.workspace })
      stats.workspace = { mode: 'push' }
    } else if (!local.workspace && repo.workspace) {
      decisions.push({ kind: 'workspace', action: 'pull', rel: 'workspace/workspace.json', text: repo.workspace })
      stats.workspace = { mode: 'pull' }
    }
    // GitHub 工作区映射：同样的键合并思路（对象键合并即可，简单取较新者）
    if (local.githubWorkspaces && repo.githubWorkspaces) {
      const l = JSON.parse(local.githubWorkspaces)
      const r = JSON.parse(repo.githubWorkspaces)
      const repos = { ...(r.repos ?? {}), ...(l.repos ?? {}) }
      const text = `${JSON.stringify({ ...r, ...l, repos }, null, 2)}\n`
      if (text !== local.githubWorkspaces) {
        decisions.push({ kind: 'githubWorkspaces', action: 'merge', rel: 'workspace/github-workspaces.json', text })
      }
    } else if (local.githubWorkspaces && !repo.githubWorkspaces) {
      decisions.push({ kind: 'githubWorkspaces', action: 'push', rel: 'workspace/github-workspaces.json', text: local.githubWorkspaces })
    }
  }

  // ── 插件清单 ────────────────────────────────────────────────────────────
  if (settings.include?.plugins !== false) {
    if (local.packageJson && repo.packageJson) {
      const { merged, stats: ps } = mergePluginManifest(JSON.parse(local.packageJson), JSON.parse(repo.packageJson))
      const text = `${JSON.stringify(merged, null, 2)}\n`
      if (text !== local.packageJson || text !== repo.packageJson) {
        decisions.push({ kind: 'plugins', action: 'merge', rel: `plugins/${profile}/package.json`, text })
      }
      stats.plugins = { mode: 'merge', ...ps }
    } else if (local.packageJson) {
      decisions.push({ kind: 'plugins', action: 'push', rel: `plugins/${profile}/package.json`, text: local.packageJson })
      stats.plugins = { mode: 'push' }
    } else if (repo.packageJson) {
      decisions.push({ kind: 'plugins', action: 'pull', rel: `plugins/${profile}/package.json`, text: repo.packageJson })
      stats.plugins = { mode: 'pull' }
    }
    // lockfile：不做文本合并，跟随本地（与本地 package.json 配套）；本地没有才取远端
    if (local.lock && repo.lock) {
      if (local.lock !== repo.lock) {
        decisions.push({ kind: 'lock', action: 'push', rel: `plugins/${profile}/pnpm-lock.yaml`, text: local.lock })
      }
    } else if (local.lock && !repo.lock) {
      decisions.push({ kind: 'lock', action: 'push', rel: `plugins/${profile}/pnpm-lock.yaml`, text: local.lock })
    } else if (!local.lock && repo.lock) {
      decisions.push({ kind: 'lock', action: 'pull', rel: `plugins/${profile}/pnpm-lock.yaml`, text: repo.lock })
    }
  }

  // ── 设置层（cordis.patch.yml）：三路合并 ───────────────────────────────
  if (settings.include?.settings !== false && local.patch) {
    if (!repo.patch) {
      decisions.push({ kind: 'settings', action: 'push', rel: `plugins/${profile}/cordis.patch.yml`, text: local.patch })
      stats.settings = { mode: 'push', conflicts: 0, applied: 0 }
    } else if (local.patch !== repo.patch) {
      const basePath = path.join(baseDir, `plugins/${profile}/cordis.patch.yml`)
      const base = readIf(basePath)
      const { text, conflicts, applied } = threeWayMergeText(base, local.patch, repo.patch)
      decisions.push({
        kind: 'settings',
        action: 'merge',
        rel: `plugins/${profile}/cordis.patch.yml`,
        text,
        conflicts,
        remoteText: repo.patch,
      })
      stats.settings = { mode: 'merge', conflicts, applied }
    }
  }

  const plan = { decisions, stats, profile, local, repo, generatedAt: new Date().toISOString() }
  // stats 同时挂在顶层：调用方习惯 const { plan, stats } = planSync(...)
  return { plan, stats, paths, settings }
}

/**
 * 执行计划：写镜像与本地（本地先备份）。
 * @param {{decisions: object[], stats: object, profile: string}} plan
 */
export function applyPlan(plan, { paths = dataPaths(), mirror } = {}) {
  const L = repoLayout(plan.profile)
  const toBackup = {}
  const written = { repo: 0, local: 0 }

  for (const d of plan.decisions) {
    if (!d.rel || (d.buffer === undefined && d.text === undefined)) continue
    const payload = d.buffer ?? d.text
    const repoPath = path.join(mirror, d.rel)
    writeAtomic(repoPath, payload)
    written.repo++

    // 需要写回本地的情形：pull / merge
    if (d.action === 'pull' || d.action === 'merge') {
      const localPath = localPathOf(d, plan.profile, paths)
      if (localPath) {
        toBackup[d.rel] = localPath
      }
    }
  }

  // 备份 + 写本地
  let backup = { dir: '', saved: [] }
  if (Object.keys(toBackup).length) {
    backup = backupFiles(toBackup, paths.backup, 'pre-apply')
  }
  for (const d of plan.decisions) {
    if (d.action !== 'pull' && d.action !== 'merge') continue
    const localPath = localPathOf(d, plan.profile, paths)
    if (!localPath) continue
    const payload = d.buffer ?? d.text
    writeAtomic(localPath, payload)
    written.local++
  }

  // 冲突的远端版本另存一份，便于人工比对（不覆盖本地）
  for (const d of plan.decisions) {
    if (d.conflicts > 0 && d.remoteText) {
      const localPath = localPathOf(d, plan.profile, paths)
      if (localPath) writeAtomic(`${localPath}.remote-${stamp()}`, d.remoteText)
    }
  }

  // 更新三路合并基线（用刚写进镜像的版本）
  for (const d of plan.decisions) {
    if (d.kind !== 'settings') continue
    const basePath = path.join(paths.pluginHome, 'base', d.rel)
    writeAtomic(basePath, d.text)
  }

  // meta.json：实例与时间（便于排查「这份仓库是谁写的」）
  const metaPath = path.join(mirror, L.meta)
  const meta = {
    schemaVersion: 1,
    instanceId: ensureInstanceId(paths),
    updatedAt: new Date().toISOString(),
    lastPlan: {
      sessions: plan.stats.sessions,
      workspace: plan.stats.workspace.mode,
      plugins: plan.stats.plugins.mode,
      settings: plan.stats.settings.mode,
    },
  }
  writeAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`)

  return { written, backup }
}

/** 计划项 → 本地绝对路径。 */
export function localPathOf(d, profile, paths = dataPaths()) {
  const prof = paths.profile(profile)
  switch (d.kind) {
    case 'session': {
      const [ws, sid] = String(d.key).split('/')
      return path.join(paths.sessions, ws, sid, SESSION_FILE)
    }
    case 'workspace':
      return paths.workspace
    case 'githubWorkspaces':
      return paths.githubWorkspaces
    case 'plugins':
      return prof.packageJson
    case 'lock':
      return prof.lock
    case 'settings':
      return prof.patch
    default:
      return null
  }
}

/** 概览：不跑 git，只读本地 + 镜像的文件统计（面板首屏用）。 */
export async function overview({ paths = dataPaths(), settings = readSettings(paths) } = {}) {
  const profile = settings.profile || 'desktop'
  const local = collectLocal(paths, settings)
  const repo = collectRepo(paths.mirror, profile)
  const st = fs.existsSync(path.join(paths.mirror, '.git'))
    ? await mirrorStatus({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
    : { dirtyCount: 0, ahead: 0, behind: 0, dirty: [] }
  return {
    profile,
    remote: settings.remote,
    branch: settings.branch,
    tokenConfigured: Boolean(settings.token),
    instanceId: settings.instanceId || '',
    local: {
      sessions: local.sessions.size,
      workspace: Boolean(local.workspace),
      plugins: local.packageJson ? countDeps(local.packageJson) : 0,
      patch: Boolean(local.patch),
    },
    repo: {
      sessions: repo.sessions.size,
      workspace: Boolean(repo.workspace),
      plugins: repo.packageJson ? countDeps(repo.packageJson) : 0,
      patch: Boolean(repo.patch),
    },
    git: st,
    lastSyncAt: readMeta(paths.mirror)?.updatedAt ?? null,
  }
}

function countDeps(text) {
  try {
    const j = JSON.parse(text)
    return Object.keys(j.dependencies ?? {}).length
  } catch {
    return 0
  }
}

function readMeta(mirror) {
  try {
    return JSON.parse(fs.readFileSync(path.join(mirror, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}
