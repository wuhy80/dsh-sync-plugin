/**
 * dsh-sync — 宿主半边。
 *
 * 挂三样东西：
 * 1. /api/dsh-sync 路由族（面板的数据通道：状态、设置、预演、同步）；
 * 2. dsh_sync agent 工具（只读：status / plan）；
 * 3. 一条 systemPrompt 说明，让 agent 知道边界（真正的同步只在面板里点）。
 *
 * 浏览器半边（./client）负责侧边栏入口与面板，由 package.json 的 dsh.client 声明加载。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataPaths, ensureInstanceId, readSettings } from './lib/config.js'
import { overview, planSync } from './lib/merge.js'
import { ensureMirror, fetchAndFastForward } from './lib/repo.js'
import { makeRoutes } from './lib/routes.js'
import { SYNC_GUIDANCE, dshSyncTool } from './lib/tools.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-sync'

/** 依赖的服务：webServer 给面板用，tools/systemPrompt 给 agent 用。 */
export const inject = ['webServer', 'tools', 'systemPrompt']

const SECTION_ORDER = 154

/** 挂载诊断：宿主 console 抓不到，失败原因落盘才好排查。 */
function logMount(message) {
  try {
    const file = path.join(os.homedir(), '.dsh', 'dsh-sync-mount.log')
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

function describe(error) {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`
  return String(error)
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const paths = dataPaths()

  try {
    ensureInstanceId(paths)
    logMount(`mounted; home=${paths.home}`)
  } catch (error) {
    logMount(`instance id failed: ${describe(error)}`)
  }

  // 数据通道（面板）
  ctx.effect(() => {
    const disposers = makeRoutes({ paths, log: logMount }).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-sync: routes')

  // agent 工具（只读）
  ctx.effect(() => {
    try {
      const disposer = ctx.tools.register(dshSyncTool({
        overview: () => overview({ paths, settings: readSettings(paths) }),
        plan: async () => {
          const settings = readSettings(paths)
          if (!settings.remote) throw new Error('未配置远程仓库（先在「多机同步」面板里填）')
          const ready = await ensureMirror({
            mirror: paths.mirror,
            remote: settings.remote,
            branch: settings.branch,
            token: settings.token,
          })
          if (!ready.ready) throw new Error(`镜像仓库不可用：${ready.error}`)
          await fetchAndFastForward({
            mirror: paths.mirror,
            branch: settings.branch,
            remote: settings.remote,
            token: settings.token,
          })
          const { plan, stats } = planSync({ paths, settings, mirror: paths.mirror })
          return {
            stats,
            decisions: plan.decisions.map((d) => ({ kind: d.kind, action: d.action, key: d.key ?? d.rel, conflicts: d.conflicts ?? 0 })),
          }
        },
      }))
      logMount('tool registered: dsh_sync')
      return disposer
    } catch (error) {
      logMount(`tool registration failed: ${describe(error)}`)
      return () => {}
    }
  }, 'dsh-sync: tool')

  // agent 说明
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.section({
        name: 'plugin:dsh-sync',
        order: SECTION_ORDER,
        text: SYNC_GUIDANCE,
      })
    } catch (error) {
      logMount(`guidance section failed: ${describe(error)}`)
      return () => {}
    }
  }, 'dsh-sync: guidance')
}
