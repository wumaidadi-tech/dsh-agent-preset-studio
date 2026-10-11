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

## 四个界面

### 1. 工具（Tools）
两张按真实来源分开列的表：

| 分区 | 来源 | 键 |
|---|---|---|
| **当前已挂工具** | `ctx.get('tools')` 逐层遍历运行时注册表 | 工具名 |
| **可挂未挂工具** | 扫描 `app.asar` 的 `node_modules/@deepseek-ai/dsh-tool-*` 目录 | 包名 |

- 每行显示工具名 / 包名、它 ship 的工具、以及 **prefix token 估算**（触发函数定义的大小）。
- 勾选框 = 「这个预设要挂它」。勾选**立即写入草稿文件**（见下「勾选持久化」），
  切到别的设置页、刷新界面、重开窗口都不会丢。
- 顶部有过滤框、全选 / 全不选，右侧实时汇总已选数量与 token 合计。
- 两张表键不同，所以导出时会把**工具名经目录反查回包名** —— 否则勾选会静默丢失。

### 2. 系统提示词（System prompt）
这一页编辑的是 persona 的**四个字段**（含义见下表），不是一整段文字：

| 控件 | 对应字段 | 这是什么 / 会发生什么 |
|---|---|---|
| **前缀（prefix）** 文本框 | `prefix` | 追加到模型系统提示词**开头**的模板正文，必填。支持 `{{…}}` 占位符（如 `{{cwd}}`、`{{model}}`），渲染时由宿主解析成已注册提示词变量 |
| **后缀（suffix）** 文本框 | `suffix` | 追加到系统提示词**末尾**的模板。留空会遮蔽全局后缀 —— 如果你全局设了后缀、希望本预设也继承，请把它抄一份到这里 |
| **作为唯一系统提示词（complete）** 开关 | `complete` | 打开后，这个前缀成为**唯一**系统提示词：身份、后缀、工具引导、监听器都不会再追加。默认关 |
| **注入运行上下文（includeRuntimeContext）** 开关 | `includeRuntimeContext` | 关闭后会抑制本作用域所有上下文贡献（时间、工作目录等）。默认开；**上一版这个开关被硬编码成关**，你现在能自己控制了 |

- 下方是「**从现有预设载入**」下拉：选中一个已存在的预设后，
  **人设四字段 + 工具勾选会一起载入**，编辑来源（`source`）随之标明是哪个预设，
  导出表单的 id / name / order 也会自动填好。
- 实时显示字符数与 token 估算（**与宿主同一规则：4 字符 ≈ 1 token**；
  中文实际约为此值的 1.5 倍，界面已注明）。

### 3. 导出（Export）
填预设 id / 显示名 / 描述 / 排序 / 输出目录，点「生成并安装」后：
1. 在工作区写出一个带 `dsh.bundle.patch` 的完整插件目录；
2. 调 `pluginManager.installBundle()` 装进 profile；
3. 界面回显安装结果，并**并排展示生成的 `cordis.patch.yml` 全文**。

导出有两种模式，由界面上一个开关选择（没载入过现有预设时「覆盖」是灰的）：

| 模式 | 这是什么 / 会发生什么 |
|---|---|
| **另存为新预设** | 生成一份**新**的 bundle patch，不碰 profile 里已有的任何预设声明。id 冲突时宿主会拒绝 |
| **覆盖原预设** | 把当前编辑结果**写回**刚才载入的那个预设：改它的 persona 四字段与工具包列表，id / name / order 沿用原值。**这直接改你的 `cordis.patch.yml`**，动作前务必看清界面提示 |

### 4. 右侧栏面板
轻量只读面板：已挂工具行数、人设 token、可用预设数，加一个「打开工作室」入口。

---

## 编辑现有预设：覆盖写怎么保证安全

「覆盖原预设」走的是**文本级重写**，不是 YAML 反序列化再序列化 ——
整体 YAML 往返会把用户手写的注释和 `!!js` 表达式全部抹掉（历史上出过一次事故，
14 条声明全丢）。重写遵循三条铁律：

1. **全程文本级操作**。按行切分、按行重建，注释跟随它注释的那一行；
   `cordis:group` 分组行整体保留或整体丢弃，绝不拆开重组。
2. **找不到目标就拒绝写**，绝不「找不到就追加」—— 重复的 preset id 会让整条声明加载失败。
3. **写前自动备份**：原文件先复制成 `cordis.patch.yml.bak-studio-<时间戳>` 再动手，
   出问题可以一键还原。

写完后界面会贴出**改动后的原文**（不是只给 token 数），你可以逐行核对。

---

## 勾选持久化：选好之后不会没

「选好的东西切个页就没了」的根因：勾选状态之前只活在**前端内存**里，
组件一切走（切页、刷新、重开窗口）就重建，选择全清空。现在勾选会存到宿主文件：

