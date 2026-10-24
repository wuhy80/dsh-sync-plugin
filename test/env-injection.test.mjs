/**
 * HTTPS+token 的凭据注入机制（B2）。
 *
 * 真实往返只验证了 SSH；这条路径靠 `GIT_CONFIG_*` 让 git 自己把
 * `https://github.com/...` 改写成带 token 的 URL（token 不进 argv）。
 * 这里分两步验证：
 *   1) `gitEnv()` 产出的三个环境变量是否正确；
 *   2) git 是否真的按这组环境变量改写 URL —— 用两个本地裸仓库模拟
 *      （`insteadOf` 机制与 host 无关，file:// 一样生效）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { gitEnv, run } = await import('../lib/proc.js')

test('gitEnv：https+token 时注入 insteadOf，且 token 只在环境变量里', () => {
  // 刻意不用 ghp_/github_pat_ 前缀：GitHub 的 secret scanning 会对这类字面量发误报邮件
  const TOKEN = 'FAKE_TOKEN_FOR_TEST_ONLY'
  const env = gitEnv({ token: TOKEN, remote: 'https://github.com/o/r.git' })
  assert.equal(env.GIT_CONFIG_COUNT, '1')
  assert.equal(env.GIT_CONFIG_KEY_0, `url.https://x-access-token:${TOKEN}@github.com/.insteadOf`)
  assert.equal(env.GIT_CONFIG_VALUE_0, 'https://github.com/')
  // 其它安全默认值
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
})

test('gitEnv：SSH 远端不注入（交给 ssh-agent）', () => {
  const env = gitEnv({ token: 'ghp_x', remote: 'git@github.com:o/r.git' })
  assert.equal(env.GIT_CONFIG_COUNT, undefined, 'SSH 远端不该注入 insteadOf')
})

test('gitEnv：无 token 时不注入', () => {
  const env = gitEnv({ token: '', remote: 'https://github.com/o/r.git' })
  assert.equal(env.GIT_CONFIG_COUNT, undefined)
})

test('insteadOf 机制：git 会按环境变量把 URL 改写（file:// 模拟）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-inject-'))
  const orig = path.join(tmp, 'orig', 'repo.git')
  const mapped = path.join(tmp, 'mapped', 'repo.git')
  fs.mkdirSync(path.dirname(orig), { recursive: true })
  fs.mkdirSync(path.dirname(mapped), { recursive: true })

  // 真正的仓库放在 mapped；orig 只是"用户填的地址"
  assert.equal((await run('git', ['init', '--bare', '-q', '-b', 'main', mapped])).code, 0)
  assert.equal((await run('git', ['init', '-q', '-b', 'main', path.join(tmp, 'seed')])).code, 0)
  fs.writeFileSync(path.join(tmp, 'seed', 'a.txt'), 'hello\n')
  for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']]) {
    const r = await run('git', ['-C', path.join(tmp, 'seed'), ...args])
    assert.equal(r.code, 0, r.stderr)
  }
  const push = await run('git', ['-C', path.join(tmp, 'seed'), 'push', '-q', mapped, 'main'])
  assert.equal(push.code, 0, push.stderr)

  // orig 不存在，不加改写必然失败
  const direct = await run('git', ['ls-remote', orig])
  assert.notEqual(direct.code, 0, '未改写时 orig 应不可访问')

  // 同一组环境变量形状：把 orig 改写到 mapped
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${mapped}.insteadOf`,
    GIT_CONFIG_VALUE_0: orig,
    GIT_TERMINAL_PROMPT: '0',
  }
  const rewritten = await run('git', ['ls-remote', orig], { env })
  assert.equal(rewritten.code, 0, `改写后应成功：${rewritten.stderr}`)
  assert.ok(rewritten.stdout.includes('refs/heads/main'), '应看到 main 分支')

  fs.rmSync(tmp, { recursive: true, force: true })
})
