/**
 * 浏览器半边（client.js）的插槽注册测试（B3）。
 *
 * client.js 顶层调用 `window.__ModuleLoader__.load({id, factory})`；
 * 用一个最小 React 桩把 factory 跑起来，再用假 ctx 验证：
 *   - 模块 id 正确；
 *   - `sidebar.panellist` 与 `main` 两个槽都注册了，且 key/id 一致（壳层据此切换面板）。
 * 这类错误以前只能靠肉眼点开 GUI 才能发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

let captured = null

// 最小 React 桩：只提供 client.js 用到的 API
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (initial) => [initial, () => {}],
  useRef: (value) => ({ current: value }),
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import('../client.js')

test('模块声明：id 与插件包一致', () => {
  assert.ok(captured, '__ModuleLoader__.load 应被调用')
  assert.equal(captured.id, '@local/dsh-sync')
  assert.equal(typeof captured.factory, 'function')
})

test('factory 只依赖 react，且返回 { inject, apply }', () => {
  const mod = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`意外的依赖：${name}`)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
})

test('apply 注册 sidebar.panellist 与 main，且 key 与 id 一致', () => {
  const mod = captured.factory(() => ReactStub)
  const events = []
  const disposers = []

  const ctx = {
    slots: {
      inject(name, register) {
        events.push(`inject:${name}`)
        const dispose = register()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
      register(meta, component) {
        assert.equal(typeof component, 'function', `${meta.name} 应挂载组件函数`)
        events.push(`register:${meta.name}:${meta.id ?? meta.key}`)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }

  mod.apply(ctx)

  assert.deepEqual(events, [
    'inject:sidebar.panellist',
    'register:sidebar.panellist:dsh-sync',
    'inject:main',
    'register:main:dsh-sync',
  ])
  // 侧边栏图标与主面板必须用同一个 key，否则点了图标切不到面板
  const [, icon, , panel] = events
  assert.equal(icon.split(':').pop(), panel.split(':').pop(), 'id 与 key 必须一致')
  assert.ok(disposers.length > 0, '应注册释放函数')
})

test('插槽注册失败时 apply 不抛（不能把壳层启动带崩）', () => {
  const mod = captured.factory(() => ReactStub)
  const ctx = {
    slots: {
      inject() {
        throw new Error('壳层没有这个座位')
      },
      register() {
        throw new Error('不该走到这里')
      },
    },
    effect() {},
  }
  assert.doesNotThrow(() => mod.apply(ctx))
})
