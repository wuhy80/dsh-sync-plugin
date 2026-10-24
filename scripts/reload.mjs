#!/usr/bin/env node
/**
 * 让 DSH 热重载插件，改完代码不用重启应用。
 *
 * 原理：DSH 内置 `@deepseek-ai/dsh-hmr`。它监听 profile 的 patch 文件，patch 一变就做一次
 * 「profile 重组」；重组时会把「node_modules 下已安装包 / link: 链接包（含软链目标）」
 * 里磁盘上内容变过的文件对应的插件重新挂载。
 *
 * 所以开发这个插件时：
 *   1. 用 `dsh plugin --profile desktop add link:<本仓库>` 装成链接包；
 *   2. 改完代码跑一次本脚本 → 约 1.5~3 秒生效；
 *   3. 面板那半（client.js）是浏览器模块，需要 Ctrl+R 刷新页面。
 *
 * 注意：HMR 只替换「文件真的变了」的插件；源码没动时不会重新挂载，这是正常的。
 *
 * 用法：
 *   node scripts/reload.mjs                # 默认 desktop profile
 *   node scripts/reload.mjs --profile=web
 *   node scripts/reload.mjs --wait         # 等到挂载日志出现新记录再退出
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const profile = argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) || 'desktop'
const wait = argv.includes('--wait')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const patch = path.join(home, 'profiles', profile, 'cordis.patch.yml')

if (!fs.existsSync(patch)) {
  console.error(`找不到 profile patch：${patch}`)
  console.error('用法：node scripts/reload.mjs [--profile=desktop] [--wait]')
  process.exit(1)
}

// 只写一行标记，顺手清掉上一行，避免把 patch 文件越写越大。
// 用 UTF-8（无 BOM）读写：patch 里有中文注释，按系统 ANSI 编码写会写坏。
const MARK = '# dsh-hmr-trigger '
const text = fs.readFileSync(patch, 'utf8')
const kept = text.split(/\r?\n/).filter((line) => !line.startsWith(MARK))
while (kept.length && kept[kept.length - 1] === '') kept.pop()
const stamp = new Date().toISOString()
kept.push(`${MARK}${stamp}`)
fs.writeFileSync(patch, `${kept.join('\n')}\n`, 'utf8')

console.log(`已触发 profile 重组（${profile}）`)
console.log(`  ${patch}`)
console.log(`  标记 ${stamp}`)

if (!wait) {
  console.log('约 1.5~3 秒后生效；加 --wait 可等到挂载日志出现新记录。')
  process.exit(0)
}

const log = path.join(home, 'dsh-sync-mount.log')
const countMounts = () => {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('mounted;')).length
  } catch {
    return 0
  }
}

const before = countMounts()
const started = Date.now()
while (Date.now() - started < 20000) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (countMounts() > before) {
    console.log(`插件已重新挂载，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`)
    process.exit(0)
  }
}
console.warn('20 秒内没看到重新挂载：这次没有文件变化（HMR 只替换内容变过的插件），或 HMR 没启用。')
process.exit(0)
