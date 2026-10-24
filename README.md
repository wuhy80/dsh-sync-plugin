# dsh-sync

DSH 多机同步插件：**会话 / 工作区 / 插件清单 / 设置层**走私有 Git 仓库，
按数据类型分别合并（会话行级并集、工作区键合并、插件集合合并 + 版本仲裁、
设置层三路合并），凭据文件永不入库。

> 设计细节与实测依据见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

**插件跟 profile 无关**：desktop / web / tui / headless 都能装，插件自己会检测当前跑在哪个
profile 里（见下方「profile」）。区别只在安装方式：

```powershell
# web / tui / headless：CLI 可以管
dsh plugin --profile web add git+https://github.com/wuhy80/dsh-sync-plugin.git

# 开发态：装成链接包，改完代码跑 scripts/reload.mjs 即可热重载（不用重启）
dsh plugin --profile web add link:D:\code\dsh-sync
```

```text
# desktop：由 Electron 应用托管，`dsh plugin --profile desktop …` 会被 CLI 直接拒绝
#   error: profile "desktop" is managed exclusively by the Electron application
# 正确做法二选一：
#   1) 在应用内的插件管理面板里安装（推荐，它自己会登记 bundle）；
#   2) 手工两步（等价于一次 plugin add）：
#        a. 在 ~/.dsh/profiles/desktop 里 pnpm add "git+https://github.com/wuhy80/dsh-sync-plugin.git"
#        b. 把 "@local/dsh-sync" 追加进 profiles/desktop/package.json 的 dsh.profile.bundles
```

> 光有依赖不会被加载：DSH 的加载器是按 `dsh.profile.bundles` 顺序叠加每个 bundle 的 patch 的。

装完**重启 DSH**（首次安装需要），侧边栏出现「多机同步」图标。

## 第一次使用

1. 在 GitHub 建一个**私有**仓库（例如 `dsh-sync`），不要用公共仓库——插件会拒绝。
2. 打开「多机同步」面板，填：
   - **远程仓库**：`git@github.com:<你>/dsh-sync.git`（推荐，SSH 免 token）
     或 `https://github.com/<你>/dsh-sync.git`（需填 token）
   - **分支**：`main`
   - **profile**：**留空 = 自动检测**（默认）。只有想同步「另一个 profile 的插件清单」时才需要手填。
   - **访问令牌**：仅 HTTPS 需要；只写入 `~/.dsh/dsh-sync.json`（0600），不会进 argv、不会进仓库
3. 点 **检测**：确认 git 可用、仓库可见性为 `private`。
4. 点 **预演**：看要改哪些文件（这一步不写盘）。
5. 点 **立即同步**：拉取 → 合并 → 提交 → 推送。写回本地前会备份到
   `~/.dsh/dsh-sync/backup/<时间戳>-pre-apply/`。

另一台机器重复 1–5 即可。首次同步不是「以谁为准」，而是按数据类型做并集合并——
两边都已经有内容时怎么合，见下一节。

> 两台机器跑**不同 profile**（一台 desktop、一台 web）时，插件清单会分别存在
> `plugins/desktop/` 和 `plugins/web/` 下，各自独立、不会互相覆盖——面板会显示
> 「远端用的是 xxx」提示。这是有意为之：desktop 和 web 的插件集本来就不同。

### 两边都已经攒了很多内容时（首次同步）

能直接连，**不会二选一覆盖**。首次同步（本机还没有 `state.json`）的语义是「并集」：

| 数据 | 首次同步会发生什么 |
|---|---|
| 会话 | 按 `<工作区>/<会话id>` 并集；两侧同 id 都写过 → **行级并集**，两边新增的事件都保留 |
| 删除 | **首次同步不删任何东西**（墓碑从第二次同步开始生效） |
| 工作区 | 按 id 键合并，`sessionIds` 取并集；同 id 不同路径只报告 |
| 插件清单 | 依赖并集 + 版本取高；`link:`/`file:` 标为本机、不下发 |
| 设置层 | 没有 base 时先看**包含关系**：一方是另一方的子集 → 直接采用超集（纯增量，零冲突）；真分叉才保留本地 + 远端另存 `.remote-<时间戳>` |

所有写回都会先进备份目录（`~/.dsh/dsh-sync/backup/<时间戳>-pre-apply/`），
面板在首次同步时会明说一句「按并集合并、不会覆盖」。

建议流程还是**先点「预演」**：它会列出每一类会写哪些文件、有多少冲突，这一步不写盘。

几个会看到的现象（都是预期的）：

- 合并进来的工作区可能指向**另一台机器上的路径**——面板会提示「N 个工作区指向本机不存在的路径」。
- 设置层真分叉时，本地保留、远端整份另存为 `cordis.patch.yml.remote-<时间戳>`，
  面板会显示冲突数。
- 超大会话（默认 >64MB）跳过合并并在面板告警，不会悄悄丢掉。

## 同步什么、怎么合并

