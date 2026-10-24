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
import { dataPaths, readSettings, ensureInstanceId, resolveToken, stamp, detectProfile } from './config.js'
import { mergeSessionBuffers, scanSessions, SESSION_FILE } from './sessions.js'
import { mergePluginManifest, mergeWorkspace, threeWayMergeText, parseJson, canonicalJson } from './datasets.js'
import { backupFiles, mirrorStatus, writeAtomic } from './repo.js'

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

/**
 * 删除（墓碑）支持。
 *
 * 会话是「并集」语义：甲机删掉一个会话，乙机和仓库里还有，下次同步就会被拉回来。
 * 这里把「删除」也变成一条可传播的事实：删掉时记一条墓碑（key → 时间），
 * 墓碑随镜像仓库扩散，另一端据此删掉自己那份。
 *
 * 例外：如果本机文件在删除之后又被写过（mtime 晚于墓碑），以写入为准——复活，
 * 并把墓碑清掉。删一次不该吃掉之后的对话。
 */
const TOMBSTONE_FILE = 'tombstones.json'
const TOMBSTONE_REL = 'sessions/_tombstones.json'

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const asDeleted = (value) => (value && typeof value === 'object' ? value : {})

/** 本机墓碑：{ "<工作区slug>/<会话id>": ISO 时间 }。 */
export function readLocalTombstones(paths = dataPaths()) {
  return asDeleted(readJsonFile(path.join(paths.pluginHome, TOMBSTONE_FILE))?.deleted)
}

/** 镜像仓库里的墓碑（会随同步扩散到其它机器）。 */
export function readRepoTombstones(mirror) {
  return asDeleted(readJsonFile(path.join(mirror, TOMBSTONE_REL))?.deleted)
}

/** 上一次同步结束时本机有哪些会话（用来识别「本机删掉了」）。 */
export function readSyncState(paths = dataPaths()) {
  const j = readJsonFile(paths.state)
  return j && typeof j === 'object' ? j : {}
}

/** 键排序后序列化，用于墓碑文件的语义比较（避免顺序差异造成无意义提交）。 */
function sortedJson(obj) {
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify(sorted)
}

