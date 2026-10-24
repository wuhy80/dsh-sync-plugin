# dsh-sync

DSH 多机同步插件：**会话 / 工作区 / 插件清单 / 设置层**走私有 Git 仓库，
按数据类型分别合并（会话行级并集、工作区键合并、插件集合合并 + 版本仲裁、
设置层三路合并），凭据文件永不入库。

> 设计细节与实测依据见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

```powershell
# 从本地目录安装（开发态）
dsh plugin --profile desktop add file:D:\code\dsh-sync

# 或先本地链接，改代码后重启即生效
dsh plugin --profile desktop add link:D:\code\dsh-sync
```

装完**重启 DSH**，侧边栏出现「多机同步」图标。

## 第一次使用

1. 在 GitHub 建一个**私有**仓库（例如 `dsh-sync`），不要用公共仓库——插件会拒绝。
2. 打开「多机同步」面板，填：
   - **远程仓库**：`git@github.com:<你>/dsh-sync.git`（推荐，SSH 免 token）
     或 `https://github.com/<你>/dsh-sync.git`（需填 token）
   - **分支**：`main`
   - **访问令牌**：仅 HTTPS 需要；只写入 `~/.dsh/dsh-sync.json`（0600），不会进 argv、不会进仓库
3. 点 **检测**：确认 git 可用、仓库可见性为 `private`。
4. 点 **预演**：看要改哪些文件（这一步不写盘）。
5. 点 **立即同步**：拉取 → 合并 → 提交 → 推送。写回本地前会备份到
   `~/.dsh/dsh-sync/backup/<时间戳>-pre-apply/`。

另一台机器重复 1–5 即可；首次同步会以本机为准建立基线。

## 同步什么、怎么合并

| 数据 | 来源 | 合并 |
|---|---|---|
| 会话 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 解帧后行级并集（一侧是另一侧前缀时直接采信较长那份） |
| 工作区 | `~/.dsh/storages/workspace.json` | 按 id 键合并，`sessionIds` 取并集，同 id 取 `updatedAt` 较新者 |
| 仓库工作区 | `~/.dsh/dsh-github-workspaces.json` | `repos` 按键合并 |
| 插件清单 | `profiles/<profile>/package.json` | 依赖并集 + 版本取高；`link:`/`file:` 标记为仅本机 |
| 设置层 | `profiles/<profile>/cordis.patch.yml` | 三路行合并，冲突保留本地并另存 `.remote-<时间戳>` |

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