| 数据 | 来源 | 合并 |
|---|---|---|
| 会话 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 解帧后行级并集（一侧是另一侧前缀时直接采信较长那份） |
| 删除 | 墓碑 `sessions/_tombstones.json` | 删掉的会话同步删除远端/其它机器那份（删前备份）；删除之后又写过则以写入为准（复活） |
| 工作区 | `~/.dsh/storages/workspace.json` | 按 id 键合并，`sessionIds` 取并集，同 id 取 `updatedAt` 较新者 |
| 仓库工作区 | `~/.dsh/dsh-github-workspaces.json` | `repos` 按键合并 |
| 插件清单 | `profiles/<profile>/package.json` | 依赖并集 + 版本取高；`link:`/`file:` 标记为仅本机 |
| 设置层 | `profiles/<profile>/cordis.patch.yml` | 三路行合并，冲突保留本地并另存 `.remote-<时间戳>` |

同一个会话在两台机器上落在**不同的工作区目录**（工程路径不同 → slug 不同）时，会按 session id
把两侧内容合并后分别写回各自目录，并在面板提示「建议两端使用相同工程路径」。

**不同步**：`.credentials.yaml`（硬约束）、`node_modules`、`cache`、`runtimes`、`attachments`、机器本地的统计类数据。

## 安全

> **分工明确：插件公开、数据私有。** 插件源码里没有任何凭据（测试 fixture 全是 `FAKE_*`）；
> 被同步的会话/工作区/插件清单只进你**自己的私有**仓库。

- **公共仓库一律拒绝**：有 token 时带 Bearer 校验；**没有 token 时也会做一次匿名探测**
  （公共库匿名可读 → 判 `public` → 拒绝同步），所以 SSH 远端同样拦得住。
- token 通过 `GIT_CONFIG_*` 环境变量注入，不进命令行参数；
  面板没填时自动复用 DSH 凭据中心里已登录的 GitHub token。
- `.credentials.yaml` / `node_modules` / `cache` / `runtimes` 永不入库（代码守卫 + `.gitignore` 兜底）。
- 所有 HTTP 端点只允许本机回环访问。
- agent 工具只有 `status` / `plan`（只读）；真正的同步由你在面板点击。

## agent 工具

```
dsh_sync(action: "status")   # 两侧数量 + git 领先/落后
dsh_sync(action: "plan")     # 预演：会改动哪些文件（不写盘）
```

## 开发

### 热重载（改完代码不重启 DSH）

DSH 内置 `@deepseek-ai/dsh-hmr`：它监听 profile 的 patch 文件，patch 一变就做一次
「profile 重组」，并把**链接包**（`link:` 装的插件，含软链目标）里磁盘上变过的文件
对应的插件重新挂载 —— 所以插件装成链接包后，改完代码跑一次下面这条就生效（约 1.5~3 秒）：

```powershell
node scripts/reload.mjs            # 默认 desktop profile
node scripts/reload.mjs --wait     # 等挂载日志出现新记录再退出
```

面板那半（`client.js`）是浏览器模块，服务端重载后还要 `Ctrl+R` 刷新页面。
HMR 只替换「文件真的变了」的插件——源码没动时不会重新挂载，这是正常的。

```powershell
node --test test/merge.test.mjs     # 合并核心单测（17 项）
node test/audit.test.mjs            # 对抗性自查（14 项：损坏/超大/长路径/并发/锁/公共库…）
node --test test/private-check.test.mjs   # 私库判定：匿名探测公共库 / 凭据兜底（10 项）
node test/smoke-real.mjs            # 本机真实数据只读冒烟
node test/e2e-local.mjs             # 本地裸仓库双机往返
node test/routes-http.mjs           # 路由层 HTTP（真 server）
node --test test/env-injection.test.mjs   # HTTPS+token 的凭据注入机制
node --test test/client-slots.test.mjs    # 面板插槽注册（不用开 GUI）
node test/e2e-github.mjs            # 真实 GitHub 往返（默认跳过，见下）
```

> `e2e-github.mjs` 会**写真实仓库**，所以需要两个开关，并且会拒绝在**已有会话数据**的仓库上运行
> （防止把正在用的数据仓库清空）：
>
> ```powershell
> $env:DSH_SYNC_TEST_REMOTE="git@github.com:you/dsh-sync-smoke.git"   # 必须是**一次性**仓库
> $env:DSH_SYNC_TEST_ALLOW_WRITE="1"
> node test/e2e-github.mjs
> ```

## 已知限制

- 会话是压缩二进制，**不要**用 `git merge` 手工处理 `sessions/**`（冲突检测靠插件的解帧逻辑）。
- `pnpm-lock.yaml` 不合并，以本地为准。
- 工作区路径跨机不一致时只报告、不自动修改。
- 删除靠墓碑传播：**第一次同步之后**才记录「本机有哪些会话」，所以在这一版插件第一次同步之前
  删掉的会话，仍可能被远端拉回来一次。
- 取消归档仍是并集语义（只同步 `archived` 标记，不做删除）。
