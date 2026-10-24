/**
 * 私库判定（checkPrivate）的分类逻辑。
 *
 * 背景：数据仓库**必须**是私有库，而插件本身可以公开——这两件事要分开保证。
 * 早先的实现只在「配了 token」时才查询 API，于是 SSH 远端 + 无 token 时
 * `state=unknown` 直接放行，公共库拦不住。现在即使没有 token 也做一次**匿名**探测：
 *   公共库匿名可读（200 + private:false）→ 判 public → 同步被拒；
 *   私有库匿名 404 → unknown（放行，配合面板告警）。
 *
 * 用 stub 替换 globalThis.fetch，全部离线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 关键：把 DSH_HOME 指到空目录，并清掉环境变量里的 token，
// 否则 checkPrivate 会自动复用本机凭据中心的 GitHub token（那是生产行为，见下一个测试）。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-pc-'))
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

const { checkPrivate, inspectRemote, parseOwnerRepo } = await import('../lib/repo.js')

/** 装一个临时 fetch 桩，返回 { calls }，调用方负责恢复。 */
function stubFetch(impl) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return impl(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

const jsonResponse = (status, body) => ({
  status,
  json: async () => body,
})

test('有 token 且仓库私有 → private', async () => {
  const s = stubFetch(() => jsonResponse(200, { private: true, full_name: 'o/r' }))
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: 'TKN' })
    assert.equal(r.state, 'private')
    assert.equal(s.calls[0].headers.Authorization, 'Bearer TKN')
  } finally {
    s.restore()
  }
})

test('有 token 且仓库公开 → public（同步必须被拒）', async () => {
  const s = stubFetch(() => jsonResponse(200, { private: false, full_name: 'o/r' }))
  try {
    const r = await checkPrivate({ remote: 'https://github.com/o/r.git', token: 'TKN' })
    assert.equal(r.state, 'public')
  } finally {
    s.restore()
  }
})

test('**没有 token** 时也会匿名探测：200+private:false → public（本轮修的洞）', async () => {
  const s = stubFetch(() => jsonResponse(200, { private: false, full_name: 'o/r' }))
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: '' })
    assert.equal(r.state, 'public', '无 token 也必须能识别公共库')
    assert.equal(s.calls.length, 1, '应该发生了一次匿名请求')
    assert.equal(s.calls[0].headers.Authorization, undefined, '无 token 时不应带 Authorization')
  } finally {
    s.restore()
  }
})

test('没有 token 时私有库匿名 404 → unknown（放行，但原因写清）', async () => {
  const s = stubFetch(() => jsonResponse(404, { message: 'Not Found' }))
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: '' })
    assert.equal(r.state, 'unknown')
    assert.match(r.reason, /匿名不可见/)
  } finally {
    s.restore()
  }
})

test('网络不可达 → unknown，且不改判为 public', async () => {
  const s = stubFetch(() => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com')
  })
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: '' })
    assert.equal(r.state, 'unknown')
    assert.match(r.reason, /API 不可达/)
  } finally {
    s.restore()
  }
})

test('非 GitHub 远端不发起请求，直接 unknown', async () => {
  const s = stubFetch(() => jsonResponse(200, { private: false }))
  try {
    const r = await checkPrivate({ remote: 'https://gitlab.com/o/r.git', token: '' })
    assert.equal(r.state, 'unknown')
    assert.equal(s.calls.length, 0, '非 GitHub 远端不该请求 GitHub API')
  } finally {
    s.restore()
  }
})

test('API 返回 200 但没有 private 字段 → unknown（不猜）', async () => {
  const s = stubFetch(() => jsonResponse(200, {}))
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: '' })
    assert.equal(r.state, 'unknown')
  } finally {
    s.restore()
  }
})

test('parseOwnerRepo 支持 https / scp / ssh 三种形态', () => {
  assert.deepEqual(parseOwnerRepo('https://github.com/o/r.git'), { owner: 'o', repo: 'r' })
  assert.deepEqual(parseOwnerRepo('git@github.com:o/r.git'), { owner: 'o', repo: 'r' })
  assert.deepEqual(parseOwnerRepo('ssh://git@github.com/o/r'), { owner: 'o', repo: 'r' })
  assert.equal(parseOwnerRepo('https://gitlab.com/o/r.git'), null)
})

test('inspectRemote 识别内嵌凭据并脱敏', () => {
  const r = inspectRemote('https://user:SECRET@github.com/o/r.git')
  assert.equal(r.embedded, true)
  assert.equal(r.scrubbed.includes('SECRET'), false)
})

test('面板没填 token 时自动复用环境变量里的 GitHub 凭据', async () => {
  process.env.GITHUB_TOKEN = 'ENV_TOKEN_ABC'
  const s = stubFetch(() => jsonResponse(200, { private: true, full_name: 'o/r' }))
  try {
    const r = await checkPrivate({ remote: 'git@github.com:o/r.git', token: '' })
    assert.equal(r.state, 'private')
    assert.equal(s.calls[0].headers.Authorization, 'Bearer ENV_TOKEN_ABC', '应自动带上凭据中心的 token')
  } finally {
    s.restore()
    delete process.env.GITHUB_TOKEN
  }
})
