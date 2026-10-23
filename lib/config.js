/**
 * 路径与设置。
 *
 * 设置落在 $DSH_HOME/dsh-sync.json（0600）：浏览器半边的面板会改它，
 * 走的是本插件的 HTTP 路由，因此不依赖 schemastery / cordis 配置。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  profile: 'desktop',
  /** 四类数据的开关：默认全开（会话同步是用户明确要的）。 */
  include: { sessions: true, workspace: true, plugins: true, settings: true },
  /** 会话合并策略：union = 行级并集（推荐）；fork = 保留冲突副本（保守）。 */
  sessions: { strategy: 'union', maxPerFileMB: 64 },
  /** 永不入库的东西（写死在代码里更安全，这里只是显式声明便于审计）。 */
  neverSync: ['.credentials.yaml', 'credentials.yaml', 'node_modules', 'cache', 'runtimes', 'attachments'],
})

/** 读设置：缺字段用默认值补齐；文件不存在返回默认值。 */
export function readSettings(paths = dataPaths()) {
  const base = DEFAULT_SETTINGS()
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(paths.settings, 'utf8'))
  } catch {
    return base
  }
  return {
    ...base,
    ...raw,
    author: { ...base.author, ...(raw.author || {}) },
    include: { ...base.include, ...(raw.include || {}) },
    sessions: { ...base.sessions, ...(raw.sessions || {}) },
  }
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
