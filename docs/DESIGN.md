# dsh-sync — 设计说明

自研的 DSH 多机同步插件。目标是**会话、工作区、插件清单、设置层**四类数据在
多台机器间保持一致，并且**真的能合并**（不是整份覆盖），传输走私有 Git 仓库
（GitHub 为主，SSH 或 Token 皆可）。

## 1. 为什么不直接用现成插件

调研过 npm 上十余个同类插件（见 `../docs/调研.md`，或本次会话记录），结论：

| 类型 | 代表 | 缺口 |
|---|---|---|
| 会话同步 | `dsh-session-sync` | 只做会话；冲突策略是「两侧都留一份 fork 文件」——不丢，但会堆积 |
| 全量同步 | `@weibaohui/dsh-sync` | 分支→PR→AI 解冲突确实强，但**PR/合并/AI 只在 GitCode 可用**，GitHub 退化为只推分支 |
| 配置同步 | `dsh-config-manager` | 覆盖最全、密钥可加密，但属「快照式」：整体导入导出，不做逐条合并 |
| 一键同步 | `@dpskk2/dsh-chatsync` | 体验最好（GitHub 私库 + 设置页），但快照式，两台都改过同一会话会丢一侧 |

所以自研的差异点只有两个，且都在**合并**上：

1. **会话做行级并集**（利用「多帧 zstd 追加」这个结构，见下）；
2. **每类数据用各自合适的合并语义**（不是一把梭），并把冲突显式暴露。

## 2. 关键实测：会话文件是多帧 zstd 追加日志

对 `~/.dsh/sessions/<ws>/<session>/session.v4.jsonl.zstd` 的实测（2026-10-22）：

- 最大一个文件 8.7 MB，`zstdDecompressSync` 整份解只得到 **1 行**（只有 session 头）；
- 按 zstd magic（`28 B5 2F FD`）切分后共 **3550 个帧**，逐帧解码 **0 失败**，合计 **5973 行** JSONL。

结论：文件 = 一串独立帧的顺序拼接，DSH 每次追加就把新事件压成一帧接到末尾。
于是合并可以做成**无损并集**：

```
公共前缀（逐字节一致的帧/行）
  + 本地尾段
  + 远端独有尾段（按整行去重）
  → 重新按 256 行/帧压缩写回
```

一侧是另一侧前缀时走快速路径：**直接采用较长那份的原始字节**，零重编码风险。

> 这比"保留两份 fork 文件"进了一步：既不丢事件，也不会让仓库里堆满分叉副本。

## 3. 各类数据的合并语义

| 数据 | 位置 | 合并方式 | 冲突处理 |
|---|---|---|---|
| 会话 | `sessions/<ws>/<sid>/session.v4.jsonl.zstd` | 行级并集（前缀 + 两侧尾段） | 无冲突概念；帧解不开则保留本地并告警 |
| 工作区 | `storages/workspace.json` | `tables.workspaces` 按 id 并集；`sessionIds`/归档/置顶并集；同 id 取 `updatedAt` 较新者 | 同一工作区两种 `path` → 报 `pathConflicts`，**不自动改 path** |
| 仓库工作区 | `dsh-github-workspaces.json` | `repos` 对象按键合并 | 保留本地设置（镜像/代理等机器相关项） |
| 插件清单 | `profiles/<p>/package.json` | `dependencies` 并集 + 版本仲裁（取更高版本）；`dsh.profile.bundles` 并集 | 版本差写进 `versionConflicts`；`link:`/`file:` 依赖标为「仅本机」，不下发 |
| 锁文件 | `pnpm-lock.yaml` | 不做文本合并，跟随本地（与本地清单配套） | 本地缺失才取远端 |
| 设置层 | `profiles/<p>/cordis.patch.yml` | **三路行合并**（base = 上次同步留存，local，remote） | 同一处都改 → 保留本地 + 另存 `.remote-<时间戳>` |

### 三路合并的基线从哪来
`~/.dsh/dsh-sync/base/<rel>`：每次写入镜像后把该版本存为下一次的 base。
没有 base（首次同步）时保守地取本地，并把远端另存一份。

## 4. 安全模型

- **公共仓库一律拒绝**：配置了 token 时先用 GitHub API 判定 `private`，`public` 直接 400。
- **凭据永不同步**：`.credentials.yaml` / `credentials.yaml` 写进 `neverSync`（代码里硬约束，不靠配置）。
- **token 不进 argv**：用 `GIT_CONFIG_*` 环境变量注入 `url.<带凭据>.insteadOf`，由 git 自己改写 URL；
  `GIT_TERMINAL_PROMPT=0` 保证无人值守时不挂起。
- **写入前备份**：所有将被覆盖的本地文件先复制到 `~/.dsh/dsh-sync/backup/<时间戳>-<label>/`。
- **只监听本机**：所有 HTTP 端点过 loopback 门禁（LAN 暴露的 `dsh web` 不可用）。
- **工具只读**：agent 只能 `status` / `plan`；`sync`（拉取+合并+推送）只能在面板里点击。

## 5. 目录与文件

```
~/.dsh/dsh-sync.json            # 设置（0600）
~/.dsh/dsh-sync/repo/           # 镜像仓库（git worktree，结构见下）
~/.dsh/dsh-sync/backup/         # 写回前备份
~/.dsh/dsh-sync/base/           # 三路合并基线
```

镜像仓库布局：

```
meta.json                                   # schemaVersion / instanceId / updatedAt
sessions/<ws>/<sid>/session.v4.jsonl.zstd
workspace/workspace.json
workspace/github-workspaces.json
plugins/<profile>/package.json
plugins/<profile>/cordis.patch.yml
plugins/<profile>/pnpm-lock.yaml
```

## 6. 代码结构

