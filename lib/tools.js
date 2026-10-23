/**
 * agent 侧工具：只暴露**只读**动作（status / plan）。
 *
 * 与 dsh-github-workspaces 同一取舍：推送、拉取合并、写回本地都会改真实状态，
 * 属于「用户显式授权」的操作，只在面板里由用户点击；工具侧只做诊断与预演，
 * 避免 agent 在无人值守时把两台机器写乱。
 */

export const SYNC_GUIDANCE = [
  '本机已安装 dsh-sync 插件（DSH 多机同步）：Web 侧边栏有「多机同步」面板。',
  '同步对象：会话（~/.dsh/sessions 的多帧 zstd 追加日志，按行做并集合并）、工作区注册表（storages/workspace.json 按 id 键合并）、插件清单（profiles/<p>/package.json 依赖集合合并 + 版本仲裁）与设置层（cordis.patch.yml 三路行合并）。',
  '传输：私有 Git 仓库（GitHub / SSH 均可）；公共仓库会被拒绝；凭据文件 .credentials.yaml 永不入库。',
  '工具：dsh_sync，action = status（两侧数量与 git 状态）| plan（预演：会改哪些文件，不写盘）。',
  '限制：真正的同步（拉取 + 合并 + 提交 + 推送）只能在面板里手动点击；每次写回本地前插件都会备份到 ~/.dsh/dsh-sync/backup/。',
  '用户提到「多机同步 DSH、同步会话/工作区/插件、GitHub 中转、合并」时即指本插件。',
].join('\n')

function text(value) {
  return [{ type: 'text', text: value }]
}

/** 工具结果必须是无损 JSON（undefined 会被丢弃并导致整次调用失败）。 */
function reply(ok, summary, data) {
  let clean = {}
  try {
    const round = data === undefined ? {} : JSON.parse(JSON.stringify(data))
    clean = typeof round === 'object' && round !== null && !Array.isArray(round) ? round : { value: round }
  } catch {
    clean = {}
  }
  return { ok, summary, data: clean }
}

/**
 * @param {{ overview: Function, plan: Function }} deps
 */
export function dshSyncTool(deps) {
  return {
    name: 'dsh_sync',
    description:
      'DSH 多机同步诊断：查看本地与远端仓库的会话/工作区/插件数量、git 领先落后，以及预演同步会改动哪些文件（只读，不写盘）。' +
      '真正的同步动作只在 Web 面板里由用户手动触发。' +
      'Triggers: dsh sync, 多机同步, 同步会话, 同步工作区, 同步插件, GitHub 中转, 合并冲突.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'plan'],
          description: 'status=两侧数量与 git 状态；plan=预演同步计划（不写盘）。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'summary', 'data'],
      },
      render: (_args, value) => text(value.summary ?? ''),
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : ''
      try {
        if (action === 'status') {
          const o = await deps.overview()
          const lines = [
            `远端：${o.remote || '未配置'}（${o.branch}）${o.tokenConfigured ? ' · token 已配置' : ' · 未配置 token（SSH 远端可忽略）'}`,
            `本地：会话 ${o.local.sessions} · 工作区 ${o.local.workspace ? '有' : '无'} · 插件 ${o.local.plugins} · 设置 ${o.local.patch ? '有' : '无'}`,
            `镜像：会话 ${o.repo.sessions} · 工作区 ${o.repo.workspace ? '有' : '无'} · 插件 ${o.repo.plugins} · 设置 ${o.repo.patch ? '有' : '无'}`,
            `git：落后 ${o.git.behind} · 领先 ${o.git.ahead} · 待提交 ${o.git.dirtyCount}`,
            `上次同步：${o.lastSyncAt ?? '从未'}`,
          ]
          return reply(true, lines.join('\n'), o)
        }
        if (action === 'plan') {
          const { stats, decisions } = await deps.plan()
          if (!decisions.length) return reply(true, '两侧已一致，没有需要同步的内容。', { stats, decisions })
          const head = decisions.slice(0, 40).map((d) => `${d.action.padEnd(9)} ${d.kind.padEnd(16)} ${d.key}`)
          const more = decisions.length > 40 ? `\n… 另有 ${decisions.length - 40} 项` : ''
          const sum = [
            `会话：本地独有 ${stats.sessions.localOnly} · 远端独有 ${stats.sessions.repoOnly} · 需合并 ${stats.sessions.merged} · 一致 ${stats.sessions.identical}`,
            `工作区：${stats.workspace.mode} · 新增 ${stats.workspace.added} · 更新 ${stats.workspace.updated}`,
            `插件：${stats.plugins.mode} · 新增 ${stats.plugins.added.length} · 版本仲裁 ${stats.plugins.versionConflicts.length}`,
            `设置：${stats.settings.mode}${stats.settings.conflicts ? ` · 冲突 ${stats.settings.conflicts}` : ''}`,
          ]
          return reply(true, [`同步计划（共 ${decisions.length} 项）`, ...sum, '', ...head].join('\n') + more, { stats, decisions: decisions.slice(0, 200) })
        }
        return reply(false, `未知 action：${action || '(空)'}`, {})
      } catch (error) {
        return reply(false, `失败：${error instanceof Error ? error.message : String(error)}`, {})
      }
    },
  }
}
