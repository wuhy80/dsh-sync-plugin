/**
 * /api/dsh-sync 路由族（面板的数据通道）。
 *
 * 与 dsh-ssh / dsh-github-workspaces 同一策略：所有端点过一道 loopback 门禁——
 * 这些端点会跑 git、读写 ~/.dsh，LAN 暴露的 dsh web 部署不该把它们敞开。
 */

import { dataPaths, patchSettings, readSettings, stamp } from './config.js'
import { fetchAndFastForward, ensureMirror, checkPrivate, commitAll, mirrorStatus, pushMirror, inspectRemote } from './repo.js'
import { applyPlan, overview, planSync, collectRepo } from './merge.js'
import { hasGit } from './proc.js'

export const BASE = '/api/dsh-sync'

/** 同步互斥：git 操作不能并发，否则镜像仓库会被两次写交叉。 */
let syncing = false

export const ENDPOINTS = {
  state: `${BASE}/state`,
  settings: `${BASE}/settings`,
  probe: `${BASE}/probe`,
  plan: `${BASE}/plan`,
  sync: `${BASE}/sync`,
  status: `${BASE}/status`,
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * DSH 的路由表只认 { path, handler }，**方法分派由插件自己做**
 * （参考实现 dsh-github-workspaces 同样在 handler 里判 method 并回 405）。
 */
function routeGuard(method, handler) {
  return async (req, res) => {
    if (!isLoopback(req)) return json(res, 403, { error: '只允许本机访问' })
    if (req.method !== method) return json(res, 405, { error: `方法不允许：${req.method}（应为 ${method}）` })
    try {
      await handler(req, res)
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * 构造路由表。
 * @param {{ log?: (msg: string) => void }} options
 */
export function makeRoutes(options = {}) {
  const log = options.log ?? (() => {})
  const paths = options.paths ?? dataPaths()

  return [
    {
      path: ENDPOINTS.state,
      handler: routeGuard('GET', async (req, res) => {
        const settings = readSettings(paths)
        const gitVersion = await hasGit()
        return json(res, 200, {
          settings: { ...settings, token: settings.token ? '***' : '' },
          gitVersion,
          overview: await overview({ paths, settings }),
        })
      }),
    },

    {
      path: ENDPOINTS.settings,
      handler: routeGuard('PUT', async (req, res) => {
        const body = await readBody(req)
        // token 语义：空串 / "***" = 保持不变；clearToken: true = 显式清空
        const patch = { ...body }
        delete patch.clearToken
        if (body.clearToken === true) {
          patch.token = ''
        } else if (patch.token === '' || patch.token === '***') {
          delete patch.token
        }
        const next = patchSettings(patch, paths)
        return json(res, 200, { settings: { ...next, token: next.token ? '***' : '' } })
      }),
    },

    {
      path: ENDPOINTS.probe,
      handler: routeGuard('POST', async (req, res) => {
        const settings = readSettings(paths)
        const gitVersion = await hasGit()
        const mirrorReady = await ensureMirror({
          mirror: paths.mirror,
          remote: settings.remote,
          branch: settings.branch,
          token: settings.token,
        })
        const privacy = settings.remote ? await checkPrivate({ remote: settings.remote, token: settings.token }) : { state: 'unknown', reason: '未配置远端' }
        const remote = inspectRemote(settings.remote)
        return json(res, 200, {
          gitVersion,
          mirrorReady,
          privacy,
          warnings: remote.embedded
            ? ['远端地址里内嵌了凭据：它会被写进 .git/config 与设置文件。建议改用 SSH（git@github.com:…）或把 token 填进「访问令牌」字段。']
            : [],
        })
      }),
    },

    {
      path: ENDPOINTS.plan,
      handler: routeGuard('POST', async (req, res) => {
        const settings = readSettings(paths)
        if (!settings.remote) return json(res, 400, { error: '未配置远程仓库' })
        await ensureMirror({ mirror: paths.mirror, remote: settings.remote, branch: settings.branch, token: settings.token })
        const fetched = await fetchAndFastForward({
          mirror: paths.mirror,
          branch: settings.branch,
          remote: settings.remote,
          token: settings.token,
        })
        const { plan, stats } = planSync({ paths, settings, mirror: paths.mirror })
        return json(res, 200, {
          fetched,
          stats,
          decisions: plan.decisions.map((d) => ({
            kind: d.kind,
            key: d.key ?? d.rel,
            action: d.action,
            note: d.note ?? '',
            conflicts: d.conflicts ?? 0,
            bytes: (d.buffer ?? d.text ?? '').length,
          })),
          git: await mirrorStatus({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote, token: settings.token }),
        })
      }),
    },

    {
      path: ENDPOINTS.sync,
      handler: routeGuard('POST', async (req, res) => {
        const settings = readSettings(paths)
        if (!settings.remote) return json(res, 400, { error: '未配置远程仓库' })
        const body = await readBody(req)
        const dryRun = Boolean(body.dryRun)
        if (syncing) return json(res, 409, { error: '已有同步在进行中，请等它结束' })
        syncing = true
        try {

        const ready = await ensureMirror({
          mirror: paths.mirror,
          remote: settings.remote,
          branch: settings.branch,
          token: settings.token,
        })
        if (!ready.ready) return json(res, 400, { error: `镜像仓库不可用：${ready.error}` })

        const privacy = await checkPrivate({ remote: settings.remote, token: settings.token })
        if (privacy.state === 'public') return json(res, 400, { error: '拒绝同步：远端是公共仓库（会话含私密内容）' })
        const remoteInfo = inspectRemote(settings.remote)
        if (remoteInfo.embedded) log(`警告：远端地址内嵌凭据（已脱敏：${remoteInfo.scrubbed}）`)

        const fetched = await fetchAndFastForward({
          mirror: paths.mirror,
          branch: settings.branch,
          remote: settings.remote,
          token: settings.token,
        })
        // 409 只留给「并发同步」；git 拉取失败是上游错误，用 502 区分
        if (!fetched.ok) return json(res, 502, { error: `拉取失败：${fetched.detail}` })

        const { plan, stats } = planSync({ paths, settings, mirror: paths.mirror })
        if (dryRun) {
          return json(res, 200, {
            dryRun: true,
            stats,
            decisions: plan.decisions.map((d) => ({ kind: d.kind, action: d.action, key: d.key ?? d.rel })),
          })
        }

        const applied = applyPlan(plan, { paths, mirror: paths.mirror })
        const commit = await commitAll({
          mirror: paths.mirror,
          message: `dsh-sync: ${stamp()} ${Object.entries(stats.sessions).filter(([k]) => ['localOnly', 'repoOnly', 'merged', 'fastForward'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        })
        let pushed = { ok: true, skipped: true }
        if (commit.committed) {
          pushed = await pushMirror({
            mirror: paths.mirror,
            branch: settings.branch,
            remote: settings.remote,
            token: settings.token,
          })
        }
        log(`sync done: commit=${commit.sha ?? '-'} push=${pushed.ok}`)
        return json(res, 200, {
          stats,
          applied,
          commit,
          pushed,
          privacy,
          git: await mirrorStatus({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote, token: settings.token }),
        })
        } finally {
          syncing = false
        }
      }),
    },

    {
      path: ENDPOINTS.status,
      handler: routeGuard('GET', async (req, res) => {
        const settings = readSettings(paths)
        const repo = collectRepo(paths.mirror, settings.profile)
        return json(res, 200, {
          git: await mirrorStatus({ mirror: paths.mirror, branch: settings.branch, remote: settings.remote, token: settings.token }),
          repo: { sessions: repo.sessions.size, workspace: Boolean(repo.workspace), plugins: Boolean(repo.packageJson) },
          overview: await overview({ paths, settings }),
        })
      }),
    },
  ]
}