- **草稿文件位置**：插件目录旁的 `.studio-draft.json`
  （`<插件目录>/.studio-draft.json`）。插件目录不可写时退回系统临时目录
  `dsh-agent-preset-studio/draft.json`。
- **里面存什么**：工具勾选、persona 四字段、正在编辑的预设来源（`source`）。
- **什么时候写**：界面变化后**防抖 500ms** 落盘，内容没变不写；写失败**静默**
  不打断操作 —— 下次打开看到的是最近一次成功的状态。
- **什么时候读**：工作室挂载时、加载快照**之前**恢复。顺序很重要：
  先读快照的话，「已挂工具」会先把勾选集初始化掉，草稿白存。
- **草稿坏了怎么办**：文件损坏 / 内容不是对象（比如被别的工具改成了数组）时，
  界面不崩，退回全新一份草稿，并显示一条 `draftError` 说明原因。
- **导出成功后**：勾选与字段会**清空重置**，避免把旧内容误带进下一个预设。

---

## 安装

DSH 自带的 pnpm 不是一个独立可执行文件，要用 Electron 当 Node 来跑它。
下面的 `<DSH 根目录>` 换成**你的** DeepSeek Harness 安装目录
（Windows 默认通常在 `C:/Users/<用户名>/AppData/Local/Programs/` 下），
`<profile 名>` 换成你的 profile 名字（常见是 `desktop`）：

```bash
cd ~/.dsh/profiles/<profile 名>
ELECTRON_RUN_AS_NODE=1 "<DSH 根目录>/DeepSeek Harness.exe" \
  "<DSH 根目录>/resources/runtime/pnpm/bin/pnpm.cjs" add "<本插件 clone 到的目录>"
```

然后**手动**往该 profile 的 `package.json` 里加两处：

```json
// dsh.profile.bundles —— 加一行
"@local/dsh-agent-preset-studio"

// dependencies —— 加一项（用 link: 指向你的 clone 目录）
"@local/dsh-agent-preset-studio": "link:<本插件 clone 到的目录>"
```

> pnpm 只负责写 `dependencies`；一个包要不要被加载，由 `bundles` 列表决定。
> 两处都写了才会生效。（本插件的 `installBundle` 路径会自动完成这两步，
> 这里是手装时的说明。）

**重启 DSH 生效**（新增 bundle 需要重新走一遍加载链）。

---

## 验证

```bash
node test-host.mjs      # 宿主半全链路（真实 asar 扫描、patch 生成、覆盖写边界、草稿降级）
node test-client.mjs    # 客户端结构（字典对称、t() 键覆盖、内联字典、abort 兜底、空白页守卫）
                        # + 交互层（轻量 DOM 模拟：渲染、草稿恢复、切页、开关、载入预设、导出模式）
node test-install.mjs   # 安装预检（manifest / 链接 / 双端可加载性；未安装时自动跳过）
```

三套都通过才算健康。

> **注意**：`test-host.mjs` 会真的去扫本机的 `app.asar`，所以它需要跑在一台
> **装着 DeepSeek Harness 的机器**上。在没有 DSH 的环境里，依赖安装的
> catalogue / export 测试节会明确说明并跳过（前面的纯逻辑测试照常完整运行）；
> `test-install.mjs` 在 profile 里没装本插件时同样自动跳过。

在装了 DSH 的机器上，`test-host.mjs` 同时会告诉你当前识别到多少工具包
（数量取决于你装了哪些 bundle / 插件，各人不同）。

---

## ⚠️ 导出成功但 DSH 看不到预设？先看这一节

**这不是插件的 bug，是 pnpm 供应链策略的副作用。** 已经踩过一次，写下来免得再踩。

### 症状

导出预设时界面**报成功**、`lib/generated/<id>/` 目录也生成了、`node_modules` 里
软链也建好了，但**重启 DSH 还是看不到这个预设**，`package.json` 的
`dsh.profile.bundles` 里也**没有**它。

### 根因

DSH 加载 profile 时**只读 `package.json` 里的 `dsh.profile.bundles` 名单，
完全不看 `node_modules`**。安装一个 bundle 要做两件事：

1. `pnpm add` 建软链、写 `dependencies`
2. 把包名 `push` 进 `dsh.profile.bundles`，再原子写回 manifest

而 pnpm 有一道 **`minimumReleaseAge`（供应链策略）**：lockfile 里任何一个包
「发布时间太新」都会让**整个 `pnpm install` 失败**。这时第 1 步的
软链可能已经建好，但第 2 步**根本没跑到** —— 于是界面报成功、DSH 却看不见。

日志长这样（`<profile>/.plugin-manager/logs/<本次操作>/pnpm.log`）：

```
+ @local/dsh-preset-<id> link:/path/to/lib/generated/<id>
✗ Lockfile failed supply-chain policy check (N entries in 2s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  some-unrelated-package@<版本> was published at <时间>, within the minimumReleaseAge cutoff
```

