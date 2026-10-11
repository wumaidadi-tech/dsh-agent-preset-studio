# DSH 客户端 API 参考（从 app.asar 实读，非推断）

来源：`E:/deepseek/resources/app.asar` → `dsh/node_modules/@deepseek-ai/*/lib/client.js`

提取工具：`C:\Users\angel\AppData\Local\Temp\dsh-asar2\asar.js`（模式 list / cat / dump；
包路径前缀 `dsh/node_modules/@deepseek-ai/...`，`cat`/`dump` 必须带 `MSYS_NO_PATHCONV=1`）

---

## 1. locale —— `ctx.locale`

来源：`dsh-client-locale/lib/client.js` L1387 / L1414

```js
// 注册：返回 disposer。ns 是命名空间字符串，值是多语言字典。
register(ns, { zh, en })            // 或 register(ns, "zh-CN", dict)
// → () => void

// 绑定：返回翻译函数，带 {name} 占位符插值。
bind(ns)                            // → (key, params?) => string
```

- `bind` 返回的函数**带缓存**，同一 ns 重复调用返回同一个函数引用。
- 查不到 key 时**回落顺序**：本 ns 当前语言 → 本 ns fallback 链 → `common` ns → **原样返回 key 本身**。
- `register` 对**同一 ns 的同一语言重复注册会 throw**：`locale namespace "x" already has locale "y"`。
- locale id 必须匹配 BCP 47 风格：`if (!LOCALE_ID_PATTERN.test(locale)) throw`。
- ⚠️ **字典必须是 JS 字面量内联**。`require('./locale/zh.json')` **在浏览器模块表里解析不到**
  —— 官方包全部把字典写成 `const zh = {...}`。这是本插件最初写错的地方。

### ⭐ `props.t` 从哪来：靠 `locale` 字段，不靠 `inject`

这是最容易搞错的一处。地面真相在 `dsh-client-ui-renderer/lib/client.js`：

```js
function standardKit(host, entry, scope, rootBinding, scopeBinding) {
  const standard = standardProps(scope, rootBinding, scopeBinding);
  const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) };
  if (entry.locale !== void 0) {
    const face = host.locale;
    if (face === void 0) throw new SlotAssemblyError(
      `entry declares locale namespace '${entry.locale}' but no locale face is installed …`);
    kit["t"] = localeSeat(face, entry.locale);   // ← t 在这里被塞进去
  }
  …
}
```

props 的合并顺序是：

```js
{ ...kit, ...injected, ...slotInjected.props, ...ownerProps }
```

结论：

- **只在 slot 条目上声明 `locale: NS`，才会得到 `props.t`。** 写了就一定拿到。
- `inject: () => ({})` **不会**把 `t` 顶掉 —— 上一条最初就是这么误判的。
- 官方 `@deepseek-ai/dsh-client-ui-agent-preset` 的注册形态与本插件**结构完全一致**
  （`locale` + `inject` 同时存在）且工作正常，可作参照。

**防御式写法（推荐照抄）**：组件里不要直接 `const t = props.t;`，
用一层 fallback 把「没拿到」降级成本地查表，并套一个 error boundary。
否则一旦 `t` 缺失，抛出的 `TypeError` 在插件面板里呈现为**整页空白**，没有报错信息 ——
本插件真的踩过一次。见 `lib/client.js` 的 `boundT()` 与 `StudioBoundary`。

---

## 2. slots —— `ctx.slots`

来源：`dsh-client-ui-slots/README.zh.md` + `dsh-client-ui-agent-preset/lib/client.js` L1685

```js
// 注入后注册（inject 等待该 slot 的声明者就绪）
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'my-id',                 // 该 slot 内唯一
  order: 21,                   // 数字，升序排列
  label: () => t('nav'),       // ⚠️ 是**函数**，不是字符串
  locale: NS,                  // 该条目文案所属的 locale 命名空间
  inject: () => ({ hooks: {...}, load, ... }),   // 业务 share：返回值会被展开进组件 props
}, MyComponent))
```

要点：
- `label` 在官方代码里是 `() => ctx.locale.bind("settings.agentPreset")("nav")` —— **无参函数**。
- `inject` 的返回值（对象）成为组件的 props 的一部分，与框架 share（`renderSlot`、
  会话标准 props、store share）合并后一起传入。
- 组件收到的 props 里**一定有 `t`**：因为注册时声明了 `locale: NS`，框架自动绑定翻译函数。
  官方组件的签名是 `({ ...各种注入, t })`。

### 侧栏 tab 正文（特殊）
来源：`dsh-client-ui-sidebar-right/lib/client.js` L5525

