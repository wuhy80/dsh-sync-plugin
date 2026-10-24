/**
 * 路径与设置。
 *
 * 设置落在 $DSH_HOME/dsh-sync.json（0600）：浏览器半边的面板会改它，
 * 走的是本插件的 HTTP 路由，因此不依赖 schemastery / cordis 配置。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** DSH 主目录（与 @deepseek-ai/dsh-home-paths 同口径：环境变量优先）。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 本插件自己的数据目录（镜像仓库、备份、同步状态）。 */
export function pluginHome() {
  return path.join(dshHome(), 'dsh-sync')
}

/** 所有被同步对象的路径集合：单一事实来源，便于测试注入。 */
export function dataPaths(home = dshHome()) {
  return {
    home,
    sessions: path.join(home, 'sessions'),
    workspace: path.join(home, 'storages', 'workspace.json'),
    githubWorkspaces: path.join(home, 'dsh-github-workspaces.json'),
    settings: path.join(home, 'dsh-sync.json'),
    pluginHome: path.join(home, 'dsh-sync'),
    mirror: path.join(home, 'dsh-sync', 'repo'),
    backup: path.join(home, 'dsh-sync', 'backup'),
    state: path.join(home, 'dsh-sync', 'state.json'),
    profile: (name) => ({
      root: path.join(home, 'profiles', name),
      packageJson: path.join(home, 'profiles', name, 'package.json'),
      patch: path.join(home, 'profiles', name, 'cordis.patch.yml'),
      lock: path.join(home, 'profiles', name, 'pnpm-lock.yaml'),
      workspaceYaml: path.join(home, 'profiles', name, 'pnpm-workspace.yaml'),
    }),
  }
}

const DEFAULT_SETTINGS = () => ({
  instanceId: '',
  remote: '',
  branch: 'main',
  token: '',
  author: { name: '', email: '' },
  /** 空 = 自动检测「本插件当前跑在哪个 profile 里」（desktop / web / tui … 都成立）。 */
  profile: '',
  /** 四类数据的开关：默认全开（会话同步是用户明确要的）。 */
  include: { sessions: true, workspace: true, plugins: true, settings: true },
  /** 会话合并策略：union = 行级并集（推荐）；fork = 保留冲突副本（保守）。 */
  sessions: { strategy: 'union', maxPerFileMB: 64 },
  /** 永不入库的东西（写死在代码里更安全，这里只是显式声明便于审计）。 */
  neverSync: ['.credentials.yaml', 'credentials.yaml', 'node_modules', 'cache', 'runtimes', 'attachments'],
})

/** profile 名字是否合理地存在于 $DSH_HOME/profiles 下（防注入乱七八糟的值）。 */
function profileExists(home, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return false
  try {
    return fs.statSync(path.join(home, 'profiles', name)).isDirectory()
  } catch {
    return false
  }
}

/** 某个 profile 的 package.json 是否把本插件列进了依赖。 */
function profileDependsOnUs(home, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'profiles', name, 'package.json'), 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    return Object.keys(deps).some((key) => /(^|\/)dsh-sync$/.test(key))
  } catch {
    return false
  }
}

/** 某个 profile 的 patch 是否登记了本插件（bundles / cordis.patch.yml）。 */
function profileRegistersUs(home, name) {
  for (const file of ['cordis.patch.yml', 'cordis.yml']) {
    try {
      const text = fs.readFileSync(path.join(home, 'profiles', name, file), 'utf8')
      if (text.includes('dsh-sync')) return true
    } catch {
      /* 该 profile 没有这个文件 */
    }
  }
  return false
}

/**
 * 推断「本插件当前跑在哪个 profile 里」。
 *
 * desktop 由 Electron 托管、`dsh plugin --profile desktop` 会被 CLI 拒绝，所以不能
 * 把 desktop 写死成默认值——web / tui / headless 上同样要能用。
 *
 * 依次尝试：环境变量 → 本模块所在的 profiles/<name>/node_modules 路径 →
 * 依赖里登记了本插件的 profile（仅一个时）→ 登记了本插件的 profile（仅一个时）→ desktop。
 */
