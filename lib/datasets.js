/**
 * 数据集合并：把「可合并」这件事落实到每种数据上。
 *
 * - 工作区注册表 `storages/workspace.json`：按 id 做键合并，sessionIds/归档/置顶取并集，
 *   同一工作区两边都改过则按 updatedAt 取新（路径冲突单独报告，不自动改 path）。
 * - 插件清单 `profiles/<p>/package.json`：dependencies 取并集 + 版本仲裁；
 *   `dsh.profile.bundles` 取并集；`link:`/`file:` 本地依赖标成「仅本机」，避免另一端装不上。
 * - 设置层 `cordis.patch.yml`：三路行合并（base/local/remote），冲突不猜，保留本地并写下 .remote。
 */

/** 稳定序列化：键排序后 stringify，用于「语义相同」判断（忽略格式差异）。 */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value))
}

/** 解析 JSON，失败返回 null（调用方决定保守策略）。 */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 版本号比较：只处理常见形态（x.y.z / ^x.y.z / ~x.y.z / 范围）。非版本返回 null。 */
export function parseVersion(spec) {
  const m = String(spec ?? '').trim().match(/^[\^~=]?\s*v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 返回 1（a 新）/ -1（b 新）/ 0（相同或无法比较）。 */
export function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return 0
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1
  }
  return 0
}

/** 本地专用依赖（link:/file:/workspace:）——不能下发给另一台机器。 */
export function isLocalOnlySpec(spec) {
  return /^(link:|file:|workspace:)/.test(String(spec ?? '').trim())
}

// ── 工作区 ────────────────────────────────────────────────────────────────