```js
renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
```

- 正文注册的 **`key` 必须等于 `sidebarRightTabs.register` 的 `id`**，否则渲染回落 fallback。
- 传入的框架 hook 通过 `hookContext`：`{ tabId, shortcuts, title, fullscreen, active,
  signal, actions, useStore, useTabNavigation }`，组件内用注入的 `useTabInfo()` 读
  `{ sidebar, panel, tab }`。

---

## 3. 侧栏 tab 类型 —— `ctx.sidebarRightTabs`

来源：`dsh-client-ui-sidebar-right/README.zh.md` L83–84 + `lib/client.js` L8690

```js
ctx.sidebarRightTabs.register({
  id,                 // 必填，全注册唯一；重复 throw
  kind,               // 必填，页类型标识
  patterns,           // 可选，作用于 dsh-resource:// 地址的 glob
  priority,           // 可选，'extension' | 'builtin' | 'fallback'
  canOpen,            // 可选，(address) => boolean 否决一次命中
  title,              // 必填，(address) => string   ⚠️ 是函数
  guide,              // 可选，[{ id, title, description?, kind, order? }]
  keepMounted,        // 可选，true = 切 tab/切会话/收起时保留正文
})
// → disposer（幂等）
```

注册表内部会用 `ctx.effect` 包裹条目（`sidebarRight.tabs.register("<id>")`）。
`keepMounted` 由**类型定义**读取，不是由正文 slot 注册读取
（`client.js` L5522：`seat === "sidebar.right.pane.tab" && definition?.keepMounted === true`）。

### ⚠️ 必须经 `.get()` 取，不能当属性读

```js
ctx.inject(['slots', 'sidebarRightTabs'], (injected) => {
  const tabs = injected.get('sidebarRightTabs');   // ✅ 唯一正确写法
  if (tabs === undefined) return undefined;         // 服务缺席时必须容忍
  injected.effect(() => tabs.register({ ... }), '标签');
});
```

`sidebarRightTabs` 是 **Host 服务**，不是 slot 组件上的属性。
写成 `ctx.sidebarRightTabs.register(...)` 或 `injected.sidebarRightTabs.register(...)`
会 `TypeError: Cannot read properties of undefined (reading 'register')` ——
而这个 throw 发生在 `inject` 回调里，**会被静默吞掉**，表现为「侧栏 tab 莫名其妙不出现」。

佐证：全部随包发布的可用插件里，属性式访问**零次**出现。
本插件的 `test-client.mjs` 有一条断言专门盯这个（同时禁止 `injected.` 与 `ctx.` 两种属性式写法，
包括文档注释里的 —— 注释里的错例也会被复制到代码里）。

---

## 4. remote —— `ctx.remote.<namespace>`

来源：`dsh-client-ui-agent-preset/lib/client.js` L1082 / L1072 / L1375

```js
const result = await ctx.remote.agentPresets.list();
// result.ok === true  → result.value = { presets: [...] }
// result.ok === false → result.error = { code, message, details? }

await ctx.remote.agentPresets.select(sessionId, presetId);
await ctx.remote.agentPresets.read(id);        // → { name, content }

await ctx.remote.settings.update(namespace, { field: value }, undefined);
// → { ok: true } | { ok: false, error: { message } }
```

- 特殊错误码 `gateway/invocation-unavailable`：表示该部署没挂这个网关，
  官方按「合法空结果」处理（返回空 roster 而不是报错）。
- `inject` 里要写**点号形式**：`"slots"`, `"sessions"`, `"locale"`, `"remote"`,
  `"remote.agentPresets"`, `"configForms"`。

⚠️ **`ctx.remote` 需要服务端有对应的 Remote 网关注册**（`@deepseek-ai/dsh-api-remotes`）。
本插件是手写普通 JS，没有装饰器构建管线，**无法自己注册 Remote 命名空间**。
因此宿主半用的是 `ctx.webServer.register` 精确 HTTP 路由（`/api/agent-preset-studio/*`），
客户端半用 `fetch` 访问——这条路径走 `client-connection` 的准入闸门，是可行方案。

---

## 5. UI 原语 —— `@deepseek-ai/dsh-client-ui-primitives`

已确认存在（从官方客户端包实际 import 的名字）：

`Button` / `Switch` / `SegmentedControl` / `SegmentedTabs` / `Checkbox` / `Input` /
`Menu` / `MenuItemButton` / `Pill` / `Tag` / `PathLabel` / `StateDot` /
`DisclosureRow` / `Modal` / `Tooltip` / `Toast` / `JsonTree` / `MarkdownText` / `CodeBlock`