| 文件 | 职责 |
|---|---|
| `index.js` | Cordis 入口：注册路由、`dsh_sync` 工具、systemPrompt 段落 |
| `lib/config.js` | 路径、设置读写（0600）、实例 id |
| `lib/proc.js` | 子进程 + git 环境（token 注入、超时、输出脱敏） |
| `lib/sessions.js` | 帧切分/解码/编码、行级并集、会话目录扫描 |
| `lib/datasets.js` | 工作区/插件清单合并、版本仲裁、三路文本合并 |
| `lib/merge.js` | 收集本地与镜像、生成计划、执行计划（含备份） |
| `lib/repo.js` | 镜像初始化、fetch/ff/rebase、私库校验、提交推送、原子写 |
| `lib/routes.js` | `/api/dsh-sync/*`（state/settings/probe/plan/sync/status） |
| `lib/tools.js` | `dsh_sync`（status/plan，只读） |
| `client.js` | Web 面板：状态、设置、检测、预演、同步 |

## 7. 已验证

五套测试，全部可离线复跑（`node test/*.mjs`）：

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `merge.test.mjs`（17 项） | 帧往返 / 脏 magic / 并集·快进·分叉·fork、工作区键合并与路径冲突、版本仲裁与本地 link、三路合并 | 全绿 |
| `audit.test.mjs`（10 项） | 非法 JSON、损坏帧、超大会话、空计划、大文件降级、路径守卫、token 语义、内嵌凭据、并发 | 全绿 |
| `smoke-real.mjs` | 本机真实 38 个会话（含 8.7MB / 3550 帧那个） | 计划 0 项；远端加一帧后恰好 1 项 pull，合并后 5974 行 |
| `e2e-local.mjs` | 本地裸仓库冒充 GitHub，两台机器往返 | 两侧收敛、git 干净 |
| `routes-http.mjs`（9 断言） | 真 http.Server 挂 6 条路由 | 全绿（含 405 / 400 / 掩码不落盘） |

真实宿主验证：装进 `web` profile 起实例到 :8899 → `GET /api/dsh-sync/state` 返回 200
（读到真实会话/插件/git 版本），Web GUI 侧边栏出现「多机同步」面板并正常渲染。

## 10. 自查记录（2026-10-23，对抗性复查）

不是"看代码像不像对"，而是逐条问「什么输入会让它出错」。查出并修掉 **8 个真问题**：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `keep-local` 决策仍把本地字节写进镜像 | **损坏的会话会覆盖远端**（丢另一台机器的事件） | keep-local 时 `buffer=null` 且不写镜像，另加告警 |
| 2 | `planSync` 里 5 处 `JSON.parse` 未防护 | 任一侧 JSON 损坏 → 路由 500，且可能覆盖好文件 | 统一走 `parseJson`，失败则跳过并记 `warnings` |
| 3 | `sessions.maxPerFileMB` 是死配置 | 超大会话一次性全量解帧，内存可爆 | 超限直接跳过合并并告警 |
| 4 | **"本地领先"被当成"一致"** | 本机新增的会话事件永远推不上去 | `local-ahead` → push 决策 |
| 5 | 两侧内容相同但格式不同仍重写 | 每次同步都产生无意义提交 | 改为 `canonicalJson` 语义比较 + `writeRepo/writeLocal` 精确标记 |
| 6 | `mergeWorkspace` 会凭空造键（`initialized` 等） | 同样造成"没变化也判为变化" | 只处理至少一侧存在的键（形状保持） |
| 7 | 三路合并 LCS 是 O(n·m) | 上万行 YAML 会吃掉数百 MB | 超 4000 行降级「保留本地 + 另存远端」 |
| 8 | 拉取失败返回 409 | 与"并发互斥"语义混淆，面板无法区分 | 改为 502；409 只留给并发 |

顺带加固：
- 帧完整性校验（非空、以 `\n` 结尾、每行合法 JSON）——真实 3550 帧零误报；
- `/sync` 进程内互斥（并发实测 `200/409/409`，镜像保持干净且已推送）；
- 黑名单按**路径段**判定（避免 `--D-code-cache--` 被误杀），命中即抛；
- token 支持 `clearToken` 显式清空（空串/掩码仍表示不变）；
- 远端地址内嵌凭据（`https://user:token@…`）检测 + 脱敏告警。

## 8. 路线图

- **v0.2**：面板增加"分叉会话逐条对照"；`cordis.patch.yml` 冲突一键解析（本地/远端/二者合并）；
  提交前展示 `git diff --stat`。
- **v0.3**：把「按时间戳交错」作为可选会话合并策略（当前是本地尾段在前）；
  技能（skills）与 Agent 预设加入同步面。
- **v0.4**：可选加密（scrypt + AES-256-GCM）承载 `.credentials.yaml`，默认关闭。

## 9. 已知限制

- 会话是**压缩二进制**，git 侧无法做行级 diff/merge；冲突检测完全靠本插件的解帧逻辑，
  所以**不要用 `git merge` 手工处理 `sessions/**`**。
- 帧末尾的**垃圾字节**会被 zstd 忽略：解码成功、但重新编码时这些字节不会保留。
  它们对 DSH 本身也是不可读的，因此按"无意义残留"处理。
- `pnpm-lock.yaml` 不做合并（合并后的锁文件几乎必然损坏），以本地为准。
- 工作区 `path` 跨机不同只报告不修改——自动改路径的风险远大于收益。
- 路径过深时（`~/.dsh/dsh-sync/repo/sessions/<slug>/<sid>/…`）可能触及 Windows 260 字符限制，
  会话 slug 很长时需要开启长路径支持。
- 面板的同步动作会写真实数据，首次使用建议先「预演」并确认备份目录已生成。