/** 数组并集（保持 base 顺序，后补 other 的新元素）。 */
function unionArray(base, other) {
  const out = Array.isArray(base) ? [...base] : []
  const seen = new Set(out)
  for (const x of Array.isArray(other) ? other : []) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/**
 * 合并工作区注册表。
 * @returns {{merged: object, stats: {workspacesAdded:number, workspacesUpdated:number, pathConflicts:string[]}}}
 */
export function mergeWorkspace(local, remote) {
  const out = JSON.parse(JSON.stringify(local ?? {}))
  const stats = { workspacesAdded: 0, workspacesUpdated: 0, pathConflicts: [] }
  if (!remote || typeof remote !== 'object') return { merged: out, stats }

  // 只在至少一侧存在时才处理某个键 —— 否则会凭空造键，导致「内容没变也判定为变化」
  if (out.unit === undefined && remote.unit !== undefined) out.unit = remote.unit

  const hasGlobal = out.global !== undefined || remote.global !== undefined
  const lg = out.global ?? (out.global = {})
  const rg = remote.global ?? {}
  const ARRAYS = new Set(['workspaceIds', 'archivedSessionIds', 'pinnedSessionIds'])
  for (const key of ['initialized', 'defaultWorkspaceId', 'workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    const hasL = key in lg
    const hasR = key in rg
    if (!hasL && !hasR) continue
    if (ARRAYS.has(key)) lg[key] = unionArray(lg[key], rg[key])
    else if (key === 'initialized') lg[key] = Boolean(lg[key] || rg[key])
    else lg[key] = lg[key] ?? rg[key]
  }
  if (!hasGlobal && Object.keys(lg).length === 0) delete out.global

  const rt = remote.tables?.workspaces ?? {}
  if (!Object.keys(rt).length && !out.tables?.workspaces) return { merged: out, stats }
  out.tables = out.tables ?? {}
  out.tables.workspaces = out.tables.workspaces ?? {}
  for (const [id, rws] of Object.entries(rt)) {
    const lws = out.tables.workspaces[id]
    if (!lws) {
      out.tables.workspaces[id] = rws
      stats.workspacesAdded++
      continue
    }
    // 同一工作区：取 updatedAt 较新者做主，sessionIds 永远取并集
    const lTime = Date.parse(lws.updatedAt ?? 0) || 0
    const rTime = Date.parse(rws.updatedAt ?? 0) || 0
    const pickNewer = rTime > lTime
    const merged = pickNewer ? { ...lws, ...rws } : { ...rws, ...lws }
    merged.sessionIds = unionArray(lws.sessionIds, rws.sessionIds)
    if (lws.path && rws.path && lws.path !== rws.path) {
      // 两台机器同一工作区挂在不同路径：不自动改，报出来交给用户决定
      stats.pathConflicts.push(`${id}: ${lws.path} ≠ ${rws.path}`)
    }
    out.tables.workspaces[id] = merged
    stats.workspacesUpdated++
  }
  return { merged: out, stats }
}

// ── 插件清单 ──────────────────────────────────────────────────────────────

/**
 * 合并 `profiles/<name>/package.json`。
 * @returns {{merged: object, stats: {added:string[], updated:string[], versionConflicts:string[], localOnly:string[]}}}
 */
export function mergePluginManifest(local, remote) {
  const out = JSON.parse(JSON.stringify(local ?? {}))
  const stats = { added: [], updated: [], versionConflicts: [], localOnly: [] }
  if (!remote || typeof remote !== 'object') return { merged: out, stats }

  out.dependencies = out.dependencies ?? {}
  for (const [name, spec] of Object.entries(remote.dependencies ?? {})) {
    const cur = out.dependencies[name]
    if (cur === undefined) {
      out.dependencies[name] = spec
      stats.added.push(name)
      continue
    }
    if (cur === spec) continue
    if (isLocalOnlySpec(spec)) {
      // 远端是 link:/file: —— 只可能来自本机，忽略
      continue
    }
    if (isLocalOnlySpec(cur)) {
      // 本地是 link:（开发中的本地包）→ 保留本地，记一笔「仅本机」
      stats.localOnly.push(name)
      continue
    }
    const cmp = compareVersions(cur, spec)
    if (cmp < 0) {
      out.dependencies[name] = spec
      stats.versionConflicts.push(`${name}: ${cur} → ${spec}`)
      stats.updated.push(name)
    } else if (cmp === 0 && cur !== spec) {
      // 同版本不同写法（^1.2.3 vs 1.2.3）：保留本地
      stats.versionConflicts.push(`${name}: 保留本地 ${cur}（远端 ${spec}）`)
    } else if (cmp > 0) {
      stats.versionConflicts.push(`${name}: 保留本地更高版本 ${cur}（远端 ${spec}）`)
    }
  }

  // bundles 取并集（顺序：本地优先，远端新增追加）
  const lb = out.dsh?.profile?.bundles
  const rb = remote.dsh?.profile?.bundles
  if (Array.isArray(lb) || Array.isArray(rb)) {
    out.dsh = out.dsh ?? {}
    out.dsh.profile = out.dsh.profile ?? {}
    out.dsh.profile.bundles = unionArray(lb, rb)
  }

  // 「仅本机」的依赖只记进 stats，**不写进清单本身**——
  // 否则每次同步都会因为多了一个 dshSync 字段而制造出「需要合并」的噪音。
  const localOnly = Object.entries(out.dependencies)
    .filter(([, spec]) => isLocalOnlySpec(spec))
    .map(([name]) => name)
  stats.localOnly = localOnly
  return { merged: out, stats }
}

// ── 文本三路合并（cordis.patch.yml 这类 YAML）─────────────────────────────

/**
 * 行级三路合并。
 *
 * 没有 base（首次同步）时不再一律「取本地」：先看两侧是不是**包含关系**——
 * 一台机器的 patch 常常只是另一台的子集（多装了几个插件、多了几行配置）。
 * 这种情况下取超集是纯粹的收益，不产生冲突；只有真正分叉时才退化为
 * 「保留本地 + 远端另存 .remote-<时间戳>」。
 *
 * @returns {{ text: string, conflicts: number, applied: number, adopted?: 'local'|'remote' }}
 */
export function threeWayMergeText(base, local, remote) {
  const toLines = (s) => (s ?? '').replace(/\r\n/g, '\n').split('\n')
  const a = toLines(base)
  const l = toLines(local)
  const r = toLines(remote)

  if (local === remote) return { text: local ?? '', conflicts: 0, applied: 0 }
  if (!base) {
    // 远端是本地子集 → 本地已经是超集，什么都不用做
    if (isSubsequence(r, l)) return { text: local ?? '', conflicts: 0, applied: 0, adopted: 'local' }
    // 本地是远端子集 → 远端是纯增量，直接采用远端
    if (isSubsequence(l, r)) return { text: remote ?? '', conflicts: 0, applied: 1, adopted: 'remote' }
    return { text: local ?? '', conflicts: 1, applied: 0 }
  }

  // 行数过大时 LCS 的 O(n·m) 内存会爆（1 万行 ≈ 400MB）：降级为「保留本地 + 另存远端」
  const TOO_LARGE = 4000
  if (Math.max(a.length, l.length, r.length) > TOO_LARGE) {
    return { text: local ?? '', conflicts: 1, applied: 0, tooLarge: true }
  }

  const lcs = (x, y) => {
    // 最长公共子序列（行级），会话文件不大，O(n·m) 可接受
    const n = x.length
    const m = y.length
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    const out = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push([i, j])
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
      else j++
    }
    return out
  }

  // 把 base→local 的编辑映射到 base 行区间，再叠加 base→remote
  const lDiff = diffOps(a, l, lcs)
  const rDiff = diffOps(a, r, lcs)

  const ops = new Map()
  const bucket = (diff) => {
    for (const op of diff) {
      const key = op.index
      if (!ops.has(key)) ops.set(key, { local: null, remote: null })
      ops.get(key)[op.side] = op
    }
  }
  bucket(lDiff.map((o) => ({ ...o, side: 'local' })))
  bucket(rDiff.map((o) => ({ ...o, side: 'remote' })))

  const out = []
  let conflicts = 0
  let applied = 0
  const keys = [...ops.keys()].sort((x, y) => x - y)
  let cursor = 0
  for (const key of keys) {
    while (cursor < key) {
      out.push(a[cursor])
      cursor++
    }
    const { local: lo, remote: ro } = ops.get(key)
    if (lo && ro) {
      if (sameEdit(lo, ro)) {
        out.push(...ro.lines)
        applied++
      } else {
        // 两边都改了同一处：保留本地，标记冲突（调用方另存远端版本）
        out.push(...lo.lines)
        conflicts++
      }
      cursor = Math.max(lo.end, ro.end)
    } else {
      const one = lo || ro
      out.push(...one.lines)
      applied++
      cursor = one.end
    }
  }
  while (cursor < a.length) {
    out.push(a[cursor])
    cursor++
  }
  return { text: out.join('\n'), conflicts, applied }
}

/** needle 是否是 haystack 的子序列（保持相对顺序）。空 needle 恒为真。 */
function isSubsequence(needle, haystack) {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

/** 把一条 side 的差异压成「base 行区间 → 替换行」的操作列表。 */
function diffOps(base, side, lcsFn) {
  const matches = lcsFn(base, side)
  const ops = []
  let bi = 0
  let si = 0
  const push = (bStart, bEnd, lines) => {
    if (bStart === bEnd && lines.length === 0) return
    ops.push({ index: bStart, end: bEnd, lines })
  }
  for (const [bm, sm] of matches) {
    if (bm > bi || sm > si) push(bi, bm, side.slice(si, sm))
    bi = bm + 1
    si = sm + 1
  }
  if (bi < base.length || si < side.length) push(bi, base.length, side.slice(si))
  return ops
}

function sameEdit(a, b) {
  return a.end === b.end && a.lines.length === b.lines.length && a.lines.every((x, i) => x === b.lines[i])
}
