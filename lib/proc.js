/**
 * 子进程：只用 node:child_process，不引依赖。
 *
 * 凭据处理是这一层的重点：
 * - token **绝不进 argv**（`ps` 全机可见），改用 `GIT_CONFIG_*` 环境变量注入
 *   `url.<带凭据>.insteadOf=https://github.com/`，由 git 自己改写 URL；
 * - `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never`：无人值守时不挂起；
 * - 需要凭证的操作用 SSH 远端也可（此时 token 留空，交给 ssh-agent）。
 */

import { spawn } from 'node:child_process'

/** 默认超时（git 拉取大仓库可能慢，给 10 分钟）。 */
const DEFAULT_TIMEOUT = 10 * 60 * 1000

/** 执行一个命令，返回 { code, stdout, stderr, timedOut }。 */
export function run(command, args, options = {}) {
  const {
    cwd,
    env,
    timeout = DEFAULT_TIMEOUT,
    input,
  } = options

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, timeout)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })

    if (input !== undefined) {
      try {
        child.stdin?.end(input)
      } catch {
        /* 忽略 */
      }
    } else {
      child.stdin?.end()
    }
  })
}

/** git 可执行文件是否可用。 */
export async function hasGit() {
  const r = await run('git', ['--version'], { timeout: 15000 })
  return r.code === 0 ? r.stdout.trim() : null
}

/**
 * 构造 git 环境变量。
 * @param {{ token?: string, remote?: string }} creds
 */
export function gitEnv(creds = {}) {
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo',
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '30',
  }
  const { token, remote = '' } = creds
  // 仅对 https://github.com/ 形态注入；SSH 远端靠 ssh-agent，token 留空即可
  if (token && /^https:\/\/github\.com\//i.test(remote)) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'url.https://x-access-token:' + token + '@github.com/.insteadOf'
    env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
  }
  return env
}

/**
 * 在指定目录跑 git。
 * @param {string[]} args
 * @param {{ cwd?: string, token?: string, remote?: string, timeout?: number, input?: string }} options
 */
export async function git(args, options = {}) {
  const { cwd, token, remote, timeout, input } = options
  const full = cwd ? ['-C', cwd, ...args] : args
  return run('git', full, { env: gitEnv({ token, remote }), timeout, input })
}

/** 把敏感串（token）从输出里抹掉，便于回显日志。 */
export function scrub(text, secrets = []) {
  let out = String(text ?? '')
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***')
  }
  return out
}

/** 输出压成一行（面板/日志用）。 */
export function oneLine(text, max = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