图标（`*OutlineRegular` 后缀，接受 `size` / `className`）：
`IconAgentPresetOutlineRegular` / `IconChevronDownOutlineRegular` / `IconWarningOutlineRegular` /
`IconPlusOutlineRegular` / `IconCloseOutlineRegular` / `IconBrowseOutlineRegular` /
`IconListPenOutlineRegular`

⚠️ 本插件为降低耦合，**不使用 primitives**，全部用原生 DOM + 设计令牌手写样式。
这样即使 primitives 版本漂移也不会挂。

---

## 6. 设计令牌（`--dsw-alias-*`）

从官方 CSS 实读的可用令牌：

| 用途 | 令牌 |
|---|---|
| 面板底色 | `--dsw-alias-bg-layer-1` / `-2` / `-3` |
| 强调底 | `--dsw-alias-bg-module-platform` |
| 卡片 | `--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke` |
| 描边 | `--dsw-alias-border-l2` / `-l3` / `-l4` |
| 文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-quaternary` / `-caption` |
| 交互 | `--dsw-alias-interactive-bg-hover` |
| 状态 | `--dsw-alias-state-business-primary` / `--dsw-alias-state-error-primary` |
| 杂项 | `--dsw-alias-fill-tsp-secondary` / `--dsw-alias-scrollbar-bg-l2` |
| 圆角 | `--dsw-radius-xs` / `-sm` / `-md` / `-lg` / `-xl` |
| 静态中性 | `--dsw-static-neutral-200` / `-700` / `--dsw-static-neutral-bluish-400` |
| 焦点环 | `--dsw-focus-ring-width` / `--dsw-focus-ring-color` |

---

## 7. 已验证的入口点（写插件时必须遵守）

```js
window.__ModuleLoader__.load({
  id: '<包名>',                       // 必须等于 package.json 的 name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");     // react / react/jsx-runtime 从模块表来
    // ... 实现 ...
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

- 只能 `require` **模块表里已注册的包**：`react`、`react/jsx-runtime`、
  以及 `package.json` 的 `dsh.client.inject` 里列出的包。
- ⚠️ **不能 require 自己包内的其它文件**（如 `./locale/zh.json`）——模块表不认。
  一切都要内联进 `client.js`。

---

## 8. 宿主半 `ctx.webServer`

```js
ctx.webServer.register({
  kind: 'exact' | 'prefix',
  path: '/api/xxx',
  handler: (request) => Response,     // 标准 Web Request/Response
})
```

`/api` 前缀下会经过 `client-connection` 的准入闸门（与 RPC 同一道信任围栏）。

---

## 9. ⚠️ 陷阱：`@Remote` 方法可以在宿主内直呼，但可能永不返回

`dsh-agent-preset-registry` 的 `list` / `read` 带 `@Remote(...)` 装饰器：

```js
_remoteExportList_decorators = [Remote("list")];
async remoteExportList() { ... }
async list() {
  return (await Promise.all([...this.definitions.values()].map(async (record) => {
    const broken = await this.diagnostic(record);   // ← 这里会无限等
    ...
  }))).sort(...);
}
```

- **能在宿主内直接调用**（它们就是普通方法），装饰器只是让客户端也能经网关访问。
- ⚠️ **但 `list()` 会逐个 await 每个定义的「激活诊断」**，而文档明确说
  「等待 Host 服务的行保持挂载，每次读取和绑定都在 Host Loader 树结算后重新审计」
  —— 这类定义**不会 settle**，于是 `await` 永久挂起。
- 在 HTTP 路由里 `await` 它 = **请求永不返回** = 前端永远停在 loading。
  （这就是本站「扫描中」卡死的根因。）

**结论：任何 await 可选数据的地方都必须加上限，超时降级为「无数据 + 说明原因」。**
可选的数据增强永远不能成为响应的前置条件。

---

## 10. `ctx.tools` 的公开面

```js
ctx.tools.schemas()          // → 每个可见工具的 schema（已剔除 execute / 呈现回调）
ctx.tools.schemas(scope)     // scope = agent，省略即全局视图
ctx.tools.get(name, scope)   // 按作用域视角解析工具
ctx.tools.restrict(filter)   // 允许/拒绝掩码
```

`schemaOf(definition, true)` 产出的是**面向模型的**字段投影，即
`{ name, description, parameters }`（或 OpenAI 风格的 `{ type, function: {...} }` 嵌套）。

⚠️ 不要依赖 `ctx.tools.layers` —— 那是**内部结构**，公开文档没有它。
`schema()` 才是受支持的投影，且它同一份数据里已经排除了不该泄漏的东西。

---

## 11. `dsh-plugins-manager` 的安装规格（`install_bundle`）

- **绝对路径是合法 spec**：本地路径**直接读其 `package.json`**，
  且**跳过 `git ls-remote` 检查**（那一步只对 GitHub spec 做）。
- 实际动作 = 在 profile 目录跑 `pnpm add <spec>`，然后应用 bundle patch。
- 失败 / 被取消 / 装了个没有 bundle patch 的包 → 会**把 `package.json` 与
  `pnpm-lock.yaml` 恢复原样**。
- `pendingBuilds`：pnpm 拦下的依赖脚本会列出来，需要 `approvedBuilds` 授权。
- ⚠️ **本机没有独立 node / pnpm 可执行文件**，要用 Electron 当 Node
  （路径换成**你的** DSH 安装目录；`E:/deepseek` 是开发机的位置）：
  ```bash
  ELECTRON_RUN_AS_NODE=1 "<DSH 根目录>/DeepSeek Harness.exe" \
    "<DSH 根目录>/resources/runtime/pnpm/bin/pnpm.cjs" add <路径>
  ```
- ⚠️ pnpm 只写 `dependencies`；**`dsh.profile.bundles` 要手动加**，两处都写了才生效。

---

## 12. ⚠️ `webServer.register` 的 handler 是 **node:http 契约**，不是 Fetch

**这是本项目踩过的最贵的一个坑，务必记住。**

```js
ctx.webServer.register({
  kind: 'exact',            // 'exact' | 'prefix'
  path: '/api/xxx',
  handler: async (req, res) => {   // ← 是 (req, res)，不是 (request)
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  },
});
```

### 错误写法（会永久挂住请求）

```js
handler: (request) => json({ ok: true })   // ❌ 返回 Response，从不碰 res
```

返回 `Response` 对象看起来完全正常 —— 语法通过、单测也容易过 —— 但
**服务器从不调用 `res.end()`**，socket 一直开着：

- 浏览器侧表现为**永远转圈**，或等到客户端超时才报 "did not answer"
- **服务端不报任何错，也不打日志** —— 从服务器的视角，这个 handler 只是"还没返回"
- `curl` 直接挂到超时

### 佐证：官方自己怎么写

`@deepseek-ai/dsh-client-connection` 注册 `/api` 前缀路由时就是这么写的：

```js
const route = {
  kind: "prefix",
  path: API_PATH,          // "/api"
  handler: async (req, res) => {
    const admission = this.admit(req);           // 用 req 做准入判断
    if ("rejection" in admission) {
      res.writeHead(admission.rejection);        // 直接写 res
      res.end("unauthorized");
      return;
    }
    await bridge(req, res, fetchHandler);        // 继续写 res
  },
};
```

### 正确姿势：写一层适配器

内部仍然用 Fetch 风格的 `Response`（可测、可读），只在注册处适配一次：

```js
function serve(fetchHandler) {
  return async (req, res) => {
    try {
      const body = await readRawBody(req);       // GET/HEAD 直接 undefined
      const request = new Request(`http://dsh.internal${req.url}`, {
        method: req.method, headers: headerPairsOf(req.headers),
        ...(body === undefined ? {} : { body }),
      });
      const response = await fetchHandler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, {...});
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  };
}
```

### ⚠️ 读体的陷阱

`for await (const chunk of req)` **在 GET 上会等到天荒地老** —— 没有 body 的请求
永远不会产出 chunk。所以必须先短路：

```js
if (method === 'GET' || method === 'HEAD') return undefined;
if (Number(req.headers['content-length']) === 0) return undefined;
```

### 路由匹配顺序（`dsh-host-webserver`）

1. **先在整张表里找 `exact`**
2. 再取**最长**的 `prefix` 匹配
3. 最后交给 fallback handler（SPA dist）

⇒ 在 `/api`（prefix）之下注册 `exact` 路由是**合法且能生效**的，精确表优先。
但注意：**精确路由会绕过 `client-connection` 的准入闸门**
（Host/Origin 校验 + 浏览器会话认证）—— 那套闸门只在 `/api` 前缀路由里。
所以自己挂 `/api/...` 精确路由 = 自己负责鉴权。

### 桌面端传输（Electron）

`dsh-desktop-host` 的实际启动参数是：

```js
runProfile({ profile: 'desktop', args: ['--no-open', '--port', '19387'] });
const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
```

⇒ **桌面端就是真 HTTP**，跑在 `127.0.0.1:19387`，不是 `file://` + IPC。
（`dsh-host-webserver` 文档里"Electron 通过 file:// 加载 dist"说的是另一种部署形态。）
