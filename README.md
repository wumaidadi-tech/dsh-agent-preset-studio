# Agent 预设工作室 · Agent Preset Studio

`@local/dsh-agent-preset-studio` —— 一个 DeepSeek Harness 插件。

查看**全部工具**（已挂 + 可挂未挂）、勾选要挂哪些、编辑**系统提示词**并实时估算 token，
最后导出一份可安装的预设包并直接装进 profile。

> 🤖 *本项目全部由 AI 生成 · 详见文末[关于本项目](#关于本项目)*

---

## 为什么是这个形态

官方预设注册表（`dsh-agent-preset-registry`）**只提供 `list` / `read` / `select`，
没有任何 YAML 写回接口**。所以「手动创建预设」这件事在 DSH 里唯一合法的落地方式就是：

> 生成一个 bundle patch → 交给 `pluginManager.installBundle(绝对路径)` 安装

插件就是把这个流程做成图形界面。写文件永远发生在工作区，profile 的
`package.json` / `cordis.patch.yml` 从不由本插件直接改。

---

## 三个界面

### 1. 工具（Tools）
两张按真实来源分开列的表：

| 分区 | 来源 | 键 |
|---|---|---|
| **当前已挂工具** | `ctx.get('tools')` 逐层遍历运行时注册表 | 工具名 |
| **可挂未挂工具** | 扫描 `app.asar` 的 `node_modules/@deepseek-ai/dsh-tool-*` 目录 | 包名 |

- 每行显示工具名 / 包名、它ship的工具、以及 **prefix token 估算**（触发函数定义的大小）。
- 勾选框 = 「这个预设要挂它」。
- 顶部有过滤框、全选 / 全不选，右侧实时汇总已选数量与 token 合计。
- 两张表键不同，所以导出时会把**工具名经目录反查回包名** —— 否则勾选会静默丢失。

### 2. 系统提示词（System prompt）
- 纯文本编辑器，直接对应 persona 行的 **`prefix`** 字段。
- 可以「从已有预设载入」当底稿（读出该预设的人设正文，并标明来源）。
- 实时显示字符数与 token 估算（**与宿主同一规则：4 字符 ≈ 1 token**；
  中文实际约为此值的 1.5 倍，界面已注明）。

### 3. 导出（Export）
填预设 id / 显示名 / 描述 / 排序 / 输出目录，点「生成并安装」后：
1. 在工作区写出一个带 `dsh.bundle.patch` 的完整插件目录；
2. 调 `pluginManager.installBundle()` 装进 profile；
3. 界面回显安装结果，并**并排展示生成的 `cordis.patch.yml` 全文**。

### 右侧栏面板
轻量只读面板：已挂工具行数、人设 token、可用预设数，加一个「打开工作室」入口。

---

## 安装

本机没有独立的 node / pnpm 可执行文件，profile 的 pnpm 要用 Electron 当 Node 跑。
下面命令里的 `<DSH 根目录>` 换成**你的** DeepSeek Harness 安装目录
（Windows 默认通常是 `C:/Users/<用户名>/AppData/Local/Programs/` 下的安装位置；
例子里用的是 `E:/deepseek`）：

```bash
cd ~/.dsh/profiles/desktop
ELECTRON_RUN_AS_NODE=1 "<DSH 根目录>/DeepSeek Harness.exe" \
  "<DSH 根目录>/resources/runtime/pnpm/bin/pnpm.cjs" add <本插件clone到的目录>
```

例（DSH 装在 `E:/deepseek`、插件 clone 到 `E:/deepseek/agent-preset-studio` 时）：

```bash
cd ~/.dsh/profiles/desktop
ELECTRON_RUN_AS_NODE=1 "E:/deepseek/DeepSeek Harness.exe" \
  "E:/deepseek/resources/runtime/pnpm/bin/pnpm.cjs" add "E:/deepseek/agent-preset-studio"
```

然后**手动**往 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加一行：

```json
"@local/dsh-agent-preset-studio"
```

> pnpm 只负责写 `dependencies`；某一个包要不被加载，由 `bundles` 列表决定。
> 两处都写了才会生效。

**重启 DSH 生效**（新增 bundle 需要重新走一遍加载链）。

---

## 验证

```bash
node test-host.mjs      # 宿主半全链路（真实 asar 扫描、patch 生成、超时降级、asar 拦截）
node test-client.mjs    # 客户端结构（字典对称、t() 键覆盖、内联字典、abort 兜底、空白页守卫）
node test-install.mjs   # 安装预检（manifest / 链接 / 双端可加载性；未安装时自动跳过）
```

三套都通过才算健康。

> **注意**：`test-host.mjs` 会真的去扫本机的 `app.asar`，所以它需要跑在一台
> **装着 DeepSeek Harness 的机器**上。在没有 DSH 的环境里，依赖安装的
> catalogue / export 测试节会明确说明并跳过（前面的纯逻辑测试照常完整运行）；
> `test-install.mjs` 在 profile 里没装本插件时同样自动跳过。

在装了 DSH 的机器上，`test-host.mjs` 同时能告诉你当前识别到多少工具包
（当前开发机实测：22 包 / 35 个工具名）。

---

## 排查入口

| 路由 | 用途 |
|---|---|
| `GET /api/agent-preset-studio/ping` | 只回 `{pong:true}`。**能通**说明宿主半已挂载且路由可达 |
| `GET /api/agent-preset-studio/snapshot` | 界面主数据 |
| `GET /api/agent-preset-studio/diagnostics` | ★ **「可挂未挂」分区空掉时先看这个** |

`ping` 通了而 `snapshot` 不通 → 传输没问题，故障在某个 snapshot 步骤内部；
两个都不通 → 插件压根没挂载。这条区分把问题从「猜」变成「一次请求定位」。

`diagnostics` 会报告：当前是不是 Electron、`app.asar` 路径与是否存在、
**逐个方式试开归档的结果**（普通 fs / 尾斜杠别名 / `original-fs`）、
最终选了哪条路、以及索引出多少个文件条目。

---

## 三个不显眼但要命的约束

### 1. ⚠️ 路由 handler 是 `node:http` 契约，不是 Fetch

```js
handler: async (req, res) => { res.writeHead(...); res.end(...); }   // ✅
handler: (request) => json({ ok: true })                              // ❌ 永久挂住
```

返回 `Response` 而不写 `res`，服务器**永远不调用 `res.end()`**：
浏览器一直转圈、`curl` 挂到超时、**服务端一行日志都没有**。
这就是「一直扫描中 / The host did not answer snapshot」的真凶。

`lib/index.js` 里的 `serve()` 适配器就是干这个的：
内部照旧用 Fetch 风格的 `Response`（好写、好测），注册时适配一次。
`test-host.mjs` 里有一整节逐路由断言 `res.end()` 真的被调用了。

### 2. 任何 await 都不能无限等
预设注册表的 `list()` 会逐个 await 每个定义的**激活诊断**，
而「等待 Host 服务的行」不会 settle。直接 `await` 它 = 请求永不返回 = 界面永远停在「扫描中」。
所以：**名单读取是有上限的（2.5s），超时降级为「读不到名单 + 说明原因」**，
工具清单照常返回。整条路由另有 4s 兜底，客户端侧再用 `AbortController` 上一道。

原则：**可选的数据增强永远不能成为响应的前置条件。**

### 3. 两份清单的键不一样
- **已挂**清单按**工具名**键（来自 `ctx.tools.schemas()`，注册表自己的公开投影）
- **可挂**清单按**包名**键（静态扫 asar 目录）

预设只能声明**包名**，所以导出时必须把工具名经目录反查回包名 —— 否则用户勾了却没生效。
界面上勾选、回填、导出三处都按各自的键处理。

### 4. ⚠️ Electron 会拦截 `openSync('.../app.asar')`（只在运行时炸）

`fs.openSync('<DSH 安装目录>/resources/app.asar')`（下例用了开发机的路径 `E:/deepseek`）
**在纯 Node 里成功（121,348,951 字节），在 Electron 主进程里报 ENOENT。**

原因：Electron patch 过 fs，把路径里出现 `.asar` 的那一段当成**目录**去虚拟文件系统里查，
于是「打开归档本体」这个动作反而找不到文件。

| 方式 | 纯 Node | Electron 主进程 |
|---|---|---|
| `openSync(P)` | ✅ 121 MB | ❌ ENOENT |
| `openSync(P + '/')` | ✅ 121 MB | ❌ |
| `original-fs.openSync(P)` | ❌ MODULE_NOT_FOUND | ✅ **正解** |

所以 `resolveAsarFs()` 优先 `original-fs`，尾部斜杠别名兜底，最后才是普通 fs。
`loadOriginalFs()` 会**试多个解析锚点**（本模块位置 / `process.execPath` / 裸 `require`）——
因为插件是经**软链接**安装的，`import.meta.url` 落在开发目录，从那儿找不到 Electron。

> 这个 bug 藏了很久，因为 `openAsarIndex()` 当时用裸 `catch {}` 把所有失败都变成
> 「一个包都没有」。**停止吞异常**之后它当场现形 —— 见下面第 5 条。

### 5. 打开归档必须关 fd，失败必须抛

早先 `openAsarIndex` 只 open 不 close，每次调用漏一个 fd。
实测第 **8189** 次失败：`EMFILE: too many open files`（用户每点一次「重新扫描」就漏一个）。
修好后连开 8300 次全通过。

配套的两条：
- fd 一定在 `finally` 里关；`readAt` 用**短命 fd**，不把 `fd` 挂进返回值长期持有。
- **失败要抛出**，不要静默返回 `[]`。静默的代价是排查时看不到任何线索。

---

## 文件

```
package.json          插件清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml      把自己插进 profile 层栈的那一行
icon.svg              插件页图标
lib/index.js          宿主半：5 条 /api/agent-preset-studio/* 精确路由
lib/client.js         客户端半：设置页工作室 + 右侧栏面板
API-参考.md           ★ 从 app.asar 实读的客户端 API 契约（写 DSH 插件必看）
test-host.mjs         宿主半功能测试
test-client.mjs       客户端结构测试
test-install.mjs      安装预检
README.md             本文件
generated/            导出的预设包落在默认输出目录下
```

---

## 已知限制（诚实标注）

- **工具清单只覆盖 `@deepseek-ai/dsh-tool-*` / `dsh-skills-*` 与 `dsh-mcp-resources`**。
  第三方插件自己注册的工具在「已挂」区能看到，但不在「可挂」目录里
  —— 因为目录是从安装包静态扫出来的。
- **token 数是启发式估算**（4 字符 ≈ 1 token），用于横向比较，不等于真实计费。
- **「从已有预设载入」依赖 `agentPresets` 服务**。它不可用或被卡住时，
  该下拉会显示原因，但提示词编辑器与导出照常可用。

---

## 关于本项目

> 🤖 **本项目由 AI 生成。**

**代码全部由 AI 编写** —— `lib/index.js`、`lib/client.js`、三个测试文件、
`cordis.patch.yml`、`icon.svg`，以及本 README 与 `API-参考.md`，
均出自 AI 之手（Claude / WorkBuddy Agent 模式）。

### 人类做了什么

| 角色 | 内容 |
|---|---|
| **需求定义** | 提出「手动创建 agent 预设、查看全部工具、编辑系统提示词」的功能目标 |
| **验收测试** | 实际安装运行，逐轮反馈问题（界面卡在「扫描中」、点开空白页、渲染崩溃堆栈） |
| **关键决策** | 确定技术路径（bundle patch + `installBundle`）、UI 位置、安装方式 |

### AI 做了什么

架构设计与全部实现、DSH 插件 API 的逆向（读 `app.asar` 提取真实契约）、
209 条断言的三套测试、bug 根因定位（Electron asar 拦截、文件描述符泄漏、
路由 `node:http` 契约）、文档撰写。

### 免责声明

- **本项目按「原样」提供，不附带任何形式的担保**，包括但不限于对适销性、
  特定用途适用性及不侵权的担保。
- 插件会**读取**本机 DSH 安装包（`app.asar`）以枚举可挂载的工具包，
  并在**工作区目录**内写出文件。它**不修改** profile 的 `package.json` /
  `cordis.patch.yml`，安装动作由宿主提供的 `pluginManager.installBundle()` 完成。
- 作者不对使用本插件导致的任何数据丢失、DSH 配置损坏或其他损害负责。
  **使用前请自行备份 `~/.dsh/profiles/` 目录**。
- 本项目与 DeepSeek 官方无关，非官方项目。
- AI 生成的代码可能包含错误或过时的 API 假设。已在开发时的 DSH 版本上验证，
  **不保证在其他版本上可用**。

### 许可

MIT License —— 见 [LICENSE](LICENSE)。