export function detectProfile(home = dshHome()) {
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME']) {
    const value = String(process.env[key] ?? '').trim()
    if (value !== '' && profileExists(home, value)) return value
  }
  // launcher 也会给 profile 目录：从它取 basename 最稳（web / tui / desktop 一致对待）
  const dir = String(process.env.DSH_PROFILE_DIR ?? '').trim()
  if (dir !== '') {
    const name = path.basename(dir)
    if (profileExists(home, name)) return name
  }

  try {
    const here = fileURLToPath(import.meta.url).replace(/\\/g, '/')
    const hit = /\/profiles\/([^/]+)\/node_modules\//.exec(here)
    if (hit !== null && profileExists(home, hit[1])) return hit[1]
  } catch {
    /* import.meta 不可用时跳过 */
  }

  let names = []
  try {
    names = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && profileExists(home, entry.name))
      .map((entry) => entry.name)
  } catch {
    return 'desktop'
  }

  const dependents = names.filter((name) => profileDependsOnUs(home, name))
  if (dependents.length === 1) return dependents[0]
  const registered = names.filter((name) => profileRegistersUs(home, name))
  if (registered.length === 1) return registered[0]
  // 多个候选（装了不止一个 profile）时保持历史默认，由用户在面板里改
  return names.includes('desktop') ? 'desktop' : names[0] ?? 'desktop'
}

/** 读设置：缺字段用默认值补齐；文件不存在返回默认值。profile 为空时自动检测。 */
export function readSettings(paths = dataPaths()) {
  const base = DEFAULT_SETTINGS()
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(paths.settings, 'utf8'))
  } catch {
    return { ...base, profile: detectProfile(paths.home) }
  }
  const merged = {
    ...base,
    ...raw,
    author: { ...base.author, ...(raw.author || {}) },
    include: { ...base.include, ...(raw.include || {}) },
    sessions: { ...base.sessions, ...(raw.sessions || {}) },
  }
  if (!merged.profile || merged.profile === 'auto') merged.profile = detectProfile(paths.home)
  return merged
}

/** 原子写设置（先写临时文件再改名），权限 0600。 */
export function writeSettings(next, paths = dataPaths()) {
  const dir = path.dirname(paths.settings)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${paths.settings}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, paths.settings)
  return next
}

/** 合并部分设置（面板只改几个字段）。 */
export function patchSettings(patch, paths = dataPaths()) {
  const cur = readSettings(paths)
  const next = {
    ...cur,
    ...patch,
    author: { ...cur.author, ...(patch.author || {}) },
    include: { ...cur.include, ...(patch.include || {}) },
    sessions: { ...cur.sessions, ...(patch.sessions || {}) },
  }
  return writeSettings(next, paths)
}

/** 本机实例 id（首次调用生成并落盘）。 */
export function ensureInstanceId(paths = dataPaths()) {
  const cur = readSettings(paths)
  if (cur.instanceId) return cur.instanceId
  const id = `${os.hostname()}-${Math.random().toString(16).slice(2, 10)}`
  writeSettings({ ...cur, instanceId: id }, paths)
  return id
}

/** 时间戳（文件名安全）：20261022-231501。 */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * 复用 DSH 里已经登录好的 GitHub 凭据，用户不必再去建一个 PAT。
 *
 * 来源优先级：启动环境变量（github-mcp 这类插件会把凭据中心的值桥接到 env）→
 * 凭据中心的 refs 段。`.credentials.yaml` 只取 refs 下两空格缩进的 `NAME: VALUE`，
 * 手写最小解析即可，不为一个字段引入 yaml 依赖。
 *
 * @returns {{ token: string, source: string }} source 供面板徽标显示，空串表示没有凭据。
 */
export function readSharedGitHubToken(home = dshHome()) {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = String(process.env[name] ?? '').trim()
    if (value) return { token: value, source: `环境变量 ${name}` }
  }
  let text
  try {
    text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return { token: '', source: '' }
  }
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break // 离开 refs 段
    const m = /^\s+([A-Za-z0-9_.-]+):\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const [, key, rawValue] = m
    if (key !== 'GITHUB_TOKEN' && key !== 'GH_TOKEN') continue
    const value = rawValue.replace(/^['"]|['"]$/g, '').trim()
    if (value) return { token: value, source: 'DSH 凭据中心' }
  }
  return { token: '', source: '' }
}

/**
 * 本次 git 操作实际使用的 token。
 *
 * 面板「访问令牌」显式填了就用它；留空则自动复用 DSH 已登录的 GitHub 凭据——
 * 所以 SSH 远端、或者已经存过 token 的机器，什么都不用填。
 */
export function resolveToken(settings = {}, home = dshHome()) {
  const own = String(settings?.token ?? '').trim()
  if (own) return { token: own, source: '面板设置' }
  return readSharedGitHubToken(home)
}
