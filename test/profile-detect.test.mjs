/**
 * profile 自动检测的回归测试。
 *
 * 背景：desktop profile 由 Electron 托管，`dsh plugin --profile desktop …` 会被 CLI 直接拒绝
 * （rejectElectronProfile）。插件不能把 desktop 写死成默认值，否则在 web / tui 上就用不了。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detectProfile } from '../lib/config.js'

// 测试环境的进程本身就是由 DSH 拉起的，继承着 DSH_PROFILE=desktop 之类的变量；
// 这些用例要验证的是「没有环境变量时」的自动检测，所以先把它们摘掉。
const INHERITED = ['DSH_PROFILE', 'DSH_PROFILE_NAME', 'DSH_PROFILE_DIR']
const saved = new Map(INHERITED.map((key) => [key, process.env[key]]))
for (const key of INHERITED) delete process.env[key]
test.after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 造一个假 DSH_HOME：profiles/<name>/… */
function fakeHome(profiles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  for (const [name, spec] of Object.entries(profiles)) {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    if (spec.dep === true) {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, dependencies: { '@local/dsh-sync': 'git+https://example/repo.git' } }),
      )
    } else {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, dependencies: {} }))
    }
    if (spec.registered === true) {
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: dsh-sync\n      name: "@local/dsh-sync"\n')
    }
  }
  return home
}

/** 临时改环境变量，返回恢复函数。 */
function withEnv(key, value) {
  const before = process.env[key]
  process.env[key] = value
  return () => {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
}

test('只有 web 装了本插件 → 检测出 web（不再硬编码 desktop）', () => {
  const home = fakeHome({ web: { dep: true, registered: true } })
  assert.equal(detectProfile(home), 'web')
})

test('desktop 和 web 都有依赖，但只有 web 在 patch 里登记 → web', () => {
  const home = fakeHome({ desktop: { dep: true }, web: { dep: true, registered: true } })
  assert.equal(detectProfile(home), 'web')
})

test('两个 profile 都装了且都登记 → 保守回退 desktop', () => {
  const home = fakeHome({ desktop: { dep: true, registered: true }, web: { dep: true, registered: true } })
  assert.equal(detectProfile(home), 'desktop')
})

test('没有任何 profile 装过 → 回退 desktop', () => {
  const home = fakeHome({ desktop: { dep: false }, web: { dep: false } })
  assert.equal(detectProfile(home), 'desktop')
})

test('$DSH_HOME 下没有 profiles 目录 → 回退 desktop', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-empty-'))
  assert.equal(detectProfile(home), 'desktop')
})

test('环境变量 DSH_PROFILE 优先', () => {
  const home = fakeHome({ web: { dep: true, registered: true } })
  const restore = withEnv('DSH_PROFILE', 'web')
  try {
    assert.equal(detectProfile(home), 'web')
  } finally {
    restore()
  }
})

test('环境变量指向不存在的 profile 时忽略，继续自动检测', () => {
  const home = fakeHome({ web: { dep: true, registered: true } })
  const restore = withEnv('DSH_PROFILE', 'nope')
  try {
    assert.equal(detectProfile(home), 'web')
  } finally {
    restore()
  }
})

test('DSH_PROFILE_DIR 的 basename 也能判定（launcher 注入的形态）', () => {
  const home = fakeHome({ desktop: { dep: true }, web: { dep: true } })
  const restore = withEnv('DSH_PROFILE_DIR', path.join(home, 'profiles', 'web'))
  try {
    assert.equal(detectProfile(home), 'web')
  } finally {
    restore()
  }
})