/** 删掉空目录（会话被删后留下的 <ws>/<sid> 空壳），不越过 stopAt。 */
function pruneEmptyDirs(file, stopAt) {
  let dir = path.dirname(file)
  const stop = path.resolve(stopAt)
  while (path.resolve(dir) !== stop && dir.length > stop.length) {
    try {
      if (fs.readdirSync(dir).length) return
      fs.rmdirSync(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

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

import { readIf, exists as pathExists, writeAtomic as writeFileAtomic, readFile, winPath } from './fsx.js'

/** 收集本地状态。 */
export function collectLocal(paths = dataPaths(), settings = readSettings(paths)) {
  const profile = settings.profile || detectProfile(paths.home)
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
  const profile = settings.profile || detectProfile(paths.home)
  const local = collectLocal(paths, settings)
  const repo = collectRepo(mirror, profile)
  const baseDir = path.join(paths.pluginHome, 'base')

  const decisions = []
  const stats = {
    warnings: [],
    sessions: {
      localOnly: 0,
      repoOnly: 0,
      merged: 0,
      identical: 0,
      fastForward: 0,
      bytesIn: 0,
      bytesOut: 0,
      skippedOversize: 0,
      deleted: 0,
      resurrected: 0,
      crossSlug: 0,
    },
    workspace: { mode: 'none', added: 0, updated: 0, pathConflicts: [] },
    plugins: { mode: 'none', added: [], updated: [], versionConflicts: [], localOnly: [] },
    settings: { mode: 'none', conflicts: 0, applied: 0 },
  }

  // 本机从未同步过才叫「首次同步」：state.json 是这一版新增的，老用户没有它，
  // 所以再看一眼 base/ 与镜像 meta.json 作为「同步过」的证据。
  const firstSync =
    !fs.existsSync(paths.state) &&
    !fs.existsSync(path.join(paths.pluginHome, 'base')) &&
    !fs.existsSync(path.join(mirror, 'meta.json'))
  stats.firstSync = firstSync
  if (firstSync) {
    stats.warnings.push('首次同步：两侧内容按并集合并，不会覆盖本地已有内容；写回前会先备份')
  }

  // ── 删除（墓碑）─────────────────────────────────────────────────────────
  const tombstones = {}
  const deletions = new Map() // key → { ts, reason }
  if (settings.include?.sessions !== false) {
    Object.assign(tombstones, readLocalTombstones(paths))
    const repoTombs = readRepoTombstones(mirror)
    for (const [key, ts] of Object.entries(repoTombs)) {
      if (!tombstones[key] || String(ts) > String(tombstones[key])) tombstones[key] = ts
    }

    // 1) 本机删除：上次同步时还有、现在没了，而仓库里还在
    const known = readSyncState(paths).knownSessions ?? {}
    for (const key of Object.keys(known)) {
      if (local.sessions.has(key) || !repo.sessions.has(key) || tombstones[key]) continue
      tombstones[key] = new Date().toISOString()
      deletions.set(key, { ts: tombstones[key], reason: '本机删除' })
      stats.warnings.push(`检测到本机删除了会话 ${key}，将同步删除远端副本`)
    }

    // 2) 远端删除：仓库里的墓碑要求删掉本机这份；本机之后又写过则复活
    for (const [key, ts] of Object.entries(repoTombs)) {
      if (!local.sessions.has(key)) {
        if (repo.sessions.has(key)) deletions.set(key, { ts, reason: '远端删除' })
        continue
      }
      const mtime = new Date(fs.statSync(local.sessions.get(key)).mtimeMs).toISOString()
      if (mtime > String(ts)) {
        delete tombstones[key]
        stats.sessions.resurrected++
        stats.warnings.push(`会话 ${key} 在删除之后本机又有新事件，已保留（复活）`)
        continue
      }
      deletions.set(key, { ts, reason: '远端删除' })
    }
  }

  // ── 会话 ────────────────────────────────────────────────────────────────
  if (settings.include?.sessions !== false) {
    // 删除项先用单独的 remove 决策落地（删本地要先备份，删镜像就是 git rm）
    for (const [key, info] of deletions) {
      decisions.push({
        kind: 'session',
        key,
        action: 'remove',
        rel: path.join('sessions', key, SESSION_FILE).replace(/\\/g, '/'),
        note: info.reason,
        writeRepo: repo.sessions.has(key),
        writeLocal: local.sessions.has(key),
      })
      stats.sessions.deleted++
    }

    // 同一个会话在两侧可能落在不同的工作区目录（工程路径不同 → slug 不同）。
    // 常规流程只看「同名 key」，那样两边永远对不上、内容会各自分叉。
    // 这里按 session id 把两侧内容合并，再分别写回各自的目录。
    const sidOf = (key) => key.slice(key.indexOf('/') + 1)
    const groupBySid = (map) => {
      const out = new Map()
      for (const key of map.keys()) {
        const sid = sidOf(key)
        const list = out.get(sid)
        if (list) list.push(key)
        else out.set(sid, [key])
      }
      return out
    }
    const crossSlugKeys = new Set()
    const maxBytes = (settings.sessions?.maxPerFileMB ?? 64) * 1024 * 1024
    const repoBySid = groupBySid(repo.sessions)
    for (const [sid, lKeys] of groupBySid(local.sessions)) {
      const rKeys = repoBySid.get(sid)
      if (!rKeys?.length) continue
      if (lKeys.some((k) => repo.sessions.has(k))) continue // 同名 key，走常规流程
      if (lKeys.some((k) => deletions.has(k)) || rKeys.some((k) => deletions.has(k))) continue
      const lKey = lKeys[0]
      const rKey = rKeys[0]
      const lFile = local.sessions.get(lKey)
      const rFile = repo.sessions.get(rKey)
      if (fs.statSync(lFile).size > maxBytes || fs.statSync(rFile).size > maxBytes) {
        stats.sessions.skippedOversize++
        stats.warnings.push(`会话 ${sid} 跨目录合并超过 ${Math.round(maxBytes / 1048576)}MB，已跳过`)
        continue
      }
      const merged = mergeSessionBuffers(fs.readFileSync(lFile), fs.readFileSync(rFile), {
        strategy: settings.sessions?.strategy || 'union',
      })
      if (merged.mode === 'identical' || merged.mode === 'keep-local') continue
      if (merged.mode === 'unmergeable') {
        stats.warnings.push(`会话 ${sid} 跨目录合并时有帧解不开，已跳过（两侧均未改动）`)
        continue
      }
      decisions.push({
        kind: 'session',
        key: lKey,
        action: 'merge',
        rel: path.join('sessions', lKey, SESSION_FILE).replace(/\\/g, '/'),
        buffer: merged.buffer,
        note: `跨目录 ${merged.mode}`,
        writeRepo: false,
        writeLocal: true,
      })
      decisions.push({
        kind: 'session',
        key: rKey,
        action: 'merge',
        rel: path.join('sessions', rKey, SESSION_FILE).replace(/\\/g, '/'),
        buffer: merged.buffer,
        note: `跨目录 ${merged.mode}`,
        writeRepo: true,
        writeLocal: false,
      })
      crossSlugKeys.add(lKey)
      crossSlugKeys.add(rKey)
      stats.sessions.crossSlug++
      stats.sessions.merged++
      stats.sessions.bytesOut += merged.buffer.length
      stats.warnings.push(
        `会话 ${sid} 在两端工作区目录不同（${lKey.split('/')[0]} ≠ ${rKey.split('/')[0]}），已按会话合并内容；建议两台机器用相同的工程路径`,
      )
    }

    const keys = new Set([...local.sessions.keys(), ...repo.sessions.keys()])
    for (const key of keys) {
      if (deletions.has(key) || crossSlugKeys.has(key)) continue
      const lPath = local.sessions.get(key)
      const rPath = repo.sessions.get(key)
      const rel = path.join('sessions', key, SESSION_FILE).replace(/\\/g, '/')
      if (lPath && !rPath) {
        const buf = fs.readFileSync(lPath)
        decisions.push({ kind: 'session', key, action: 'push', rel, buffer: buf, writeRepo: true, writeLocal: false })
        stats.sessions.localOnly++
        stats.sessions.bytesOut += buf.length
        continue
      }
      if (!lPath && rPath) {
        const buf = fs.readFileSync(rPath)
        decisions.push({ kind: 'session', key, action: 'pull', rel, buffer: buf, writeRepo: false, writeLocal: true })
        stats.sessions.repoOnly++
        stats.sessions.bytesIn += buf.length
        continue
      }
      // 超大会话不做内存里解帧合并：直接保留本地，另一侧原样不动（下轮人工处理）
      const limitBytes = (settings.sessions?.maxPerFileMB ?? 64) * 1024 * 1024
      if (fs.statSync(lPath).size > limitBytes || fs.statSync(rPath).size > limitBytes) {
        stats.sessions.skippedOversize++
        stats.warnings.push(`会话 ${key} 超过 ${Math.round(limitBytes / 1048576)}MB，已跳过合并`)
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
        decisions.push({ kind: 'session', key, action: 'push', rel, buffer: merged.buffer, writeRepo: true, writeLocal: false })
        stats.sessions.localOnly++
        stats.sessions.bytesOut += merged.buffer.length
        continue
      }
      if (merged.mode === 'remote-ahead') {
        decisions.push({ kind: 'session', key, action: 'pull', rel, buffer: merged.buffer, writeRepo: false, writeLocal: true })
        stats.sessions.fastForward++
        stats.sessions.bytesIn += merged.buffer.length
        continue
      }
      if (merged.mode === 'unmergeable') {
        // 不解帧就不知道远端有没有本地缺的事件：两边都不动，只报出来
        decisions.push({ kind: 'session', key, action: 'keep-local', rel, buffer: null, note: '有帧解不开，两侧均未改动', writeRepo: false, writeLocal: false })
        stats.sessions.localOnly++
        stats.warnings.push(`会话 ${key} 有帧解不开，已跳过（两侧均未改动）`)
        continue
      }
      decisions.push({ kind: 'session', key, action: 'merge', rel, buffer: merged.buffer, note: merged.mode, added: merged.added, writeRepo: true, writeLocal: true })
      stats.sessions.merged++
      stats.sessions.bytesOut += merged.buffer.length
    }

    // 墓碑本身也要推给远端，否则另一台不知道「这个会话是被删掉的」
    if (sortedJson(tombstones) !== sortedJson(readRepoTombstones(mirror))) {
      decisions.push({
        kind: 'tombstones',
        action: 'merge',
        rel: TOMBSTONE_REL,
        text: `${JSON.stringify({ version: 1, deleted: tombstones }, null, 2)}\n`,
      })
    }
  }

  // ── 工作区注册表 ────────────────────────────────────────────────────────
  if (settings.include?.workspace !== false) {
    if (local.workspace && repo.workspace) {
      const lj = parseJson(local.workspace)
      const rj = parseJson(repo.workspace)
      if (!lj || !rj) {
        stats.warnings.push('workspace.json 有一侧不是合法 JSON，已跳过（未覆盖任何一侧）')
        stats.workspace = { mode: 'skipped-invalid' }
      } else {
      const { merged, stats: ws } = mergeWorkspace(lj, rj)
      const text = `${JSON.stringify(merged, null, 2)}\n`
      // 合并进来的工作区可能指向另一台机器上的路径（本机根本没有）——只报告，不改
      ws.missingPaths = Object.values(merged.tables?.workspaces ?? {})
        .filter((item) => typeof item?.path === 'string' && item.path !== '' && !fs.existsSync(item.path))
        .map((item) => item.path)
      // 语义比较：格式化差异（缩进/键序）不算变化，避免每次同步都重写
      const needRepo = canonicalJson(merged) !== canonicalJson(rj)
      const needLocal = canonicalJson(merged) !== canonicalJson(lj)
      if (needRepo || needLocal) {
        decisions.push({ kind: 'workspace', action: 'merge', rel: 'workspace/workspace.json', text, writeRepo: needRepo, writeLocal: needLocal })
      }
      stats.workspace = { mode: needRepo || needLocal ? 'merge' : 'none', ...ws }
      }
    } else if (local.workspace && !repo.workspace) {
      decisions.push({ kind: 'workspace', action: 'push', rel: 'workspace/workspace.json', text: local.workspace, writeRepo: true, writeLocal: false })
      stats.workspace = { mode: 'push' }
    } else if (!local.workspace && repo.workspace) {
      decisions.push({ kind: 'workspace', action: 'pull', rel: 'workspace/workspace.json', text: repo.workspace, writeRepo: false, writeLocal: true })
      stats.workspace = { mode: 'pull' }
    }
    // GitHub 工作区映射：同样的键合并思路（对象键合并即可，简单取较新者）
    if (local.githubWorkspaces && repo.githubWorkspaces) {
      const l = parseJson(local.githubWorkspaces)
      const r = parseJson(repo.githubWorkspaces)
      if (!l || !r) {
        stats.warnings.push('dsh-github-workspaces.json 有一侧不是合法 JSON，已跳过')
      } else {
      const repos = { ...(r.repos ?? {}), ...(l.repos ?? {}) }
      const text = `${JSON.stringify({ ...r, ...l, repos }, null, 2)}\n`
      if (text !== local.githubWorkspaces) {
        decisions.push({ kind: 'githubWorkspaces', action: 'merge', rel: 'workspace/github-workspaces.json', text })
      }
      }
    } else if (local.githubWorkspaces && !repo.githubWorkspaces) {
      decisions.push({ kind: 'githubWorkspaces', action: 'push', rel: 'workspace/github-workspaces.json', text: local.githubWorkspaces })
    }
  }

  // ── 插件清单 ────────────────────────────────────────────────────────────
  if (settings.include?.plugins !== false) {
    if (local.packageJson && repo.packageJson) {
      const lj = parseJson(local.packageJson)
      const rj = parseJson(repo.packageJson)
      if (!lj || !rj) {
        stats.warnings.push('package.json 有一侧不是合法 JSON，已跳过（未覆盖任何一侧）')
        stats.plugins = { mode: 'skipped-invalid' }
      } else {
      const { merged, stats: ps } = mergePluginManifest(lj, rj)
      const text = `${JSON.stringify(merged, null, 2)}\n`
      const needRepo = canonicalJson(merged) !== canonicalJson(rj)
      const needLocal = canonicalJson(merged) !== canonicalJson(lj)
      if (needRepo || needLocal) {
        decisions.push({ kind: 'plugins', action: 'merge', rel: `plugins/${profile}/package.json`, text, writeRepo: needRepo, writeLocal: needLocal })
      }
      stats.plugins = { mode: needRepo || needLocal ? 'merge' : 'none', ...ps }
      }
    } else if (local.packageJson) {
      decisions.push({ kind: 'plugins', action: 'push', rel: `plugins/${profile}/package.json`, text: local.packageJson, writeRepo: true, writeLocal: false })
      stats.plugins = { mode: 'push' }
    } else if (repo.packageJson) {
      decisions.push({ kind: 'plugins', action: 'pull', rel: `plugins/${profile}/package.json`, text: repo.packageJson, writeRepo: false, writeLocal: true })
      stats.plugins = { mode: 'pull' }
    }
    // lockfile：不做文本合并，跟随本地（与本地 package.json 配套）；本地没有才取远端
    if (local.lock && repo.lock) {
      if (local.lock !== repo.lock) {
        decisions.push({ kind: 'lock', action: 'push', rel: `plugins/${profile}/pnpm-lock.yaml`, text: local.lock, writeRepo: true, writeLocal: false })
      }
    } else if (local.lock && !repo.lock) {
      decisions.push({ kind: 'lock', action: 'push', rel: `plugins/${profile}/pnpm-lock.yaml`, text: local.lock, writeRepo: true, writeLocal: false })
    } else if (!local.lock && repo.lock) {
      decisions.push({ kind: 'lock', action: 'pull', rel: `plugins/${profile}/pnpm-lock.yaml`, text: repo.lock, writeRepo: false, writeLocal: true })
    }
  }

  // ── 设置层（cordis.patch.yml）：三路合并 ───────────────────────────────
  if (settings.include?.settings !== false && local.patch) {
    if (!repo.patch) {
      decisions.push({ kind: 'settings', action: 'push', rel: `plugins/${profile}/cordis.patch.yml`, text: local.patch, writeRepo: true, writeLocal: false })
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
        // 合并结果若与某一侧相同，就不用再写那一侧（少一次无意义覆盖 + 备份）
        writeRepo: text !== repo.patch,
        writeLocal: text !== local.patch,
      })
      stats.settings = { mode: 'merge', conflicts, applied }
    }
  }

  const plan = { decisions, stats, profile, local, repo, tombstones, generatedAt: new Date().toISOString() }
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

  // 删除同样要先备份：删掉的会话也必须能回滚
  for (const d of plan.decisions) {
    if (d.action !== 'remove' || !d.writeLocal) continue
    const localPath = localPathOf(d, plan.profile, paths)
    if (localPath && fs.existsSync(winPath(localPath))) toBackup[d.rel] = localPath
  }

  for (const d of plan.decisions) {
    const payload = d.buffer ?? d.text
    if (!d.rel || payload === null || payload === undefined) continue // keep-local / 跳过项
    if (d.action === 'keep-local') continue // 明确不动远端

    // ⚠️ 顺序很重要：**先**登记备份，再写镜像。
    // 之前写成「先写镜像，写成功后才登记备份」，于是 pull（writeRepo=false）提前 continue，
    // 备份被静默跳过 —— 拉取会直接覆盖本地且无法回滚（2026-10-23 自查发现）。
    if (d.writeLocal !== false && (d.action === 'pull' || d.action === 'merge')) {
      const localPath = localPathOf(d, plan.profile, paths)
      if (localPath) toBackup[d.rel] = localPath
    }

    if (d.writeRepo === false) continue
    const repoPath = path.join(mirror, d.rel)
    assertNotBlocked(d.rel)
    writeAtomic(repoPath, payload)
    written.repo++
  }

  // 备份 + 写本地
  let backup = { dir: '', saved: [] }
  if (Object.keys(toBackup).length) {
    backup = backupFiles(toBackup, paths.backup, 'pre-apply')
  }
  for (const d of plan.decisions) {
    if (d.writeLocal === false) continue
    if (d.action !== 'pull' && d.action !== 'merge') continue
    const localPath = localPathOf(d, plan.profile, paths)
    if (!localPath) continue
    const payload = d.buffer ?? d.text
    writeAtomic(localPath, payload)
    written.local++
  }

  // 执行删除（本地 + 镜像），顺手清掉删空的 <slug>/<sid> 目录
  for (const d of plan.decisions) {
    if (d.action !== 'remove') continue
    const localPath = d.writeLocal ? localPathOf(d, plan.profile, paths) : null
    if (localPath && fs.existsSync(winPath(localPath))) {
      fs.rmSync(winPath(localPath), { force: true })
      pruneEmptyDirs(localPath, paths.sessions)
      written.local++
    }
    if (d.writeRepo) {
      const repoPath = path.join(mirror, d.rel)
      if (fs.existsSync(winPath(repoPath))) {
        fs.rmSync(winPath(repoPath), { force: true })
        pruneEmptyDirs(repoPath, path.join(mirror, 'sessions'))
        written.repo++
      }
    }
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

  // 墓碑 + 本机会话快照：下次同步据此识别「本机删掉了哪些会话」
  if (plan.tombstones) {
    writeAtomic(
      path.join(paths.pluginHome, TOMBSTONE_FILE),
      `${JSON.stringify({ version: 1, deleted: plan.tombstones }, null, 2)}\n`,
    )
  }
  try {
    const known = {}
    for (const key of scanSessions(paths.sessions).keys()) known[key] = true
    writeAtomic(paths.state, `${JSON.stringify({ version: 1, knownSessions: known }, null, 2)}\n`)
  } catch {
    /* 状态文件写不了不影响同步本身 */
  }

  // meta.json：实例与时间（便于排查「这份仓库是谁写的」）
  // 没有计划项时不写，免得每次空同步都产生一个提交
  if (!plan.decisions.length) return { written, backup }
  const metaPath = path.join(mirror, L.meta)
  const meta = {
    schemaVersion: 1,
    instanceId: ensureInstanceId(paths),
    profile: plan.profile,
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

/** 永不同步的目录/文件名（与 settings.neverSync 对应，代码里再守一道）。 */
const BLOCKED_SEGMENTS = new Set([
  '.credentials.yaml',
  'credentials.yaml',
  'node_modules',
  'cache',
  'runtimes',
  'attachments',
  '.trash',
])

/**
 * 镜像写入前的黑名单守卫：按**路径段**判定（不按子串），命中即抛。
 * 不按子串是有意的：`--D-code-cache--` 这类合法会话目录不应被误杀。
 */
export function assertNotBlocked(rel) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '')
  for (const seg of norm.split('/')) {
    if (BLOCKED_SEGMENTS.has(seg)) {
      throw new Error(`拒绝写入被排除的路径：${rel}`)
    }
  }
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
  const profile = settings.profile || detectProfile(paths.home)
  // 面板没填 token 时复用 DSH 已登录的凭据，徽标据此显示「已配置」而不是误报未配置
  const auth = resolveToken(settings, paths.home)
  const local = collectLocal(paths, settings)
  const repo = collectRepo(paths.mirror, profile)
  const st = fs.existsSync(path.join(paths.mirror, '.git'))
    ? await mirrorStatus({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote })
    : { dirtyCount: 0, ahead: 0, behind: 0, dirty: [] }
  const meta = readMeta(paths.mirror)
  return {
    profile,
    // 远端最后写入时用的 profile：两边不同（一台 desktop、一台 web）时插件的清单各存一份，
    // 面板要提示，否则会误以为「插件同步没生效」
    remoteProfile: meta?.profile ?? '',
    remote: settings.remote,
    branch: settings.branch,
    tokenConfigured: Boolean(auth.token),
    tokenSource: auth.source,
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
    lastSyncAt: meta?.updatedAt ?? null,
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