注意：被判违规的往往是**跟导出预设毫无关系的另一个包**（profile 里装的
任何东西都可能）。它太新，就足以让整次 install 一起失败。

### 怎么修

**先等一下**：`minimumReleaseAge` 的窗口是 **24 小时**。也就是说，那个被判
「太新」的包**过一天就自动合规了**，不用你做任何事。日志里会写清截止时间：

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  some-unrelated-package@<版本> was published at <T+24h 内的某个时刻>,
  within the minimumReleaseAge cutoff (<当前时间 - 24h>)
```

> `cutoff` 就是「当前时间减 24 小时」。等 `published at` 早于新的 cutoff，
> 这一条就不再违规 —— 被点名的包满 24 小时后自动放行。

等不及的话，到你的 profile 目录下按 pnpm 自己的提示走（二选一）：

```bash
# 方案 A：清掉 lockfile 重新解析
cd <你的 profile 目录>          # 如 ~/.dsh/profiles/<名字>
ELECTRON_RUN_AS_NODE=1 "<DSH 根目录>/DeepSeek Harness.exe" \
  "<DSH 根目录>/resources/runtime/pnpm/bin/pnpm.cjs" clean --lockfile
# 然后到「插件」页重试安装

# 方案 B：放行被点名的那一个包
# 在 profile 的 package.json 里加（不要加到全局）：
#   "pnpm": { "minimumReleaseAgeExclude": ["<被点名的包名>"] }
```

处理完**到「插件」页重新安装一次**那个预设包即可，不用重新导出。

> 💡 顺带一提：这一条**不影响你已经装好的插件**。它只在「往 profile 加新包」
> 时才会挡路 —— 而导出预设正是在做这件事，所以才会撞上。

### 插件侧已经做的加固

`generateAndInstall` 在 `installBundle` 返回后会**回读**
`dsh.profile.bundles` 确认包名真的进去了。没进去就返回
`installed: false / registered: false` 并附上 pnpm 报告的原因 ——
**不再因为「没抛错」就误报成功**。所以新版界面遇到这种情况会直接告诉你，
而不是让你对着一个「成功」提示重启十次。

---

## 排查入口

| 路由 | 用途 |
|---|---|
| `GET /api/agent-preset-studio/ping` | 只回 `{pong:true}`。**能通**说明宿主半已挂载且路由可达 |
| `GET /api/agent-preset-studio/snapshot` | 界面主数据（已挂 / 可挂工具、可用预设名单） |
| `GET /api/agent-preset-studio/preset` | `POST`：读某一个预设的原文行与 persona 四字段 |
| `GET /api/agent-preset-studio/profile-presets` | 解析 `cordis.patch.yml`，列出每个现有预设的 id / 分组 / 工具包 |
| `GET /api/agent-preset-studio/draft` | `GET`/`PUT`：读 / 写界面草稿（勾选 + 人设四字段 + 编辑来源） |
| `GET /api/agent-preset-studio/export` | `POST`：生成并安装预设包（支持另存 / 覆盖两种模式） |
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

`fs.openSync('<DSH 安装目录>/resources/app.asar')`（路径换成你机器上实际的 DSH 安装目录）
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
lib/index.js          宿主半：7 条 /api/agent-preset-studio/* 精确路由 + 草稿文件 + 覆盖写
lib/client.js         客户端半：设置页工作室（四个界面）+ 右侧栏面板
API-参考.md           ★ 从 app.asar 实读的客户端 API 契约（写 DSH 插件必看）
test-host.mjs         宿主半功能测试（含覆盖写边界、草稿降级）
test-client.mjs       客户端结构测试 + 交互层模拟测试
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
- **「从现有预设载入」依赖宿主 `profile-presets` 路由**：它解析 profile 的
  `cordis.patch.yml` 文本。解析失败 / 超时 / patch 文件不存在时，
  下拉会显示原因，但提示词编辑器、工具勾选与导出照常可用。
- **预设 id 只接受小写拉丁字母、数字和连字符**。中文 / 空格 / 其他符号会被
  剥掉 —— 剥完为空、或只剩纯数字的，**直接拒绝并说明原因**，不做静默降级。
  （曾经 `预设-1` 被静默存成 `1`，产出一个名叫 `1`、name 空着的预设，界面上
  完全认不出来。静默改坏比报错糟得多。）
- **预设中的 `cordis:group` 分组只能整组保留或整组丢弃**，不支持组内挑选。
  组里还有任何工具被勾着，整组就会留下。
- **导出后的安装步骤依赖 pnpm 能跑通**。若 profile 的 lockfile 触发 pnpm
  供应链策略（`minimumReleaseAge`），整次 install 会失败、`dsh.profile.bundles`
  不会更新 —— 详见上面那一节。插件只能**如实报告**，改不了 pnpm 策略。

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
359 条断言的三套测试、bug 根因定位（Electron asar 拦截、文件描述符泄漏、
路由 `node:http` 契约、pnpm 供应链策略中断安装）、文档撰写。

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
