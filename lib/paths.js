/**
 * 跨机器路径映射。
 *
 * 两台机器的工程路径不可能一样（`D:\code\llm-news` vs `/Users/wuhy/code/llm-news`），
 * 而 DSH 的工作区会话目录又是**按路径派生的 slug**（`--D-code-llm-news--`）。
 * 所以只搬注册表不够：还得把远端 slug 下的会话挂到本机 slug 上，否则工作区能看见、
 * 点开却是空的。
 *
 * 规则形如 `D:\code => /Users/wuhy/code`，按 `from` 长度倒序匹配（最长前缀优先）。
 */

/** 路径分隔符与盘符冒号统一成 '/'，去掉末尾分隔符。 */
function normalize(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

/** Windows 盘符大小写不敏感；跨平台比较时统一小写。 */
function compareKey(p) {
  return normalize(p).toLowerCase()
}

/**
 * DSH 的会话目录 slug：`D:\code\llm-news` → `--D-code-llm-news--`。
 *
 * 依据本机真实目录反推：`C:\Users\Administrator\.dsh\profiles\desktop` →
 * `--C-Users-Administrator-.dsh-profiles-desktop--`（点号保留、分隔符压成一个 '-'）。
 * `/Users/wuhy/code/x` → `--Users-wuhy-code-x--`。
 */
export function slugOf(target) {
  const cleaned = String(target ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `--${cleaned}--`
}

/**
 * 解析映射规则。接受 `from => to`、`from -> to`、`from=to` 三种写法；
 * 空行和 `#` 开头的行忽略。
 * @param {string[]|string} input
 * @returns {{from: string, to: string, raw: string}[]}
 */
export function parsePathMap(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/)
  const rules = []
  for (const line of lines) {
    const text = String(line ?? '').trim()
    if (text === '' || text.startsWith('#')) continue
    const hit = /^(.+?)\s*(?:=>|->|=)\s*(.+)$/.exec(text)
    if (hit === null) continue
    const from = hit[1].trim()
    const to = hit[2].trim()
    if (from === '' || to === '') continue
    // `from` 归一成 '/' 便于比较；`to` 保留原样（输出沿用它自己的分隔符风格）
    rules.push({ from: normalize(from), to, raw: text })
  }
  // 最长前缀优先：`D:\code\sub` 的规则要先于 `D:\code` 生效
  rules.sort((a, b) => b.from.length - a.from.length)
  return rules
}

/**
 * 把远端路径映射成本机路径。
 *
 * @param {string} remotePath - 远端登记的工作区路径。
 * @param {ReturnType<typeof parsePathMap>} rules
 * @param {(p: string) => boolean} [exists] - 本机目录是否存在（不存在就别映射，免得造一个空工作区）。
 * @returns {string|null} 命中且本机存在时返回本机路径，否则 null。
 */
export function mapPath(remotePath, rules, exists = () => true) {
  const target = compareKey(remotePath)
  if (target === '') return null
  for (const rule of rules ?? []) {
    const from = compareKey(rule.from)
    if (from === '') continue
    if (target !== from && !target.startsWith(`${from}/`)) continue
    const rest = normalize(remotePath).slice(normalize(rule.from).length).replace(/^\/+/, '')
    // 输出沿用规则右侧的分隔符风格：Windows 规则给反斜杠，POSIX 规则给斜杠
    const sep = String(rule.to).includes('\\') ? '\\' : '/'
    const base = String(rule.to).replace(/[\\/]+$/, '')
    const mapped = rest === '' ? base : `${base}${sep}${rest.split('/').join(sep)}`
    if (exists(mapped)) return mapped
  }
  return null
}

/**
 * 反向映射：本机路径 → 远端路径。用于把本机新建的工作区写进镜像时统一成
 * 「对方机器的形态」不现实，所以这里只在需要判断「这条远端工作区是不是本机这个」时用。
 */
export function matchesLocal(remotePath, localPath) {
  return compareKey(remotePath) === compareKey(localPath)
}
