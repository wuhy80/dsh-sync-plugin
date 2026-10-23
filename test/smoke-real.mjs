/**
 * 真实数据冒烟：只读。
 * 1) 收集本机状态（会话/工作区/插件/设置）
 * 2) 造一个临时镜像，先原样灌入 → 预演应为「全部一致」
 * 3) 动一个会话（追加一帧）→ 预演应报 1 个合并
 * 4) 用假 ctx 加载宿主模块，确认 apply() 不炸
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const { dataPaths, readSettings } = await import('../lib/config.js')
const { collectLocal, planSync } = await import('../lib/merge.js')
const { encodeFrames, splitFrames, linesOf, SESSION_FILE } = await import('../lib/sessions.js')

const paths = dataPaths()
const settings = { ...readSettings(paths), remote: 'https://github.com/example/dsh-sync.git', profile: 'desktop' }
const local = collectLocal(paths, settings)

console.log('== 本地状态 ==')
console.log('会话文件数:', local.sessions.size)
console.log('工作区注册表:', local.workspace ? `${local.workspace.length} 字符` : '无')
console.log('插件清单:', local.packageJson ? `${Object.keys(JSON.parse(local.packageJson).dependencies ?? {}).length} 个依赖` : '无')
console.log('设置层:', local.patch ? `${local.patch.split('\n').length} 行` : '无')

// 临时镜像
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-smoke-'))
const mirror = path.join(tmp, 'repo')
fs.mkdirSync(mirror, { recursive: true })

const copyInto = (rel, src) => {
  if (!src || !fs.existsSync(src)) return
  const dst = path.join(mirror, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

// 灌一份「远端 = 本地」
for (const [key, abs] of local.sessions) copyInto(path.join('sessions', key, SESSION_FILE), abs)
copyInto('workspace/workspace.json', paths.workspace)
copyInto('workspace/github-workspaces.json', paths.githubWorkspaces)
copyInto(`plugins/desktop/package.json`, paths.profile('desktop').packageJson)
copyInto(`plugins/desktop/cordis.patch.yml`, paths.profile('desktop').patch)
copyInto(`plugins/desktop/pnpm-lock.yaml`, paths.profile('desktop').lock)

const p1 = planSync({ paths, settings, mirror })
console.log('\n== 预演 A：两侧相同 ==')
console.log('计划项:', p1.plan.decisions.length, '（期望 0）')
console.log('会话统计:', p1.plan.stats.sessions)

// 挑一个最大的会话，追加一帧，模拟「另一台机器又多了一条事件」
const biggest = [...local.sessions.entries()].sort((a, b) => fs.statSync(b[1]).size - fs.statSync(a[1]).size)[0]
const mirrorFile = path.join(mirror, 'sessions', biggest[0], SESSION_FILE)
const frames = splitFrames(fs.readFileSync(mirrorFile)).frames
const extra = JSON.stringify({ type: 'smoke', at: Date.now(), note: '来自另一台机器的事件' })
const patched = Buffer.concat([fs.readFileSync(mirrorFile), encodeFrames([extra])])
fs.writeFileSync(mirrorFile, patched)

const p2 = planSync({ paths, settings, mirror })
console.log('\n== 预演 B：远端多一帧 ==')
console.log('计划项:', p2.plan.decisions.length, '（期望 1）')
for (const d of p2.plan.decisions) console.log('  ', d.action, d.kind, d.key, d.note ?? '')
console.log('会话统计:', p2.plan.stats.sessions)

// 合并结果校验：应包含新增行
const { mergeSessionBuffers } = await import('../lib/sessions.js')
const merged = mergeSessionBuffers(fs.readFileSync(biggest[1]), patched)
const mergedLines = linesOf(splitFrames(merged.buffer).frames)
console.log('合并模式:', merged.mode, '| 原帧行数:', linesOf(frames).length, '| 合并后行数:', mergedLines.length)
console.log('最后一行是新增事件:', mergedLines[mergedLines.length - 1] === extra)

// 宿主模块加载（假 ctx）
const mod = await import('../index.js')
const registered = { routes: 0, tools: 0, prompts: 0 }
const fakeCtx = {
  webServer: { register: () => { registered.routes++; return () => {} } },
  tools: { register: () => { registered.tools++; return () => {} } },
  systemPrompt: { section: () => { registered.prompts++; return () => {} } },
  effect: (fn) => { fn() },
}
mod.apply(fakeCtx)
console.log('\n== 宿主模块 ==')
console.log('name:', mod.name, '| inject:', mod.inject.join(','))
console.log('注册结果:', registered)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n净化完成。')
