/**
 * dsh-sync — 浏览器半边。
 *
 * 两处挂载（都走 ctx.slots.inject，壳层声明了座位才注册）：
 * - sidebar.panellist：侧边栏的全局面板图标（order 55，排在 github-workspaces 之后）
 * - main：键控主面板，key 与图标 id 相同
 *
 * 数据全部走同源 /api/dsh-sync；这个模块不写任何文件，也不接管 document.body。
 * 所有失败只降级面板，不抛到壳层——插件的 apply 抛错会把整个 GUI 启动带崩。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PANEL_ID = 'dsh-sync'
    const API = '/api/dsh-sync'

    /** 设计令牌（壳层提供，暗色自动跟随）。 */
    const T = {
      bg: 'var(--dsw-alias-bg-base, #fff)',
      layer1: 'var(--dsw-alias-bg-layer-1, #f7f7f8)',
      layer2: 'var(--dsw-alias-bg-layer-2, #efeff2)',
      border1: 'var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
      border2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.2))',
      text: 'var(--dsw-alias-label-primary, #1a1a1a)',
      muted: 'var(--dsw-alias-label-secondary, #666)',
      brand: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      warn: 'var(--dsw-alias-state-warn-primary, #e8a33d)',
      err: 'var(--dsw-alias-state-error-primary, #e03131)',
    }

    const S = {
      page: { height: '100%', overflow: 'auto', background: T.bg, color: T.text, padding: '18px 22px 40px', fontSize: 13, lineHeight: 1.7 },
      card: { background: T.layer1, border: `1px solid ${T.border1}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 },
      title: { fontSize: 15, fontWeight: 650, margin: '0 0 4px' },
      sub: { color: T.muted, fontSize: 12, margin: '0 0 12px' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px', minWidth: 220 },
      label: { fontSize: 11.5, color: T.muted, letterSpacing: '.02em' },
      input: { background: T.bg, border: `1px solid ${T.border1}`, borderRadius: 7, color: T.text, padding: '6px 9px', fontSize: 12.5, outline: 'none' },
      btn: { background: T.layer2, border: `1px solid ${T.border1}`, borderRadius: 7, color: T.text, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
      btnPrimary: { background: T.brand, border: `1px solid ${T.brand}`, borderRadius: 7, color: '#fff', padding: '6px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
      stat: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 },
      statBox: { background: T.layer2, borderRadius: 8, padding: '8px 10px' },
      statNum: { fontSize: 17, fontWeight: 650, lineHeight: 1.2 },
      statLabel: { fontSize: 11, color: T.muted },
      pre: { background: T.layer2, borderRadius: 8, padding: '10px 12px', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto', margin: 0 },
      badge: (color) => ({ display: 'inline-block', padding: '1px 7px', borderRadius: 999, background: color, color: '#fff', fontSize: 11 }),
      check: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: T.text },
    }

    async function api(path, options = {}) {
      const res = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      const text = await res.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { error: text.slice(0, 200) }
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /**
     * 把 warnings / 版本冲突 / 路径冲突整理成给人看的几行。
     * 这些以前只躺在 stats 里，面板不显示 —— 跳过、冲突都被静默吞掉了。
     */
    function issueLines(s = {}) {
      const out = []
      const warnings = s.warnings ?? []
      for (const w of warnings.slice(0, 6)) out.push(`⚠ ${w}`)
      if (warnings.length > 6) out.push(`⚠ …另有 ${warnings.length - 6} 条提示`)

      const versions = s.plugins?.versionConflicts ?? []
      if (versions.length) {
        out.push(`⚠ 插件版本冲突 ${versions.length} 处：${versions.slice(0, 3).join('；')}${versions.length > 3 ? ' …' : ''}`)
      }
      const paths = s.workspace?.pathConflicts ?? []
      if (paths.length) {
        out.push(`⚠ 工作区路径不一致 ${paths.length} 处（未自动修改，需人工确认）：${paths.slice(0, 2).join('；')}${paths.length > 2 ? ' …' : ''}`)
      }
      const missing = s.workspace?.missingPaths ?? []
      if (missing.length) {
        out.push(`⚠ ${missing.length} 个工作区指向本机不存在的路径（多半来自另一台机器）：${missing.slice(0, 2).join('；')}${missing.length > 2 ? ' …' : ''}`)
      }
      return out
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)

      const load = useCallback(async () => {
        try {
          const data = await api('/state')
          setState(data)
          setForm((cur) => cur ?? { ...data.settings, token: '' })
        } catch (error) {
          setMsg({ kind: 'err', text: String(error.message ?? error) })
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const patchForm = (key, value) => setForm((f) => ({ ...f, [key]: value }))
      const patchInclude = (key, value) => setForm((f) => ({ ...f, include: { ...(f.include ?? {}), [key]: value } }))

      const save = async () => {
        setBusy('save')
        setMsg(null)
        try {
          const body = {
            remote: form.remote,
            branch: form.branch,
            profile: form.profile,
            include: form.include,
            sessions: form.sessions,
            author: form.author,
          }
          if (form.token) body.token = form.token
          await api('/settings', { method: 'PUT', body })
          setMsg({ kind: 'ok', text: '设置已保存' })
          await load()
        } catch (error) {
          setMsg({ kind: 'err', text: String(error.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const probe = async () => {
        setBusy('probe')
        setMsg(null)
        try {
          const data = await api('/probe', { method: 'POST' })
          const privacy = data.privacy?.state ?? 'unknown'
          setMsg({
            kind: privacy === 'public' ? 'err' : privacy === 'private' ? 'ok' : 'warn',
            text: `git: ${data.gitVersion ?? '未找到'}\n仓库可见性: ${privacy}${data.privacy?.reason ? `（${data.privacy.reason}）` : ''}\n镜像: ${data.mirrorReady?.ready ? '就绪' : `不可用 ${data.mirrorReady?.error ?? ''}`}`,
          })
        } catch (error) {
          setMsg({ kind: 'err', text: String(error.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const plan = async () => {
        setBusy('plan')
        setMsg(null)
        try {
          const data = await api('/plan', { method: 'POST' })
          const rows = data.decisions ?? []
          const s = data.stats ?? {}
          const lines = [
            `会话：本地独有 ${s.sessions?.localOnly ?? 0} · 远端独有 ${s.sessions?.repoOnly ?? 0} · 需合并 ${s.sessions?.merged ?? 0} · 一致 ${s.sessions?.identical ?? 0}`,
            `删除 ${s.sessions?.deleted ?? 0} · 跨目录合并 ${s.sessions?.crossSlug ?? 0} · 复活 ${s.sessions?.resurrected ?? 0} · 超限跳过 ${s.sessions?.skippedOversize ?? 0}`,
            `工作区：${s.workspace?.mode ?? '-'} · 插件：${s.plugins?.mode ?? '-'} · 设置：${s.settings?.mode ?? '-'}`,
            '',
            ...rows.slice(0, 60).map((d) => `${String(d.action).padEnd(9)} ${String(d.kind).padEnd(16)} ${d.key}`),
            rows.length > 60 ? `… 另有 ${rows.length - 60} 项` : '',
            ...issueLines(s),
          ].filter(Boolean)
          setMsg({ kind: rows.length ? 'warn' : 'ok', text: lines.join('\n') })
        } catch (error) {
          setMsg({ kind: 'err', text: String(error.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const sync = async () => {
        if (!window.confirm('将拉取远端 → 合并 → 提交并推送；本地被覆盖的文件会先备份到 ~/.dsh/dsh-sync/backup/。继续？')) return
        setBusy('sync')
        setMsg(null)
        try {
          const data = await api('/sync', { method: 'POST', body: {} })
          const s = data.stats ?? {}
          setMsg({
            kind: data.pushed?.ok === false ? 'err' : 'ok',
            text: [
              `会话：推送 ${s.sessions?.localOnly ?? 0} · 拉取 ${s.sessions?.repoOnly ?? 0} · 合并 ${s.sessions?.merged ?? 0} · 快进 ${s.sessions?.fastForward ?? 0}`,
              `删除 ${s.sessions?.deleted ?? 0} · 跨目录合并 ${s.sessions?.crossSlug ?? 0} · 复活 ${s.sessions?.resurrected ?? 0}`,
              `工作区 ${s.workspace?.mode ?? '-'} · 插件 ${s.plugins?.mode ?? '-'} · 设置 ${s.settings?.mode ?? '-'}${s.settings?.conflicts ? `（冲突 ${s.settings.conflicts}）` : ''}`,
              `写入：镜像 ${data.applied?.written?.repo ?? 0} · 本地 ${data.applied?.written?.local ?? 0}`,
              `提交：${data.commit?.committed ? data.commit.sha : '无改动'} · 推送：${data.pushed?.ok ? '成功' : data.pushed?.skipped ? '跳过' : `失败 ${data.pushed?.detail ?? ''}`}`,
              data.applied?.backup?.dir ? `备份：${data.applied.backup.dir}` : '',
              ...issueLines(s),
              data.needsInstall ? `\n⚠️ 插件清单已更新，请执行一次依赖安装：${data.installCommand}\n（装完重启 DSH 才会生效）` : '',
            ].filter(Boolean).join('\n'),
          })
          await load()
        } catch (error) {
          setMsg({ kind: 'err', text: String(error.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      if (!state || !form) {
        return h('div', { style: S.page }, h('div', { style: S.card }, '正在读取同步状态…'))
      }

      const o = state.overview ?? {}
      const git = o.git ?? {}
      const inc = form.include ?? {}

      return h('div', { style: S.page },
        h('div', { style: { marginBottom: 16 } },
          h('h2', { style: S.title }, '多机同步'),
          h('p', { style: S.sub }, '会话 / 工作区 / 插件清单走私有 Git 仓库；按数据类型分别合并，凭据文件永不入库。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.stat },
            h('div', { style: S.statBox }, h('div', { style: S.statNum }, String(o.local?.sessions ?? 0)), h('div', { style: S.statLabel }, '本地会话')),
            h('div', { style: S.statBox }, h('div', { style: S.statNum }, String(o.repo?.sessions ?? 0)), h('div', { style: S.statLabel }, '远端会话')),
            h('div', { style: S.statBox }, h('div', { style: S.statNum }, String(o.local?.plugins ?? 0)), h('div', { style: S.statLabel }, '本地插件')),
            h('div', { style: S.statBox }, h('div', { style: S.statNum }, String(o.repo?.plugins ?? 0)), h('div', { style: S.statLabel }, '远端插件')),
            h('div', { style: S.statBox },
              h('div', { style: S.statNum }, `${git.ahead ?? 0}/${git.behind ?? 0}`),
              h('div', { style: S.statLabel }, '领先 / 落后')),
            h('div', { style: S.statBox },
              h('div', { style: S.statNum }, String(git.dirtyCount ?? 0)),
              h('div', { style: S.statLabel }, '待提交文件')),
          ),
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('span', { style: S.badge(o.tokenConfigured ? T.ok : T.warn) },
              o.tokenConfigured ? `token 已配置${o.tokenSource ? `（${o.tokenSource}）` : ''}` : 'token 未配置'),
            h('span', { style: { color: T.muted, fontSize: 12 } }, o.remote || '未配置远端'),
            h('span', { style: { color: T.muted, fontSize: 12 } }, `profile: ${o.profile ?? '-'}`),
            o.remoteProfile && o.remoteProfile !== o.profile
              ? h('span', { style: { color: T.warn, fontSize: 12 } },
                  `远端用的是 ${o.remoteProfile}（插件清单各存一份，不会互相覆盖）`)
              : null,
            h('span', { style: { color: T.muted, fontSize: 12 } }, `上次同步: ${o.lastSyncAt ? o.lastSyncAt.slice(0, 19).replace('T', ' ') : '从未'}`),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('label', { style: S.field }, h('span', { style: S.label }, '远程仓库（私有）'),
              h('input', { style: S.input, value: form.remote ?? '', placeholder: 'git@github.com:you/dsh-sync.git 或 https://github.com/you/dsh-sync.git', onChange: (e) => patchForm('remote', e.target.value) })),
            h('label', { style: S.field }, h('span', { style: S.label }, '分支'),
              h('input', { style: S.input, value: form.branch ?? 'main', onChange: (e) => patchForm('branch', e.target.value) })),
          ),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h('label', { style: S.field }, h('span', { style: S.label }, '访问令牌（仅 HTTPS 需要；留空 = 自动复用 DSH 已登录的 GitHub 凭据）'),
              h('input', { style: S.input, type: 'password', value: form.token ?? '', placeholder: 'ghp_… / github_pat_…', onChange: (e) => patchForm('token', e.target.value) })),
            h('label', { style: S.field }, h('span', { style: S.label }, 'profile（留空 = 自动检测当前 profile）'),
              h('input', { style: S.input, value: form.profile ?? '', placeholder: o.profile ? `自动：${o.profile}` : 'desktop / web / tui …', onChange: (e) => patchForm('profile', e.target.value) })),
            h('label', { style: S.field }, h('span', { style: S.label }, '单会话合并上限（MB，超过则跳过并告警）'),
              h('input', {
                style: S.input,
                type: 'number',
                min: 1,
                value: String(form.sessions?.maxPerFileMB ?? 64),
                onChange: (e) => patchForm('sessions', { ...(form.sessions ?? {}), maxPerFileMB: Number(e.target.value) || 64 }),
              })),
          ),
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('label', { style: S.check }, h('input', { type: 'checkbox', checked: inc.sessions !== false, onChange: (e) => patchInclude('sessions', e.target.checked) }), '会话'),
            h('label', { style: S.check }, h('input', { type: 'checkbox', checked: inc.workspace !== false, onChange: (e) => patchInclude('workspace', e.target.checked) }), '工作区'),
            h('label', { style: S.check }, h('input', { type: 'checkbox', checked: inc.plugins !== false, onChange: (e) => patchInclude('plugins', e.target.checked) }), '插件清单'),
            h('label', { style: S.check }, h('input', { type: 'checkbox', checked: inc.settings !== false, onChange: (e) => patchInclude('settings', e.target.checked) }), '设置层'),
          ),
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('button', { style: S.btnPrimary, disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
            h('button', { style: S.btn, disabled: busy !== '', onClick: probe }, busy === 'probe' ? '检测中…' : '检测'),
            h('button', { style: S.btn, disabled: busy !== '' || !form.remote, onClick: plan }, busy === 'plan' ? '预演中…' : '预演'),
            h('button', { style: S.btnPrimary, disabled: busy !== '' || !form.remote, onClick: sync }, busy === 'sync' ? '同步中…' : '立即同步'),
            h('button', { style: S.btn, disabled: busy !== '', onClick: load }, '刷新'),
          ),
        ),

        msg ? h('div', { style: S.card },
          h('div', { style: { ...S.row, marginBottom: 8 } },
            h('span', { style: S.badge(msg.kind === 'ok' ? T.ok : msg.kind === 'err' ? T.err : T.warn) },
              msg.kind === 'ok' ? '完成' : msg.kind === 'err' ? '失败' : '提示')),
          h('pre', { style: S.pre }, msg.text),
        ) : null,

        h('p', { style: { color: T.muted, fontSize: 11.5, marginTop: 4 } },
          '提示：同步会在写入前备份到 ~/.dsh/dsh-sync/backup/；设置层冲突会保留本地并另存 .remote-<时间戳>；公共仓库会被拒绝。'),
      )
    }

    function PanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M21 12a9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9' }),
        h('path', { d: 'M21 3v6h-6' }),
        h('path', { d: 'M3 21v-6h6' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 55,
            label: () => '多机同步',
          }, PanelIcon)))

          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, Panel)))
        } catch (error) {
          console.warn('[dsh-sync] panel registration failed:', error)
        }

        try {
          ctx.effect(() => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose()
              } catch {
                /* 已释放 */
              }
            }
          }, 'dsh-sync: ui mounts')
        } catch (error) {
          console.warn('[dsh-sync] disposer registration failed:', error)
        }
      },
    }
  },
})
