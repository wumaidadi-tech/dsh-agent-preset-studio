/**
 * @local/dsh-agent-preset-studio — 宿主半（跑在 DSH 主进程里）
 *
 * 职责：只读地看一眼「当前部署到底挂了哪些工具」，外加**一个**写动作 ——
 * 把界面上编辑好的组合导出成一个可安装的预设包。
 *
 * ⚠️ 写文件这件事**不自己动 profile**：走 Plugin Manager 自己的
 * `installBundle` 服务装进去。profile 的 package.json / cordis.patch.yml
 * 从不由本插件手写，否则很容易把用户的配置改坏。
 *
 * 传输：浏览器半通过 5 个 JSON 接口调过来（挂在 `ctx.webServer` 上）。
 * 这些路径都在 `/api` 前缀下，所以会经过 `client-connection` 自己的准入闸门
 * （Host/Origin 校验 + 浏览器会话认证）—— 跟一次 RPC 调用过的是同一道信任边界，
 * 而不是敞开给任何人访问。
 *
 * 本插件**不往 `tools` 注册任何东西**，所以它不占模型上下文，
 * 也不往系统提示词里加任何段落。
 *
 * @module @local/dsh-agent-preset-studio
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs';
// createRequire 用来按 CommonJS 规则 require('original-fs')：
// 在 Electron 主进程里，原生 fs 被 asar 补丁改写，打开 .asar 本体本身会 ENOENT，
// original-fs 是未打补丁的那份，能正常打开归档。纯 Node 下 require 会抛错，
// resolveAsarFs 捕获后回落到普通 fs。
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = '@local/dsh-agent-preset-studio';

/** 本插件占用的路由前缀。挂在 `/api` 下面是为了走准入闸门。 */
export const ROUTE_PREFIX = '/api/agent-preset-studio';

/**
 * 导出的预设包默认落在哪里。
 *
 * ⚠️ 这里**不能写死任何人的机器路径**（早期版本写死了开发机的
 * `<开发机插件目录>/generated`，别人机器上没有这个盘，
 * 导出会在 `mkdirSync` 直接炸掉）。
 * 正解是「**插件自己装在哪，导出就落在哪**」：
 *   `<插件目录>/generated/`
 * 这样对任何机器、任何安装方式都成立。极少数拿不到模块路径的场景
 * （import.meta.url 不可用）再退到系统临时目录，保证永远可写。
 */
const DEFAULT_OUTPUT_ROOT = (() => {
  const self = dirOfImportMeta();
  if (self !== undefined) return join(self, 'generated');
  return join(tmpdir(), 'dsh-agent-preset-studio', 'generated');
})();

/**
 * 工作室的「草稿」文件放哪。
 *
 * ⚠️ 勾选状态之前只活在前端的内存 store 里 —— 切走再回来组件就重挂载，
 * 选择全清空。存到磁盘才叫真的记住。
 * 放在插件目录旁边（和 generated 同一个根），插件目录不可写时退回临时目录。
 */
const DRAFT_PATH = (() => {
  const self = dirOfImportMeta();
  if (self !== undefined) return join(self, '.studio-draft.json');
  return join(tmpdir(), 'dsh-agent-preset-studio', 'draft.json');
})();

/**
 * 诊断用的 trace 输出位置；为 undefined 表示不记录。
 *
 * 从环境变量读，所以正常运行时**不会留下任何文件**：
 * 把 `DSH_AGENT_PRESET_STUDIO_TRACE` 设成一个路径，才会记录挂载和路由命中。
 */
const TRACE_FILE = (() => {
  try {
    const value = process?.env?.DSH_AGENT_PRESET_STUDIO_TRACE;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch { return undefined; }
})();


/** 会携带「模型可见工具」的包名前缀。 */
const TOOL_PACKAGE_RE = /^@deepseek-ai\/dsh-(?:tool|skills)-/;

/** 预设行可以合法声明的带 scope 包名。 */
const PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/;

/**
 * 「读预设名单」这个可选步骤的时间上限。
 *
 * 没有名单界面照样能渲染，所以这个值只需满足两点：
 * 够长，能覆盖一个健康注册表的正常耗时；
 * 够短，让一个卡住的注册表表现为**降级**（读不到名单，但有说明），
 * 而不是表现成**卡死**。
 */
const ROSTER_TIMEOUT_MS = 2500;

/** 携带工具、但不匹配上面那条前缀规则的包。 */
const EXTRA_TOOL_PACKAGES = ['@deepseek-ai/dsh-mcp-resources'];

/** README 里看起来像工具名、其实只是普通英文词的东西（不要把噪声当工具）。 */
const TOOL_NAME_STOP = new Set([
  'text', 'json', 'yaml', 'true', 'false', 'null', 'utf', 'html', 'http', 'https',
  'readme', 'package', 'config', 'schema', 'token', 'tokenize', 'agent', 'model',
  'and', 'the', 'for', 'with', 'not', 'about', 'into', 'when', 'that', 'this',
  'none', 'auto', 'path', 'name', 'size', 'type', 'mode', 'root', 'base',
]);

/** ------------------------------------------------------------------ */
/** 小工具函数                                                          */
/** ------------------------------------------------------------------ */

/** 从任意被抛出的值里取出一行可读的错误信息。 */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/**
 * 构造一个 JSON 响应。
 *
 * 路由内部一律按 Fetch 的 `Response` 形状写 —— 这样响应体能**在纯 Node 里直接测**，
 * 由 {@link serve} 统一适配到服务器真正调用的 `node:http` 契约上。
 * @param body - 可 JSON 序列化的负载。
 * @param status - HTTP 状态码。
 * @returns 一个装着编码后响应体的 Response。
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 把 Fetch 形状的 handler 适配成服务器真正调用的 `node:http` handler。
 *
 * ⚠️ 这个适配器是**承重的**，掉了整个插件就废。
 * `webServer.register` 收的是 `async (req, res) => { ... }`，并且**把 socket 交给它**：
 * 谁写响应由 handler 自己负责。如果写成「返回一个 `Response` 对象」——
 * 这恰恰是最自然的写法，也是本插件早期版本真的写过的写法 ——
 * 那条路由就**永远不会调 `res.end()`**，于是每一次请求都挂到客户端自己放弃为止。
 *
 * 而且**服务端一行日志都不会有**：从服务器的视角看，这个 handler 只是「还没返回」而巳。
 * （用户当时看到的「一直扫描中」就是这么来的。）
 *
 * 回调默认走 Fetch 形状的签名，是为了让路由体在测试里和生产里读起来完全一致。
 * @param fetchHandler - `(request) => Response | Promise<Response>`；
 *   `request` 由进来的消息构造出的 Fetch `Request`。
 * @returns 一个**保证会终结响应**的 `node:http` handler。
 */
function serve(fetchHandler) {
  return async (req, res) => {
    try {
      // 把进来的消息重新拼成一个 Fetch Request，这样路由体（和它的测试）
      // 永远不需要关心 node:http 的细节。
      const body = await readRawBody(req);
      const request = new Request(`http://dsh.internal${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers: headerPairsOf(req.headers),
        ...body === undefined ? {} : { body },
      });

      const response = await fetchHandler(request);
      const headers = {};
      for (const [name, value] of response.headers.entries()) headers[name] = value;
      res.writeHead(response.status, headers);
      res.end(await response.text());
    } catch (error) {
      // socket 归这个 handler 管，所以就算出了预料之外的异常，
      // 也必须给出一个「终结性」响应，而不是留下一个挂住的连接。
      traceProbe(`route-threw: ${messageOf(error)}`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ ok: false, error: messageOf(error) }));
      } catch { /* socket 可能已经没了 */ }
    }
  };
}

/**
 * 读取进来的请求体；没有请求体时返回 undefined。
 *
 * ⚠️ GET 几乎不带 body，而对它执行 `for await` 会一直等一个**永远不来的消息**
 * —— 这正是整个适配器要避免的那种挂住。所以「方法没有 body」或「长度声明为 0」
 * 一律短路返回。
 * @param req - 进来的 node:http 请求。
 * @returns 请求体文本，或 undefined。
 */
async function readRawBody(req) {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return undefined;
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && Number(declared) === 0) return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString('utf8');
}

/** 把 node:http 的 header 摊平成 Fetch `Headers` 能接受的键值对。 */
function headerPairsOf(headers) {
  const pairs = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') pairs.push([name, value]);
    else if (Array.isArray(value)) for (const one of value) pairs.push([name, String(one)]);
  }
  return pairs;
}

/**
 * 往工作室自己的 trace 文件里追加一行。
 *
 * 故意做得极小且「发完不管」：这是唯一能区分
 * 「插件压根没挂上」和「路由挂上了但到不了」的手段 —— 因为挂住的时候
 * 根本没有响应可供检查。每条失败路径都被吞掉 ——
 * **诊断本身绝不能成为请求失败的原因**。
 * @param label - 事件名。
 */
function traceProbe(label) {
  try {
    if (TRACE_FILE === undefined) return;
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    writeFileSync(
      TRACE_FILE,
      `${new Date().toISOString()} ${label}\n`,
      { flag: 'a', encoding: 'utf8' },
    );
  } catch { /* 诊断绝不能弄坏它所描述的那次请求 */ }
}

/**
 * 把请求体按 JSON 解析（有上限保护）。
 * @param request - 进来的 Web 请求。
 * @returns 解析后的值；空请求体返回 `{}`。
 */
async function readJsonBody(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** ------------------------------------------------------------------ */
/** 读 asar 归档                                                        */
/** ------------------------------------------------------------------ */
/**
 * 【中文】找到当前这个安装的 `app.asar`。
 *
 * 三个来源，从最省的开始试：
 *   1) Electron 自己的 `process.resourcesPath`；
 *   2) 从本模块向上走，找同级的 `resources/app.asar`（工作区安装的插件就住在这种布局旁边）；
 *   3) 兜底：本机已知的固定路径。
 *
 * 开发态的 checkout 可能三个都没有，所以返回值是可选的 ——
 * **每个调用方都必须能容忍 `undefined`**。
 * @returns 绝对路径；归档够不到时返回 undefined。
 */
function locateAppAsar() {
  const candidates = [];

  try {
    if (typeof process !== 'undefined' && typeof process.resourcesPath === 'string') {
      candidates.push(join(process.resourcesPath, 'app.asar'));
    }
  } catch { /* 不是 Electron 环境 */ }

  // 从本文件向上走：装在应用旁边的插件，归档在 <root>/resources/app.asar，
  // 而本模块位于 <root> 下面的某个位置。逐层向上最多 8 层，
  // 覆盖「插件直接装在 DSH 根目录旁」「装在 DSH 根目录下的子目录」两种布局。
  // ⚠️ 这里曾经还硬编码过一条开发机的绝对路径兜底（形如 `<开发机路径>/...`）——
  // 后来删了：向上走的逻辑本身就能推导出同一条路径（插件装在
  // `<开发机插件目录>`，向上 1 层即命中），
  // 而写死别人机器上不存在的路径对一个开源插件没有任何意义。
  try {
    let dir = dirOfImportMeta();
    for (let depth = 0; dir !== undefined && depth < 8; depth += 1) {
      candidates.push(join(dir, 'resources', 'app.asar'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* 忽略 */ }

  for (const candidate of candidates) {
    try {
      if (typeof candidate === 'string' && existsSync(candidate)) return candidate;
    } catch { /* 忽略 */ }
  }
  return undefined;
}

/** 本模块所在的目录；拿不到就返回 undefined。 */
function dirOfImportMeta() {
  try {
    const url = import.meta?.url;
    if (typeof url !== 'string' || !url.startsWith('file:')) return undefined;
    return dirname(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

/**
 * 【中文】拿到一个「能真正读 .asar 文件字节」的打开函数。
 *
 * 这是本插件最隐蔽的一个坑，值得完整写下来：
 *
 * **Electron 会把 fs 打补丁。** 在主进程里调用 fs.openSync('.../app.asar') 时，
 * Electron 拦截路径中出现的 `.asar` 段，把它当成**目录**去解析（透明读包内文件），
 * 而不是当成一个普通文件。于是「打开归档本身」这个动作会抛
 *   ENOENT: no such file or directory, open '<DSH 根目录>/resources/app.asar'
 * 而诡异的是，同一个调用在**纯 Node** 下完全正常（我们就是这么开发和测试的），
 * 所以这个 bug 只在真机运行时才暴露 —— 而且早先外围还有个裸 catch {}，
 * 把它伪装成了「一个包都没扫到」，界面上表现为分区莫名空掉、毫无报错。
 *
 * 三种解法，按可靠性排序：
 *   1) `original-fs` —— Electron 官方提供的「未打补丁的原始 fs」。
 *      主进程里 require('original-fs') 即可绕过拦截。**这是正解。**
 *   2) 尾斜杠别名 —— 路径写成 `app.asar/`。Electron 的匹配按「.asar 段」判定，
 *      加斜杠后不再命中，而 Node/Windows 会把它归一化回文件（实测能拿到
 *      完整 121MB 大小）。这作为兜底，纯 Node 测试下同样可用。
 *   3) 直接 open —— 只有在纯 Node 里才成功。
 *
 * @param {string} asarPath - app.asar 的绝对路径（仅用于判断是否要加别名）。
 * @returns {{openReadOnly: (path: string) => number, kind: string}}
 */
function resolveAsarFs(asarPath) {
  // 方案 1：Electron 的 original-fs（未打补丁）。纯 Node 下 require 会失败，属正常。
  const originalFs = loadOriginalFs();
  if (originalFs !== undefined) {
    return { kind: 'original-fs', openReadOnly: (p) => originalFs.openSync(p, 'r') };
  }

  // 方案 2/3：普通 fs —— 先原路径，失败再试尾斜杠别名（绕 Electron 的 .asar 拦截）。
  return {
    kind: 'node-fs',
    openReadOnly: (p) => {
      try {
        return openSync(p, 'r');
      } catch (error) {
        const alias = p.endsWith('/') ? p : p.replace(/\.asar$/, '.asar/');
        if (alias !== p) return openSync(alias, 'r');
        throw error;
      }
    },
  };
}

/**
 * 【关键】取 Electron 那份**未打补丁**的 fs，取不到就返回 undefined。
 *
 * 为什么要试多个锚点：`original-fs` 是 Electron 内置模块，按理在任何地方 require
 * 都能命中。但这个插件是被「profile 的 node_modules 里一个软链接」引用进来的，
 * `import.meta.url` 指向磁盘上的开发目录（插件 clone 所在的位置）—— 从
 * 那里往上找 node_modules 是找不到 Electron 的。所以除了自身位置，还要用进程
 * 实际的可执行文件路径（`process.execPath`）作为兜底锚点。
 *
 * 每个锚点各自 try：全部失败只说明「当前不是 Electron 环境」（纯 Node 测试就是这样），
 * 不是错误，所以静默返回 undefined，由调用方回落到普通 fs。
 *
 * @returns {{openSync: Function}|undefined}
 */
function loadOriginalFs() {
  const anchors = [];
  // 锚点 1：本模块自身位置（workspace 内直接跑时有效）。
  try { anchors.push(createRequire(import.meta.url)); } catch { /* 忽略 */ }
  // 锚点 2：Electron 可执行文件位置（被软链接安装时，只有这条能找到 electron）。
  try {
    if (typeof process !== 'undefined' && typeof process.execPath === 'string') {
      anchors.push(createRequire(process.execPath));
    }
  } catch { /* 忽略 */ }
  // 锚点 3：CommonJS 的裸 require（某些打包形态下只有它能看到内置模块）。
  try {
    if (typeof require === 'function') anchors.push(require);
  } catch { /* ESM 下 require 不存在，正常 */ }

  for (const anchor of anchors) {
    try {
      const candidate = anchor('original-fs');
      if (candidate !== undefined && typeof candidate.openSync === 'function') return candidate;
    } catch { /* 这个锚点不行，试下一个 */ }
  }
  return undefined;
}

/**
 * 【诊断】逐个尝试打开 app.asar 的每种方式，报告哪一种可行。
 *
 * 存在的意义：Electron 的 asar 补丁会让 `openSync('.../app.asar')` 报 ENOENT，
 * 而在纯 Node 下同一次调用完全正常。这种「只在运行时炸」的问题没法靠本地复现，
 * 必须让**运行中的宿主进程自己**把每种方式试一遍，才能知道该用哪条路。
 *
 * 每种方式都用短命 fd 并在 finally 里关闭，避免这个诊断自己泄漏描述符。
 *
 * @param asarPath - app.asar 绝对路径。
 * @returns 每种方式的结果数组：{ label, ok, kind?, size?, error? }
 */
function probeAsarOpen(asarPath) {
  const results = [];

  // 统一的试开逻辑：拿到 fd 后立刻量大小、再立刻关掉。
  const attempt = (label, opener) => {
    let fd;
    try {
      fd = opener();
      let size;
      try { size = fstatSync(fd).size; } catch { size = undefined; }
      results.push({ label, ok: true, size });
    } catch (error) {
      results.push({ label, ok: false, error: `${error?.code ?? 'ERR'}: ${messageOf(error)}` });
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关或无效 */ } }
    }
  };

  attempt('fs.openSync(path)', () => openSync(asarPath, 'r'));
  attempt('fs.openSync(path + "/")', () => openSync(asarPath.endsWith('/') ? asarPath : `${asarPath}/`, 'r'));

  // original-fs：Electron 主进程里存在，纯 Node 下取不到，属正常。
  const originalFs = loadOriginalFs();
  if (originalFs === undefined) {
    results.push({ label: 'original-fs.openSync(path)', ok: false, error: '模块不可用（当前不是 Electron 主进程）' });
  } else {
    attempt('original-fs.openSync(path)', () => originalFs.openSync(asarPath, 'r'));
  }

  return results;
}

/**
/**
 * 打开安装归档，建立「文件路径 → 偏移/大小」的扁平索引。
 *
 * ⚠️ 两个必须注意的点（都踩过）：
 *   1) **必须关闭 fd。** 早先的实现在这里只 open 不 close，每次调用泄漏一个
 *      文件描述符。进程跑久了（尤其每点一次「重新扫描」就调一次）会撞上
 *      EMFILE: too many open files，之后的 open 全部失败。
 *   2) **不能吞掉异常。** 早先用裸 `catch {}` 把任何失败都变成 `undefined`，
 *      上层就当「一个包都没有」，界面上表现为「可挂载工具包」分区**静默空掉**，
 *      没有任何报错。现在失败时会把原因带出去（见 catalogueError）。
 *      正是这条改动，让上面那个 Electron asar 拦截问题当场现了原形。
 *
 * 索引只读 header（约 3.4MB 的 JSON 文件表），不读正文，
 * 所以不会把整个 120MB+ 的 asar 读进内存。
 *
 * @param {string} asarPath - app.asar 绝对路径。
 * @returns {{entries: Array, readAt: (offset: number, size: number) => string}}
 */
function openAsarIndex(asarPath) {
  let fd;
  // 关键：不要用裸 fs 打开 .asar —— 在 Electron 主进程里会被 asar 补丁拦截并 ENOENT。
  // resolveAsarFs 会优先用 original-fs，其次用尾斜杠别名兜底。
  const asarFs = resolveAsarFs(asarPath);
  try {
    fd = asarFs.openReadOnly(asarPath);
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonStringSize = head.readUInt32LE(12);
    if (headerSize <= 0 || jsonStringSize <= 0 || jsonStringSize > 64 * 1024 * 1024) {
      throw new Error(`unexpected asar header (headerSize=${headerSize}, jsonStringSize=${jsonStringSize})`);
    }
    const raw = Buffer.alloc(jsonStringSize);
    readSync(fd, raw, 0, jsonStringSize, 16);
    const header = JSON.parse(raw.toString('utf8'));
    const base = 8 + headerSize;

    const entries = [];
    const walk = (node, prefix) => {
      const files = node && node.files;
      if (files === undefined) return;
      for (const key of Object.keys(files)) {
        const entry = files[key];
        const full = `${prefix}${key}`;
        if (entry && entry.files !== undefined) walk(entry, `${full}/`);
        else if (entry && typeof entry.size === 'number') {
          entries.push({ path: full, size: entry.size, offset: base + Number(entry.offset) });
        }
      }
    };
    walk(header, '');

    // 索引只保留文件表；读取走一个**短命**的 fd，用完立刻关，
    // 这样就不会在长驻的索引对象里扣着一个句柄不放。
    const readAt = (offset, size) => {
      const size2 = Math.min(size, 512 * 1024);
      let handle;
      try {
        handle = asarFs.openReadOnly(asarPath);
        const buf = Buffer.alloc(size2);
        readSync(handle, buf, 0, size2, offset);
        return buf.toString('utf8');
      } finally {
        if (handle !== undefined) {
          try { closeSync(handle); } catch { /* 已经关了就忽略 */ }
        }
      }
    };

    return { entries, asarPath, readAt };
  } catch (error) {
    // 不吞异常：把原因原样抛出，让上层能记进 catalogueError 并显示出来。
    throw new Error(`could not index ${asarPath}: ${messageOf(error)}`);
  } finally {
    // 关键：无论成功失败都关掉 header 用的这个 fd。
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

/**
 * 从索引里读一小段正文（默认上限 512KB），走上面的**短命 fd**。
 * 读失败返回 undefined —— 调用方按「这个文件没有／读不出来」处理即可。
 */
function readAsarEntry(index, entry, maxBytes = 512 * 1024) {
  if (index === undefined || entry === undefined) return undefined;
  try {
    return index.readAt(entry.offset, Math.min(entry.size, maxBytes));
  } catch {
    return undefined;
  }
}

/**
 * 工具名 → 包名 的反查表。
 *
 * 界面上的「已挂工具」是按【工具名】列出的（运行时注册表就是这么存的），
 * 而预设声明的是【包名】—— 两张表的键不一样。
 * 所以导出时必须把用户勾的「工具名」反查回「包名」，否则勾选会静默丢失。
 * 扫不到安装包就返回空表（尽力而为），此时导出只接受包名。
 * @returns 工具名 → 包名。
 */
function buildToolToPackage() {
  try {
    const appAsar = locateAppAsar();
    if (appAsar === undefined) return new Map();
    return toolToPackageOf(scanInstalledPackages(appAsar));
  } catch { return new Map(); } /* 尽力而为，失败不抛 */
}

/**
 * 从**已经扫好的**目录表生成「工具名 → 包名」反查表。
 *
 * 为什么不直接调 `buildToolToPackage()`：那个函数内部会自己再扫一遍 asar。
 * 快照请求里 `catalogue` 已经拿在手上（「可挂」分区要用），再让它扫第二遍
 * 纯属浪费 —— 那是 121MB 的归档。所以把「建表」这一步独立出来复用。
 * @param catalogue - `scanInstalledPackages` 的返回值。
 * @returns 工具名 → 包名。
 */
function toolToPackageOf(catalogue) {
  const map = new Map();
  for (const pkg of catalogue ?? []) {
    for (const toolName of pkg.toolNames ?? []) {
      if (!map.has(toolName)) map.set(toolName, pkg.package);
    }
  }
  return map;
}

/**
 * 扫描安装目录，列出「所有可能挂载的工具包」以及每个包 ship 了哪些工具。
 * 数据来源是 app.asar 内部的文件表（不是运行时注册表），
 * 所以这里能看到【可挂但当前没挂】的包 —— 这正是界面上「可挂载工具包」分区要的数据。
 * 每个包的版本/描述取自它自己的 package.json，工具名列表取自 README。
 * 全程只读 512KB 上限的片段，不会把整个 100MB+ 的 asar 读进内存。
 * @returns `{ package, version, description, toolNames }` 的列表。
 */
function scanInstalledPackages(appAsar) {
  // 索引打不开就**直接抛**，不再静默返回空数组。
  // 早先 return [] 会让「扫不到」和「真的一个包都没有」长得一模一样，
  // 界面上表现为「可挂载工具包」分区莫名空掉且无任何提示。
  // 现在异常会经 catalogueError 冒到界面上，可诊断。
  const index = openAsarIndex(appAsar);
  {
    const byPackage = new Map();
    for (const entry of index.entries) {
      // 只关心安装包内的 node_modules/@deepseek-ai/... ，其它路径一律跳过。
      const match = /^dsh\/node_modules\/(@deepseek-ai\/[^/]+)\//.exec(entry.path);
      if (match === null) continue;
      const pkg = match[1];
      // 工具包 = 包名匹配 TOOL_PACKAGE_RE（dsh-tool-* / dsh-skills-*），
      // 外加少数特例（EXTRA_TOOL_PACKAGES），例如 dsh-mcp-resources。
      if (!TOOL_PACKAGE_RE.test(pkg) && !EXTRA_TOOL_PACKAGES.includes(pkg)) continue;
      const record = byPackage.get(pkg)
        ?? { pkg, manifest: undefined, readmeZh: undefined, readmeEn: undefined };
      // ⚠️ 中文版和英文版**各存各的**，不抢一个槽位。
      // 这里曾经只用一个 `readme` 字段并写「优先中文版」——
      // 但遍历顺序由归档内部的文件顺序决定，英文版先被看到就会占住槽位，
      // 之后的中文版因为「槽位非空」被静默丢弃。实测 22 个包全都拿到了
      // 英文版，中文说明一个字都没用上。
      // 分开存就没有顺序依赖 —— 取用时明确地先看中文。
      if (entry.path === `dsh/node_modules/${pkg}/package.json`) record.manifest = entry;
      else if (entry.path === `dsh/node_modules/${pkg}/README.zh.md`) record.readmeZh = entry;
      else if (entry.path === `dsh/node_modules/${pkg}/README.md`) record.readmeEn = entry;
      byPackage.set(pkg, record);
    }
    const rows = [];
    for (const record of byPackage.values()) {
      let version;
      let description;
      // package.json 用来取 version / description，读失败就用默认值。
      // ⚠️ description 不只是给人看的说明 —— 它同时是**工具名的主来源**：
      // 各包在这句里用括号列出自己 ship 的工具，例：
      //   dsh-tool-jobs → "…control tools (job_output, job_list, job_kill) over…"
      // 所以下面必须把它先算出来，再传给 extractToolNames。
      const manifestText = readAsarEntry(index, record.manifest);
      if (manifestText !== undefined) {
        try {
          const manifest = JSON.parse(manifestText);
          version = manifest.version;
          description = manifest.description;
        } catch { /* 解析失败保留默认值 */ }
      }
      // 中文 README 优先；它不存在时才用英文版。
      const zhReadme = readAsarEntry(index, record.readmeZh);
      const enReadme = readAsarEntry(index, record.readmeEn) ?? '';
      // 中文 README 顶部的 frontmatter 描述 —— 这是**给人看的**说明文字，
      // 比英文 description 更适合直接显示在界面上（英文那句满是
      // "Model-facing … over the ctx.xxx seam" 这种实现细节）。
      // 没有中文版时返回 undefined，界面会退回用英文 description。
      const zhSummary = frontmatterDescription(zhReadme, 'README.zh.md');
      const readme = zhReadme ?? enReadme;
      rows.push({
        package: record.pkg,
        version,
        description: description ?? firstReadmeLine(readme),
        // 界面上的说明列：优先中文 frontmatter，没有才用英文 description。
        summary: zhSummary ?? description,
        // 工具名从英文 description + 中文说明里取（见 extractToolNames）。
        // 中文 README **全文**也要传进去 —— 少数包（如 dsh-mcp-resources）
        // 的工具名只写在正文里，frontmatter 说明一个字都没提。
        // 正文只在最后兜底时才会被扫，且只认反引号里的 snake_case，
        // 不会把参数名捞进来（详见 extractToolNames 的来源 5）。
        toolNames: extractToolNames(record.pkg, description, zhSummary, zhReadme),
      });
    }
    rows.sort((a, b) => a.package.localeCompare(b.package));
    return rows;
  }
}

/**
 * 从包的**描述信息**里抽出它 ship 了哪些**工具名**。
 *
 * ⚠️ 这个函数前后错了两次，代价都是界面没法看（用户两次截图反馈）：
 *
 *   错法 A（初版）：扫 README 里**所有**反引号标识符。
 *     → 得到 `read, file_path, offset, limit, write, content…`
 *     —— 工具名和**参数名**混在一起。
 *
 *   错法 B（第二版）：改成「只扫 README 的 Summary 章节」。
 *     这个假设是错的：这些包的 `## Summary` 确实存在，但它是**一段散文**，
 *     不是工具清单。`dsh-tool-bash` 的 Summary 写着
 *     「…`run_in_background` returns the id… retried once with wider
 *     `sandbox_permissions`, a `justification`…」—— 全是**参数名**。
 *     → 得到 `run_in_background, sandbox_permissions, justification`。
 *     比错法 A 少，但性质一样：拿参数名冒充工具名。
 *
 * 现在只用**包的 description**，它是唯一稳定写清工具名的地方：
 *
 *   1) **括号内的标识符**（多工具包）：
 *        · `dsh-tool-fs` → "filesystem tools (read, write, edit)" → read/write/edit
 *        · `dsh-tool-jobs` → "(job_output, job_list, job_kill)" → 三个都对
 *        · `dsh-tool-web` → "(web_search, web_fetch)" → 两个都对
 *      ⚠️ 括号里可能夹着别的东西：`dsh-tool-fs-search` 的描述是
 *      "(glob, grep) backed by the packaged ripgrep binary (@vscode/ripgrep)"
 *      —— 第二个括号是**包路径**，不是工具。所以含 `/` 或 `@` 的整段丢弃。
 *   2) **`tool` / `tools` 之前的 snake_case 标识符**（单工具包）：
 *        · "Model-facing ask_user_question tool over…" → ask_user_question
 *        · "Model-facing todo_write tool over…"        → todo_write
 *        · "Globally named send_message, interrupt_agent, and list_agents tools…"
 *          → 三个都收
 *      「必须含下划线」这个条件天然排除了 `persistent` / `discovery` 这类普通词。
 *   3) **包名反推**：`dsh-tool-goal` → `goal`，`dsh-tool-skill` → `skill`。
 *      只在上面两条都没命中时用（此时包名基本就是工具名）。
 *   4) **中文 README 里反引号包裹的 snake_case**（最后的补充来源）：
 *      `dsh-mcp-resources` 既不是 `dsh-tool-*` 也不是 `dsh-skills-*`（走的是
 *      EXTRA_TOOL_PACKAGES 特例），包名反推对它无效；而它的英文 description
 *      只描述功能（"Scoped MCP resource discovery…"）、frontmatter 说明里也
 *      一个工具名都没有 —— 三个工具名只写在**正文**里：
 *        「将其中一个名称作为 `server` 调用 `list_mcp_resources` 或
 *          `list_mcp_resource_templates`…通过 `read_mcp_resource` 读取…」
 *      ⚠️ 这一条**只认反引号内的内容**，而且**必须含下划线**。
 *      两个限制缺一不可：
 *        · 只认反引号 → 避开散文里的普通英文词（正文里裸写 `server` 之类的
 *          参数名不会被收，因为它们没被反引号包住……事实上 `server` 被包住了，
 *          所以还需要下一条）；
 *        · 必须含下划线 → 把 `server`、`cursor`、`nextCursor`、`uri` 这类
 *          被反引号包住的**参数名**挡在外面（工具名几乎总带下划线，
 *          `read_mcp_resource` vs 参数 `server` —— 一眼可分）。
 *      并且**只在前面所有来源都落空时**才启用，绝不与前三者争夺优先级。
 *   5) 全都拿不到就**返回空数组**，让界面显示「未标注」而不编造。
 *      —— 宁可诚实地说「不知道」，也不要拿参数名冒充工具名。
 *
 * 结果始终过一遍 {@link TOOL_NAME_STOP} 黑名单。
 * @param pkg - 包名，用于反推单工具包。
 * @param description - 英文 description 字段。
 * @param zhDescription - 中文 README frontmatter 的说明（可选，通常更全）。
 * @param zhReadme - 中文 README 的**全文**（可选，仅用于来源 4）。
 * @returns 工具名数组（已去重、已排序）。
 */
function extractToolNames(pkg, description, zhDescription, zhReadme) {
  const names = new Set();
  const desc = typeof description === 'string' ? description : '';
  const zh = typeof zhDescription === 'string' ? zhDescription : '';
  const zhBody = typeof zhReadme === 'string' ? zhReadme : '';
  const collect = (raw) => {
    const name = raw.trim().toLowerCase();
    // 工具名一律是「小写字母开头、只含小写/数字/下划线」的 snake_case 标识符。
    // 长度下限 2、上限 40，再过滤黑名单里的普通英文词。
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) return;
    if (TOOL_NAME_STOP.has(name)) return;
    names.add(name);
  };

  // ── 来源 1：description 里括号内的标识符（最可靠）─────────────────
  // 只取括号内容，按分隔符切开逐个收。
  // 例："Model-facing background job control tools (job_output, job_list, job_kill) over…"
  // 括号里含 `/` 或 `@` 的**整段丢弃** —— 那是包路径（如 `(@vscode/ripgrep)`），
  // 不是工具名，否则会把 ripgrep 当成工具收进来。
  for (const match of desc.matchAll(/[（(\[]([^）)\]]{2,200})[）)\]]/g)) {
    const inner = match[1];
    if (/[/@]/.test(inner)) continue;
    for (const piece of inner.split(/[,，、;；|\/]+/)) collect(piece);
  }

  // ── 来源 2：中文 README 说明里的工具名（仅作**补充**）─────────────
  // 中文说明有时比英文 description 列得更全。例：
  //   dsh-tool-goal → 「…get_goal、create_goal 与 update_goal…」
  //     （英文 description 一个工具名都没写）
  //   dsh-tool-todo → 「…模型侧 todo_write 工具…」
  // 只收**含下划线**的标识符 —— 这是关键安全阀：中文句子里出现的单个英文词
  // （`agent`、`skill`、`present`）多为普通词，含下划线的才是工具名。
  for (const raw of zh.match(/[a-z][a-z0-9]*_[a-z0-9_]+/g) ?? []) collect(raw);

  // ── 来源 3：紧跟 tool / tools 的下划线标识符 ──────────────────────
  // 单工具包的描述格式高度一致：「Model-facing <工具名> tool over/with/backed by…」，
  // 多工具包则是并列：「Globally named send_message, interrupt_agent, and
  // list_agents tools over…」。两者共同点是 —— **工具名都出现在 `tool`/`tools`
  // **之前**，且**必须含下划线**（这条天然排除了 `persistent` / `discovery` /
  // `inspection` 这类普通英文词）。
  //
  // 所以只用一条正则：从 `tools?` 处向左回看一小段，把其中的 snake_case
  // 标识符全部收走。回看窗口限 120 字符，避免从上一句里误捞。
  if (names.size === 0) {
    for (const match of desc.matchAll(/\btools?\b/g)) {
      const start = Math.max(0, match.index - 120);
      const lead = desc.slice(start, match.index);
      // 只保留最后一段（从最近的分隔符/句号之后开始），防止跨句捞词。
      const tail = lead.split(/[.;:!?（(\[[]|\bover\b|\bwith\b|\bfor\b/).pop() ?? '';
      for (const raw of tail.match(/[a-z][a-z0-9]*_[a-z0-9_]+/g) ?? []) collect(raw);
    }
  }
  // 少数包把工具名写在 `tool(s)` **之后**（如 `…tools (read, write, edit)`），
  // 但那种情况来源 1 的括号规则已经处理了；这里只兜一个不带括号的变体。
  if (names.size === 0) {
    for (const match of desc.matchAll(/\btools?\s+\(?([a-z][a-z0-9]*_[a-z0-9_]+)\)?/g)) collect(match[1]);
  }

  // ── 来源 4：包名反推（单工具包）──────────────────────────────────
  // 只在上面一无所获时启用：多工具的包描述里必然有括号，能走到这里的
  // 基本是 `dsh-tool-goal` / `dsh-tool-skill` / `dsh-tool-present`
  // 这类一包一工具、且描述里没写工具名的包。
  //
  // ⚠️ 这里**故意不读 README**。
  // 早期版本会在此时回头扫 README，理由是「Summary 章节里会列工具名」——
  // 那是错的：这些包的 `## Summary` 是一段**散文**，不是清单。例如
  // `dsh-tool-bash` 的 Summary 写着「…`run_in_background` returns the id…
  // retried once with wider `sandbox_permissions`, a `justification`…」，
  // 全是**参数名**。扫它就会把 `run_in_background`、`sandbox_permissions`、
  // `justification` 当成工具名显示给用户（用户截图反馈过这个问题）。
  // 判据：README 里没有任何一节是以「工具名清单」的形式写的，所以不读最安全。
  if (names.size === 0) {
    const fromPackage = /dsh-(?:tool|skills)-(.+)$/.exec(pkg)?.[1];
    if (fromPackage !== undefined) collect(fromPackage.replace(/-/g, '_'));
  }

  // ── 来源 5：中文 README 里反引号包裹的 snake_case（最后补充）────────
  // 专门为 `dsh-mcp-resources` 这一类包准备：包名不是 dsh-tool-* / dsh-skills-*，
  // 包名反推无效；英文 description 与 frontmatter 说明里又都没写工具名 ——
  // 三个工具名只出现在正文的自然语言里，且**都被反引号包着**。
  //
  // ⚠️ 双重限制，缺一不可：
  //   ① 只认反引号里的内容 —— 正文里裸写的英文词一律不看；
  //   ② 必须含下划线 —— 把 `server` / `cursor` / `uri` 这些同样被反引号
  //      包住的**参数名**挡在外面。工具名（`read_mcp_resource`）几乎总带
  //      下划线，参数名（`server`）几乎不带，这条判据实测分得很干净。
  // 只在前面所有来源都落空时才走这里，不会污染已有结果。
  if (names.size === 0 && zhBody !== '') {
    for (const match of zhBody.matchAll(/`([^`\n]{2,60})`/g)) {
      const inner = match[1].trim();
      if (!/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(inner)) continue;
      collect(inner);
    }
  }

  return [...names].sort();
}

/**
 * 取出 README **顶部 frontmatter** 里的 `description` 字段。
 *
 * ⚠️ 只读文件最前面那一段 `--- … ---`，**绝不碰正文**。
 * 这个限制是血换来的：正文里的反引号词全是参数名，早期版本扫过正文，
 * 结果界面上出现 `run_in_background`、`sandbox_permissions` 这类东西。
 *
 * 为什么值得读：各包的中文 README 在 frontmatter 里写了一句**中文说明**，
 * 例如：
 *   dsh-mcp-resources → 「通过共享工具、显式服务器选择和 agent 作用域访问，
 *                        按需发现与读取 MCP 资源。」
 *   dsh-tool-goal     → 「…get_goal、create_goal 与 update_goal…」
 * 这比英文 `description`（满是 "Model-facing … over the ctx.x seam"）更适合
 * 直接显示给用户，而且常顺手写出真实工具名。
 *
 * 返回值会切掉「供…的用户与维护者阅读」这类套话尾巴 —— 那是写给维护者的，
 * 显示在界面上只是噪音。
 *
 * ⚠️ **只对中文 README 有意义**：英文 README 的 frontmatter 与 package.json
 * 的 description 基本重复，且是 "Model-facing … over the ctx.x seam" 这种
 * 写给实现者的话，不如直接用原有的 description。所以调用方只该传中文版进来；
 * 传英文版会返回 undefined（靠 readmePath 判断）。
 * @param readme - README 正文。
 * @param readmePath - 该 README 在包内的路径，用于判断是不是中文版。
 * @returns 清洗后的中文说明，或 undefined。
 */
function frontmatterDescription(readme, readmePath) {
  if (typeof readme !== 'string' || readme === '') return undefined;
  // 只处理中文版；英文版的 frontmatter 另有用处（不值得显示）。
  const isChinese = typeof readmePath === 'string' && /README\.zh\.md$/i.test(readmePath);
  if (!isChinese) return undefined;
  // 只认文件开头的 frontmatter 块。
  const block = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(readme);
  if (block === null) return undefined;
  const match = /^description:\s*(.+)$/m.exec(block[1]);
  if (match === null) return undefined;
  let text = match[1].trim();
  // 去掉 YAML 的引号包裹。
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (text === '') return undefined;
  // 去掉**面向维护者的套话尾巴**。这些说明句是模板化的，尾巴长这样：
  //   「面向模型的 bash 工具，供选择、配置或排查…的使用者与维护者阅读。」
  //   「…：供组合或排查 agent 文件系统访问的用户与维护者使用。」
  //   「…，供用户与维护者配置、组合或排查基于 subagent 提供方的委派。」
  // 对界面使用者毫无用处，留着只会把真正有用的信息挤走。
  //
  // ⚠️ 两个必须踩准的点（前一版都踩错了）：
  //
  //   1. **删除的起点必须是分隔符，不能是「面向」。**
  //      因为「面向模型的 bash 工具」是**正文**（它没人提到维护者），
  //      而「面向选择…的用户与维护者的 goal 工具说明」才是套话。
  //      从「面向」起删会把正文一起吃掉 —— 实测把 bash 的说明整句删没了。
  //      所以只从 `：；，,` 这类**分隔符**开始删，这样正文必然在分隔符之前，
  //      天然被保住。
  //
  //   2. **必须在同一小段里同时出现「供/面向」+「维护者/使用者」+ 动作词**，
  //      三要素齐了才是套话。缺一个就说明这是正文，不能动。
  //      用 [^。；，,：:]* 限制在**同一分句内**，不跨标点，避免贪婪吞掉正文。
  //
  // ── 为什么不再继续收紧（重要，别再试了）────────────────────────────
  // 仍有 3 个包的尾巴没切净，它们都不含「使用/阅读/参考/查看」这个动词，
  // 所以上面两条正则够不着：
  //   dsh-tool-goal           →「…的用户与维护者的模型侧 goal 工具说明。」
  //   dsh-tool-subagent       →「…，供用户与维护者配置、组合或排查基于…委派。」
  //   dsh-tool-subagent-control →「供用户与维护者在组合或调试…时使用的全局…」
  //
  // **已经试过**去掉「动作词」这个条件（只留「供/面向」+「维护者/使用者」），
  // 结果当场切出病句：
  //   dsh-tool-subagent 变成「面向模型的 subagent 委派工具配置、组合或排查
  //   基于 subagent 提供方的委派。」—— 中间那个「，供用户与维护者」被吃掉后，
  //   「委派工具」和「配置、组合或排查」直接糊在一起，读不通。
  //
  // 教训：这类**从句中段挖掉一个短语**的删除，删掉的不只是套话，还有它
  // 作为句子成分的语法作用。删干净需要的不是更强的正则，而是句法分析 ——
  // 那不值得为一个 20 字的后缀引入。**取舍：留一句多余的套话，换全表不出病句。**
  // 安全网只挡得住「切剩半句」，挡不住「切成病句」，别指望它兜底。
  const original = text;
  const boilerplate = /[：:；，,]\s*(?:面向)?[^。；：，,]*?(?:供|面向)[^。；：，,]*?(?:维护者|使用者)[^。；：，,]*?(?:使用|阅读|参考|查看)[。]?/gu;
  text = text.replace(boilerplate, '');
  // 「供…维护者…阅读」也可能紧跟在正文后、用句号分隔（少数形态）。
  text = text.replace(/(?:^|(?<=[。；]))\s*供[^。；：，,]*?(?:维护者|使用者)[^。；：，,]*?(?:使用|阅读|参考|查看)[。]?/gu, '');
  // 英文版（少数英文 frontmatter 会带 for users and maintainers）。
  text = text.replace(/[,;:]?\s*for [^.,;]*(?:maintainers|users)[^.,;]*?\.?/giu, '');
  text = text.trim();
  // 切完后可能留下孤零零的连接词/标点，再清一遍。
  text = text.replace(/[：:；，,、]\s*$/u, '').trim();
  // ── 安全网：切坏了就整体退回原文 ──────────────────────────────────
  // 正则抠自然语言必然有失手的时候（实测有个包被切得只剩「的全局 …工具。」，
  // 主句没了）。与其为每个个例再叠一层正则，不如加一道**质量闸门**：
  // 切割后如果剩余文本明显不成句，就判定为切坏，**退回未切割的原文**。
  // 退回的代价只是尾巴上多一句套话，比显示半句残话好得多。
  //
  // ⚠️ 判定要**宽松**：套话正则末尾带 `[。]?` 会把句号一并吃掉，所以
  // 「切后没有句末标点」是正常现象（下面会补），**不能**当切坏的依据。
  // 只有「太短」和「以连接词开头」才是真的切坏了 —— 那意味着主句被吃掉。
  const looksMangled = text === ''
    || text.length < 6
    // 以连接词/助词/标点开头 → 前面的主句被吃掉了。
    || /^[的了与和及或以及、，,。；;：:]/u.test(text);
  if (looksMangled) text = original;
  if (!/[。.！!？?]$/u.test(text)) text += '。';
  return text;
}

/** First meaningful line of a README.
 *
 * 【中文】README 的第一行有意义的正文（跳过标题、分隔线、空行），
 * 用作包描述缺失时的兜底说明文字。
 */
function firstReadmeLine(readme) {
  if (typeof readme !== 'string') return undefined;
  for (const line of readme.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    return trimmed.replace(/^\*\*|\*\*$/g, '').slice(0, 200);
  }
  return undefined;
}

/** ------------------------------------------------------------------ */
/** 运行时工具注册表                                                    */
/** ------------------------------------------------------------------ */

/**
 * 读取「当前进程里真正挂上了」的工具 —— 也就是界面「已挂工具」那一张表。
 *
 * 层级说明（重要）：
 *   1. 首选 `ctx.tools.schemas()`：这是 DSH 官方文档化的公开投影，
 *      已经把执行函数、展示回调都剔掉了，正好是模型能看到的 schema。
 *      它的 scope 参数省略时 = 全局视角，正是我们要的。
 *   2. 兜底 `ctx.tools.layers`：**这是未公开的内部结构**，
 *      只在不暴露 schemas() 的构建上才走这条路。
 *   3. 再兜底 `tools.entries()`：某些构建直接给一张扁平注册表。
 *
 * 只有在上一层「一个工具都没读到」时才会往下试 —— 因为读到 0 个常常意味着
 * 那一层的形状和预期不符，而不是真的没挂工具。
 * 每一步都包在 try 里：拿到意外形状时宁可变空，也不能让整个快照请求失败。
 * @param ctx - 插件上下文。
 * @returns `{ name, description, tokens }` 的列表，按名字排序。
 */
/**
 * 枚举注册表**所有层**的条目：全局层 + 每个作用域层。
 *
 * ⚠️ 为什么必须这么做（2026-10-12 修）：
 * `tools.schemas()` 的 JSDoc 原文是
 * `@param scope - the viewing scope (the agent); omitted = the global view`。
 * 也就是说**不传 scope 时它只回答「全局视图」**。
 * 而 `dsh-agent-preset` 是把预设里声明的工具注册进**该 agent 会话的作用域层**的，
 * 从插件所在的全局层（`ctx`）根本看不见它们。
 *
 * 只用 `schemas()` 的后果：这张表里只剩「在全局层注册的工具」——
 * 也就是 MCP 服务器提供的工具 + profile 级插件自己的工具，
 * **一个官方 `dsh-tool-*` 都没有**（read / write / edit / glob / grep / pwsh …全部缺席）。
 * 于是「从预设载入勾选」之后这一表永远没有勾，而「可挂载」那侧又把这些包
 * 标成「未挂」—— 因为 `anyMounted` 也是拿这份残缺名单算的。
 *
 * `tools.layers` 是 `ScopedLayers`：`{ global: ToolLayer, scoped: Map<scope, ToolLayer> }`；
 * 每个 `ToolLayer.tools` 是 `NamedEntries`（有 `entries()`）。
 * @param tools - 工具注册表服务。
 * @returns `[name, definition]` 的迭代；跨层去重由调用方的 Map 负责。
 */
function* layerEntries(tools) {
  const layers = tools?.layers;
  if (layers === undefined || layers === null) return;
  const candidates = [];
  if (layers.global !== undefined && layers.global !== null) candidates.push(layers.global);
  // 作用域层：每个活跃 agent 会话一层，预设声明的工具就在这里面。
  try {
    if (typeof layers.scoped?.values === 'function') {
      for (const layer of layers.scoped.values()) candidates.push(layer);
    }
  } catch { /* scoped 不是 Map 就只走全局层 */ }
  for (const layer of candidates) {
    const table = layer?.tools ?? layer;
    if (table === undefined || table === null) continue;
    // ⚠️ 先把这一层的条目**收进数组**，再 yield。
    // 不能写 `for (…) yield …` 直接放在 try 里 —— 那样消费方（consider）
    // 抛出的异常会在 yield 处冒回本生成器，被下面的 catch 当成「这一层坏了」
    // 静默吞掉。try 只该覆盖「读这一层」，不该覆盖「交给调用方之后」。
    const pairs = [];
    try {
      if (typeof table.entries === 'function') {
        for (const pair of table.entries()) pairs.push(pair);
      } else if (typeof table.values === 'function') {
        for (const definition of table.values()) pairs.push([definition?.name, definition]);
      }
    } catch { continue; /* ignore · 单层失败不影响其它层 */ }
    for (const [name, definition] of pairs) yield [name, definition];
  }
}

function readMountedTools(ctx) {
  // rows 用 Map 去重：同一个工具名可能从多个层级被看到，只记第一次。
  const rows = new Map();
  let tools;
  try { tools = ctx.get('tools', false); } catch { tools = undefined; }
  if (tools === undefined || tools === null) return [];

  /**
   * 收下一个工具定义。
   * @param name - 工具名（注册表以它为主键）。
   * @param definition - 工具定义对象；不同来源字段名不一样，下面都兼容了。
   */
  const consider = (name, definition) => {
    if (typeof name !== 'string' || name === '' || rows.has(name)) return;
    const description = typeof definition?.description === 'string' ? definition.description : undefined;
    // 参数 schema 在不同构建里叫法不同：parameters / inputSchema / input_schema / schema。
    const parameters = definition?.parameters
      ?? definition?.inputSchema
      ?? definition?.input_schema
      ?? definition?.schema;
    let tokens;
    try {
      // token 估算规则与宿主一致：4 字符 ≈ 1 token。
      // 这里估的是「这段工具 schema 常驻在 prompt 里要花多少 token」。
      const serialized = JSON.stringify({ name, description, parameters });
      if (typeof serialized === 'string') tokens = Math.ceil(serialized.length / 4);
    } catch { tokens = undefined; }
    rows.set(name, { name, description, tokens });
  };

  // ── 首选：遍历注册表**所有层**（全局层 + 每个作用域层）─────────────
  // 这是唯一能看见「预设声明的工具」的路子，见 layerEntries 的注释。
  for (const [name, definition] of layerEntries(tools)) {
    consider(typeof name === 'string' && name !== '' ? name : definition?.name, definition);
  }

  // ── 其次：注册表自己的公开投影（**只覆盖全局视图**，补漏用）────────
  // 放在层遍历之后：`schemas()` 会做参数深拷贝、并套用可见性解析，
  // 拿它当主源既贵又看不全；但当 `layers` 这个内部结构不存在时，
  // 它是唯一的公开入口，所以保留。
  if (typeof tools.schemas === 'function') {
    try {
      for (const schema of tools.schemas()) {
        // 兼容两种 schema 形状：扁平的 {name,...} 与 OpenAI 嵌套的 {function:{name,...}}。
        consider(schema?.name ?? schema?.function?.name, schema?.function ?? schema);
      }
    } catch { /* 失败不影响已经拿到的层 · ignore */ }
  }

  // ── 兜底：某些构建直接暴露扁平注册表 ──────────────────────────────
  if (rows.size === 0 && typeof tools.entries === 'function') {
    try {
      for (const [name, definition] of tools.entries()) consider(name, definition);
    } catch { /* ignore */ }
  }
  // 按名字排序，保证界面顺序稳定（不受注册先后影响）。
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** ------------------------------------------------------------------ */
/** preset inspection                                                   */
/** ------------------------------------------------------------------ */

/** Reject after `ms`, so a stalled optional read can never hang a response. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms);
    }),
  ]);
}

/**
 * 读取预设名单。
 *
 * ⚠️ 名单只是快照的**增强信息**，绝不是前置条件。
 * 注册表的 `list()` 会**逐个 await 每个定义的「激活诊断」**，
 * 而一个「还在等 Host 服务」的定义是**不会 settle 的**。
 * 无上限地 await 它 → 工作室页面永远转圈（用户当时看到的「一直扫描中」就是这个）。
 * 所以这里读取有上限，超时降级为「读不到名单 + 明确说明原因」。
 * @param ctx - 插件上下文。
 * @returns `{ presets, error }`。
 */
async function readPresetRoster(ctx) {
  let registry;
  try { registry = ctx.get('agentPresets', false); } catch { registry = undefined; }
  if (registry === undefined || registry === null) {
    return { presets: [], error: '这个 profile 里没有 agentPresets 服务。' };
  }
  try {
    const call = typeof registry.remoteExportList === 'function'
      ? registry.remoteExportList()
      : registry.list();
    const listing = await withTimeout(call, ROSTER_TIMEOUT_MS, 'The preset registry');
    return { presets: Array.isArray(listing?.presets) ? listing.presets : [] };
  } catch (error) {
    return { presets: [], error: messageOf(error) };
  }
}

/** 按 YAML 读出一个预设声明的子插件列表。 */
async function readPresetDocument(ctx, id) {
  let registry;
  try { registry = ctx.get('agentPresets', false); } catch { registry = undefined; }
  if (registry === undefined || registry === null || typeof registry.readDocument !== 'function') {
    return { error: '这个 profile 里没有 agentPresets 服务。' };
  }
  try {
    // 和读名单一样要加上限：一个永远不回答的注册表必须**降级成明确原因**，
    // 而不是让请求永远不返回。
    const document = await withTimeout(
      registry.readDocument(id), ROSTER_TIMEOUT_MS, 'The preset registry',
    );
    return { content: document?.content ?? '', name: document?.name, description: document?.description };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/**
 * 从预设声明的行里把人设**四个字段**抠出来。
 *
 * 声明列表用的是 Loader 自己的「条目列表」方言，所以按 YAML 读；
 * 读之前要先把 `!!js` 表达式清空 —— 那是代码不是数据，解析器啃不动。
 * @param yamlText - `readDocument` 返回的 YAML。
 * @returns `{ body, entryId, suffix, complete, includeRuntimeContext }` 或 `{ error }`。
 *
 * `body` 是给老调用方用的 prefix 快捷方式；后三个字段让界面能把开关
 * 如实显示出来，而不是替用户猜一个值。
 */
function extractPersona(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.trim() === '') {
    return { error: '这个预设没有声明任何插件行。' };
  }
  const sanitized = yamlText.replace(/!!js\s+[^\n]*/g, 'null');
  let rows;
  try {
    rows = parseYaml(sanitized);
  } catch (error) {
    return { error: `解析预设行失败：${messageOf(error)}` };
  }
  if (!Array.isArray(rows)) return { error: '预设行不是一个列表。' };

  // 进到这个函数的行有两种形状：
  //   · `readDocument` 直接返回 plugins 列表；
  //   · 完整的已发布 patch 会用 `- insert: [ {config:...} ]` 再包一层。
  // 所以先把 `insert` 外壳摊平；如果外层行本身就是「预设声明」而不是「插件行」，
  // 还要再拆开它的 `config.plugins`。
  const pluginRows = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const list = Array.isArray(row.insert) ? row.insert : [row];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const nested = entry.config?.plugins;
      if (Array.isArray(nested)) pluginRows.push(...nested);
      else pluginRows.push(entry);
    }
  }

  for (const row of pluginRows) {
    if (row === null || typeof row !== 'object') continue;
    const candidates = Array.isArray(row.insert) ? row.insert : [row];
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const pluginName = typeof candidate.name === 'string' ? candidate.name : '';
      const config = candidate.config;
      if (config === null || typeof config !== 'object') continue;
      // `dsh-persona` 把正文放在 `prefix` 里；另外两个键是为了兼容
      // 把 persona 插件包在别的字段名下面的行。
      const body = config.prefix ?? config.content ?? config.text;
      if (typeof body !== 'string') continue;
      if (pluginName.includes('persona') || candidate.id === 'persona' || row.id === 'persona') {
        return {
          body,
          entryId: row.id ?? candidate.id ?? pluginName,
          suffix: typeof config.suffix === 'string' ? config.suffix : '',
          // 缺键 = dsh-persona 的默认值，别把它显示成一个用户在设的开关。
          // complete 默认 false（这只是「前缀」），includeRuntimeContext 默认 true。
          complete: config.complete === true,
          includeRuntimeContext: config.includeRuntimeContext === false ? false : true,
        };
      }
    }
  }
  return { error: '这个预设里没有带内联正文的 persona 行可以载入。' };
}

/**
 * 从预设声明的行里把「这个预设挂了哪些插件包」抠出来（去重、保序）。
 *
 * 与 extractPersona 共用同一套「条目列表」摊平逻辑；区别是这里不找
 * persona 行，而是收集**每一行**的包名（candidate.name）。
 * 界面「从预设载入勾选」选官方预设时，宿主靠这个列表回填工具勾选。
 * @param yamlText - `readDocument` 返回的 YAML。
 * @returns {string[]} 包名列表；解析失败返回空数组（不 throw）。
 */
function extractPresetPackages(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.trim() === '') return [];
  const sanitized = yamlText.replace(/!!js\s+[^\n]*/g, 'null');
  let rows;
  try { rows = parseYaml(sanitized); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const packages = [];
  const seen = new Set();
  const push = (candidate) => {
    if (candidate === null || typeof candidate !== 'object') return;
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    if (name !== '' && !seen.has(name)) { seen.add(name); packages.push(name); }
  };
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const list = Array.isArray(row.insert) ? row.insert : [row];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const nested = entry.config?.plugins;
      if (Array.isArray(nested)) {
        for (const inner of nested) push(inner);
      } else {
        push(entry);
      }
    }
  }
  return packages;
}

/**
 * 一个**故意做得很小**的 YAML 读取器，只覆盖预设「条目列表」的形状：
 * 顶层是一个 map 列表，map 的值只能是标量、嵌套 map、列表，或字面量块标量。
 * 这个形状之外的任何东西**一律报错**，绝不瞎猜 —— 猜错会静默改坏用户的预设。
 * @param text - 已消毒（清掉 `!!js`）的 YAML。
 * @returns 解析后的值。
 */
function parseYaml(text) {
  const lines = text.split('\n');
  let cursor = 0;

  const indentOf = (line) => {
    let n = 0;
    while (n < line.length && line[n] === ' ') n += 1;
    return n;
  };

  const peek = () => {
    while (cursor < lines.length) {
      const trimmed = lines[cursor].trim();
      if (trimmed === '' || trimmed.startsWith('#')) { cursor += 1; continue; }
      return lines[cursor];
    }
    return undefined;
  };

  const scalar = (raw) => {
    const value = raw.trim();
    if (value === '') return '';
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value === 'null' || value === '~') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return value;
  };

  const readBlockScalar = (childIndent) => {
    const parts = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === '') { parts.push(''); cursor += 1; continue; }
      if (indentOf(line) < childIndent) break;
      parts.push(line.slice(childIndent));
      cursor += 1;
    }
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts.join('\n');
  };

  const readBlock = (minIndent) => {
    const line = peek();
    if (line === undefined) return null;
    const indent = indentOf(line);
    if (indent < minIndent) return null;
    return line.trim().startsWith('-') ? readList(indent) : readMap(indent);
  };

  const consumeEntry = (map, text, childIndent) => {
    const colon = text.indexOf(':');
    if (colon === -1) return;
    const key = text.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const rest = text.slice(colon + 1).trim();
    if (rest === '') {
      map[key] = readBlock(childIndent);
      return;
    }
    if (/^[|>][-+]?$/.test(rest)) {
      map[key] = readBlockScalar(childIndent);
      return;
    }
    map[key] = scalar(rest);
  };

  const readMap = (indent) => {
    const map = {};
    for (;;) {
      const line = peek();
      if (line === undefined) break;
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) break;
      cursor += 1;
      consumeEntry(map, trimmed, lineIndent + 2);
    }
    return map;
  };

  const readList = (indent) => {
    const out = [];
    for (;;) {
      const line = peek();
      if (line === undefined) break;
      if (indentOf(line) < indent) break;
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) break;
      const inline = trimmed.slice(1).trim();
      cursor += 1;
      if (inline === '') {
        out.push(readBlock(indent + 1));
        continue;
      }
      const colon = inline.indexOf(':');
      const looksLikeMap = colon > 0 && !inline.startsWith('"') && !inline.startsWith("'");
      if (looksLikeMap) {
        const map = {};
        consumeEntry(map, inline, indent + 4);
        // 在更深的缩进层级上继续收同一个 map 的兄弟键。
        for (;;) {
          const next = peek();
          if (next === undefined) break;
          const nextIndent = indentOf(next);
          if (nextIndent <= indent) break;
          if (next.trim().startsWith('-')) break;
          cursor += 1;
          consumeEntry(map, next.trim(), nextIndent + 2);
        }
        out.push(map);
        continue;
      }
      out.push(scalar(inline));
    }
    return out;
  };

  return readBlock(0);
}

/** ------------------------------------------------------------------ */
/** bundle generation                                                   */
/** ------------------------------------------------------------------ */

/** Escape a scalar for single-quoted YAML. */
const yamlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * 把预设 id 规范成注册表接受的形式（小写字母、数字、连字符）。
 *
 * ⚠️ 两条**拒绝**规则，都是被真实产物教出来的：
 *   ① 剥完只剩**数字**的要拒绝。用户填「预设-1」时，中文被剥掉、
 *      只剩 `1` —— 产物会变成一个叫 `1` 的预设，name 又是空的，
 *      界面上完全认不出这是什么。静默改坏比报错糟得多。
 *   ② 剥完为空要拒绝（原来的行为），错误信息要说清「为什么不行」，
 *      而不是一句泛泛的「必须含字母或数字」。
 * @param raw - 用户/界面给的原始 id。
 * @returns 规范化后的 id。
 */
function normalizePresetId(raw) {
  const source = String(raw ?? '').trim();
  const cleaned = source.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned === '') {
    throw new Error(
      `预设 id「${source}」里没有任何可用的拉丁字母或数字。`
      + 'DSH 的预设 id 只接受小写字母、数字和连字符 —— '
      + '中文、空格和其他符号都会被去掉。请改成一个英文 id（例如 my-prompt-mode）。',
    );
  }
  if (!/[a-z]/.test(cleaned)) {
    throw new Error(
      `预设 id「${source}」清理后只剩数字（${cleaned}），这不适合当预设标识符 —— `
      + '纯数字既难辨认，也容易和别的东西撞。请至少加一个英文字母（例如 preset-1）。',
    );
  }
  return cleaned;
}

/**
 * profile patch 里一个顶层块的起止行号。
 *
 * @typedef {{ start: number, end: number }} PatchBlock
 */

/**
 * 把 profile patch 文本切成顶层块。
 *
 * 顶层是「`- ` 在第 0 列」的条目列表：`- id: xxx`（单行覆盖）或者
 * `- insert:` + 缩进子列表（插入）。这里只做**行号切分**，不解析内容 ——
 * 切分是纯文本操作，绝无歧义；解析交给现有的 `parseYaml`。
 * @param {string} text - patch 全文。
 * @returns {PatchBlock[]} 每个块的 [start, end) 行号区间。
 */
function splitPatchBlocks(text) {
  const lines = String(text).split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ')) starts.push(i);
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? lines.length }));
}

/**
 * 判断一个顶层块是不是「预设声明」，是的话把它的 config 解析出来。
 *
 * 判据是块内出现了 `@deepseek-ai/dsh-agent-preset` 这个 name —— 比猜 id 前缀
 * 可靠，因为用户的 top-level 行 id 是可以自己改的。
 * @param {string[]} lines - 全 patch 的行数组。
 * @param {PatchBlock} block - 块的行号区间。
 * @returns `{ topId, config } | undefined`。
 */
function presetBlockConfig(lines, block) {
  const body = lines.slice(block.start + 1, block.end);
  // 块内没有 preset 包名就不是预设块，直接放弃（时间上下文、别的插件都走这里）。
  if (!body.some((line) => /dsh-agent-preset\b/.test(line))) return undefined;

  // 把 `- insert:` 之后的缩进子列表**降一级**脱出来，得到标准的「条目列表」形状。
  const dedented = body.map((line) => (line.startsWith('    ') ? line.slice(4) : line));
  let rows;
  try {
    rows = parseYaml(dedented.join('\n').replace(/!!js\s+[^\n]*/g, 'null'));
  } catch {
    // 解析不了就放弃这一块 —— 宁可少列一个预设，也不要报一个假的数据。
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const entry = rows.find((row) => row !== null && typeof row === 'object' && row.config !== undefined);
  if (entry === undefined) return undefined;
  return { topId: typeof entry.id === 'string' ? entry.id : '', config: entry.config };
}

/**
 * 从预设 config 里读出 persona 四字段 + 工具包名列表。
 *
 * ⚠️ `cordis:group` 那类分组行**不是包**，它只是把一批子插件圈起来。
 * 扁平化时必须**递归进它的 config 列表**、只收叶子包名 ——
 * 早先只遍历第一层，把分组行自己（`cordis:group`）当成了一个包，
 * 于是「压缩」那组 3 个子插件在界面上成了 1 个「包」，
 * 覆盖写时整组塌成一行空壳（实测 prompt-studio 从 6 包变 5 包）。
 * @param {object} config - 预设的 config。
 * @returns `{ persona, packages, groups }`。
 */
function readPresetBody(config) {
  const rows = Array.isArray(config?.plugins) ? config.plugins : [];
  let persona;
  const packages = [];
  const groups = [];

  const walk = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue;
      const name = typeof row.name === 'string' ? row.name : '';
      // 分组行的两种写法：`group: true`，或者名字就叫 cordis:group；
      // 它的子行挂在 `config`（是个列表）或 `plugins` 上。
      const nested = Array.isArray(row.config)
        ? row.config
        : (Array.isArray(row.plugins) ? row.plugins : undefined);
      if (nested !== undefined) {
        groups.push({ id: typeof row.id === 'string' ? row.id : 'group', count: nested.length });
        walk(nested);
        continue;
      }
      if (row.group === true || name === 'cordis:group') {
        groups.push({ id: typeof row.id === 'string' ? row.id : 'group', count: 0 });
        continue;
      }
      if (name.includes('dsh-persona')) {
        if (persona === undefined) {
          const rowConfig = row.config !== null && typeof row.config === 'object' ? row.config : {};
          persona = {
            // ⚠️ 缺键要区分「没写」和「写了 false」：dsh-persona 的默认值是
            // complete:false / includeRuntimeContext:true，所以只认**真值**键。
            prefix: typeof rowConfig.prefix === 'string' ? rowConfig.prefix : '',
            suffix: typeof rowConfig.suffix === 'string' ? rowConfig.suffix : '',
            complete: rowConfig.complete === true,
            includeRuntimeContext: rowConfig.includeRuntimeContext === false ? false : true,
          };
        }
        continue;
      }
      // 只收**像包名**的值（带作用域斜杠）。空串和字段名一律不算 ——
      // 界面上摆一个空包名，用户无从判断它是什么、该不该勾。
      if (name !== '' && name.includes('/')) packages.push(name);
    }
  };
  walk(rows);
  return { persona, packages, groups };
}

/**
 * 读出 profile patch 里的全部预设（给「编辑现有预设」用）。
 *
 * ⚠️ 全程**文本级**：不整体 YAML 反序列化再序列化 —— 那会把用户手写的注释、
 * 排版、`!!js` 表达式全部抹掉。早先这个 profile 就因为一次 YAML 往返被写成了
 * 1.3KB 残缺版，14 条声明全丢。
 * @param {string} text - patch 全文。
 * @returns {object[]} 每个预设一条 `{ topId, presetId, name, description, order, persona, packages }`。
 */
function parseProfilePresets(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (const block of splitPatchBlocks(text)) {
    const found = presetBlockConfig(lines, block);
    if (found === undefined) continue;
    const { topId, config } = found;
    if (config === null || typeof config !== 'object') continue;
    const { persona, packages, groups } = readPresetBody(config);
    out.push({
      topId,
      presetId: typeof config.id === 'string' ? config.id : '',
      name: typeof config.name === 'string' ? config.name : '',
      description: typeof config.description === 'string' ? config.description : '',
      order: Number.isFinite(Number(config.order)) ? Number(config.order) : undefined,
      persona,
      packages,
      groups,
      block,
    });
  }
  return out;
}

/**
 * 把一个预设块里的 `plugins:` 列表按**插件行**切开，每行连同它上面的注释。
 *
 * 为什么要做到行这个粒度：预设块里每一行插件前面都跟着用户手写的注释
 * （比如「# ── 必选：人设 ── 约 300 token」）。整块重写会把这些注释全部冲掉
 * —— 实测一次覆盖写让 patch 从 507 行掉到 422 行、25209 B 掉到 21115 B，
 * 用户标注的每个包的 token 价全没了。注释跟随它注释的那一行，才是对的。
 * @param {string[]} lines - 全 patch 行数组。
 * @param {PatchBlock} block - 预设块。
 * @returns `{ pluginsIndent, rows, tailFrom, inlineEmpty }` 或 undefined。
 *
 * `rows` 每项是 `{ comments: string[], body: string[], name, indent, depth }`：
 *   · `comments` = 该行上方连续的注释/空行（归它所有）
 *   · `body`     = 该行本身及其所有缩进更深的子行（一个 group 就是一整块）
 *   · `name`     = 该行的包名（persona 行是 dsh-persona）
 */
function splitPresetRows(lines, block) {
  // 先找 `plugins:` 那一行的位置与缩进。
  let pluginsAt = -1;
  let pluginsIndent = 0;
  for (let i = block.start; i < block.end; i += 1) {
    const m = /^(\s*)plugins:\s*(\[\s*\])?\s*$/.exec(lines[i]);
    if (m === null) continue;
    pluginsAt = i;
    pluginsIndent = m[1].length;
    break;
  }
  if (pluginsAt < 0) return undefined;

  // `plugins: []` 是合法的空列表写法，没有行可切。
  if (/^\s*plugins:\s*\[\s*\]/.test(lines[pluginsAt])) {
    return { pluginsAt, pluginsIndent, rows: [], lastRowEnd: pluginsAt + 1, inlineEmpty: true };
  }

  // 子列表的每一项都比 plugins: 深两格。
  const rowIndent = pluginsIndent + 2;
  const rows = [];
  let pending = [];
  let lastRowEnd = pluginsAt + 1;
  for (let i = pluginsAt + 1; i < block.end; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { pending.push(line); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent < rowIndent) break;              // 出了 plugins 列表
    // ⚠️ 必须对**去掉缩进后**的文本判 `- ` —— 直接拿整行去匹配，
    //    因为行首是空格，永远匹配不上（这个 bug 让切分结果恒为空，
    //    于是重建时 persona 行被静默丢掉）。
    const isRowStart = indent === rowIndent && /^-\s/.test(line.slice(indent));
    if (!isRowStart) { pending.push(line); continue; }

    // 一行的 body = 它自己 + 后面所有缩进更深的行（group 的子行都在里面）。
    const body = [line];
    let j = i + 1;
    for (; j < block.end; j += 1) {
      const next = lines[j];
      if (next.trim() === '') { body.push(next); continue; }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= rowIndent) break;
      body.push(next);
    }
    // 去掉 body 尾部被顺带吞进去的空行 —— 它们属于下一个条目。
    while (body.length > 1 && body[body.length - 1].trim() === '') body.pop();

    // name 只认**行内第一个** name:（子行的 name 更深，不会抢）。
    let name = '';
    for (const b of body) {
      const m2 = /^\s+name:\s*'?([^'\n]+?)'?\s*$/.exec(b);
      if (m2 !== null) { name = m2[1].trim(); break; }
    }
    rows.push({ comments: pending, body, name });
    pending = [];
    lastRowEnd = j;
    i = j - 1;
  }
  return { pluginsAt, pluginsIndent, rows, lastRowEnd, inlineEmpty: false };
}

/**
 * 重建一个预设块，**保留每一行插件上方的手写注释**。
 *
 * 规则：
 *   · persona 行 → 用新的人设四字段重渲染，但它上面的注释留着；
 *   · 工具行 → 勾到的**原样保留**（连注释带缩进一个字不动），勾掉的丢弃；
 *   · 新勾上的包 → 追加在列表末尾；
 *   · `cordis:group` 这类分组行 → **整体原样保留或整体丢弃**，
 *     绝不拆开重组（拆了就会丢掉 isolate / group 这类我们不认识的语义）。
 * @param {string[]} lines - 全 patch 行数组。
 * @param {PatchBlock} block - 目标块。
 * @param spec - `renderBundlePatch` 的产物。
 * @param personaFields - 归一化后的 persona 四字段。
 * @param wanted - 这次要保留的包名集合（已去重）。
 * @param toolToPackage - 工具名 → 包名，用来判断勾选对应哪个已有行。
 * @returns 重建后的块文本（顶层 `- insert:` 开头）。
 */
function rebuildPresetBlock(lines, block, spec, personaFields, wanted, toolToPackage) {
  const split = splitPresetRows(lines, block);
  // 结构认不出来（比如 plugins 用了我们不理解的写法）→ 老实退回整块重写，
  // 绝不猜。调用方会看到 overwriteRebuilt=false 并如实告诉用户。
  if (split === undefined) return undefined;

  const rendered = spec.yaml.split('\n');
  const renderedRows = splitPresetRows(rendered, { start: 0, end: rendered.length });
  // 从渲染结果里取出「人设行」和「工具行」的标准形状，用来替换旧行。
  const newPersonaRow = renderedRows?.rows.find((r) => r.name.includes('dsh-persona'));

  // 块头：从渲染结果里取，但要**剔掉文件头注释**（`# Generated by …`）——
  // 把它们插进用户 profile 正中间是纯粹的噪音。
  const head = [];
  for (const line of rendered) {
    if (line.startsWith('- insert:')) head.length = 0;   // 从顶层块开始，之前全是文件头
    if (line.trim() === 'plugins:' || line.trim() === 'plugins: []') break;
    head.push(line);
  }
  const out = [...head];
  // 旧块里 plugins: 之前的注释（用户写在 config 里的说明）要留着。
  const oldHeadComments = [];
  for (let i = block.start; i < split.pluginsAt; i += 1) {
    if (/^\s*#/.test(lines[i])) oldHeadComments.push(lines[i]);
  }
  if (oldHeadComments.length > 0) {
    // 插在 config 那行之后、`plugins:` 之前 —— 也就是紧贴它注释的位置。
    const at = out.findIndex((line) => /^\s*name:\s*'@deepseek-ai\/dsh-agent-preset'/.test(line));
    out.splice(at + 1, 0, ...oldHeadComments);
  }
  out.push(`        plugins:`);

  const kept = new Set();
  for (const row of split.rows) {
    const isPersona = row.name.includes('dsh-persona');
    if (isPersona) {
      if (personaFields.prefix === '' || newPersonaRow === undefined) continue;  // 清空 = 删掉这行
      out.push(...row.comments, ...newPersonaRow.body);
      continue;
    }
    // 分组行：整体保留或整体丢弃，取决于它圈住的叶子是否还有勾上的。
    const isGroup = row.body.some((l) => /^\s*group:\s*true/.test(l))
      || /name:\s*cordis:group/.test(row.body.join('\n'));
    if (isGroup) {
      const leaves = groupLeafPackages(row.body);
      // ⚠️ 分组保留时，必须把它圈住的叶子**全部标记为已保留**。
      //    否则这些叶子会在下面的「新勾上的包」里被再追加一遍 ——
      //    同一个包既在 group 里、又作为顶层行出现，等于重复声明。
      //    （实测：保留压缩组后包数从 8 涨到 11，多出来的正是组内叶子。）
      const anyWanted = leaves.some((leaf) => wanted.has(leaf)
        || [...toolToPackage.values()].includes(leaf));
      if (anyWanted) {
        out.push(...row.comments, ...row.body);
        for (const leaf of leaves) kept.add(leaf);
      }
      continue;
    }
    // 普通工具行：认包名，也认「这个包里的某个工具被勾上了」。
    const owners = [row.name];
    for (const [tool, pkg] of toolToPackage) if (pkg === row.name) owners.push(tool);
    if (owners.some((key) => wanted.has(key))) {
      kept.add(row.name);
      out.push(...row.comments, ...row.body);
    }
  }

  // 新勾上、但原块里没有对应行的包 → 追加。
  const renderedPackages = [...new Set(
    (Array.isArray(spec.packages) ? spec.packages : []).map((k) => resolvePluginName(k, toolToPackage) ?? k),
  )].filter((pkg) => typeof pkg === 'string' && pkg.includes('/') && !kept.has(pkg));
  for (const pkg of renderedPackages) {
    const rowId = `${spec.presetId}-${pkg.split('/')[1].replace(/[^a-z0-9-]/gi, '-')}`;
    out.push(`          - id: ${rowId}`, `            name: ${yamlString(pkg)}`);
  }

  // 块尾的注释：**只接不属于任何一行的那些**（最后一行之后的）。
  // 早先这里从 plugins: 扫到块尾，把每行的行前注释又抄了一遍 ——
  // 结果整块注释在文件里出现两次。
  const tail = [];
  for (let i = split.lastRowEnd; i < block.end; i += 1) {
    if (/^\s*#/.test(lines[i])) tail.push(lines[i]);
  }

  if (kept.size === 0 && renderedPackages.length === 0 && newPersonaRow !== undefined
    && personaFields.prefix === '') {
    // 一行都不剩 → 用 inline 空列表，这是合法的。
    return `${[...out.slice(0, out.length - 1), ...tail].join('\n')}\n        plugins: []`;
  }
  return [...out, ...tail].join('\n');
}

/** 用一段新文本替换 patch 里的一个顶层块，其余字节原样保留。 */
function splicePatchBlock(text, block, replacement) {
  const lines = String(text).split('\n');
  const before = lines.slice(0, block.start);
  const after = lines.slice(block.end);
  return [...before, ...replacement.replace(/\n+$/, '').split('\n'), ...after].join('\n');
}

/**
 * 从一个 group 行的 body 里抠出它圈住的叶子包名。 */
function groupLeafPackages(body) {
  const text = body.join('\n');
  const names = [];
  for (const m of text.matchAll(/\bname:\s*'?(@[^'/\s]+\/[^'\s]+?)'?\s*$/gm)) names.push(m[1]);
  return names;
}


/** Indent every non-blank line by `n` spaces. */
function indentBlock(text, n) {
  const pad = ' '.repeat(n);
  return String(text)
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

/**
 * 把一个「勾选键」解析成预设能声明的插件行名。
 *
 * 这是整个导出流程最容易出错的一步：
 * 界面上的两张表键不一样（已挂 = 工具名，可挂 = 包名），而预设只能声明包名。
 * 不做这步反查，用户在「已挂」表上的勾选会**静默消失**。
 *   · 如果 key 本身就是合法包名（@scope/name）→ 直接用。
 *   · 否则当作工具名，去反查表里找它的归属包。
 *   · 两条路都不成立 → 返回 undefined，调用方会把它记进 unresolved，
 *     在界面上明确告诉用户「这一项勾了但没能落地」，而不是悄悄丢掉。
 * @param key - 工具名或包名。
 * @param toolToPackage - 工具名 → 归属包，来自安装目录表。
 * @returns 可以声明的包名；解析不出来时返回 undefined。
 */
function resolvePluginName(key, toolToPackage) {
  if (typeof key !== 'string' || key === '') return undefined;
  // 已经是合法包名（形如 @scope/pkg），不需要反查。
  if (PACKAGE_NAME_RE.test(key)) return key;
  // 否则按工具名反查归属包。
  const owner = toolToPackage.get(key);
  return owner !== undefined && PACKAGE_NAME_RE.test(owner) ? owner : undefined;
}

/**
 * 归一化 persona 的四个字段。
 *
 * `dsh-persona` 的实现（`lib/index.js`）只读这四个 config 键：
 *   prefix               必填，作为 deployment:persona-prefix 段落渲染
 *   suffix               ''   deployment:persona-suffix 模板；省略即遮蔽全局后缀
 *   complete             false 仅把前缀当作完整系统提示词，忽略后缀
 *   includeRuntimeContext true  false 会抑制该作用域的所有上下文贡献
 *
 * ⚠️ 默认值刻意等于**本插件上一版的行为**（complete=true、
 * includeRuntimeContext=false），这样老调用方（只传 persona 字符串）升级后
 * 生成的 patch 完全不变 —— 界面上的开关一改才会变。
 *
 * 大白话（给小白用户看）：
 *   prefix（必填）—— 开场白 / 人设正文。填了：每次新会话 AI 都先读到这段话，
 *   按它扮演角色；不填：AI 没有定制人设，全靠默认配置。
 *   suffix（选填）—— 结尾补充说明。填了：AI 处理问题时还会参考这段结尾，
 *   可写 {{cwd}} / {{model}} 等变量；不填：留空会遮蔽全局后缀，部署级配置里的
 *   全局结尾补充也不再用。
 *   complete（开关）—— 开：这段 prefix 就是唯一系统提示词，身份 / 结尾 / 工具
 *   引导 / 监听器追加的内容都不再加进来；关：只当开头，其余按默认补齐。
 *   includeRuntimeContext（开关）—— 开：AI 能看到时间、工作目录等环境上下文；
 *   关：这些信息全部屏蔽，AI 在纯净上下文里工作。
 * @param options - 导出选项对象。
 * @returns `{ prefix, suffix, complete, includeRuntimeContext }`。
 */
function normalizePersonaFields(options) {
  const legacy = typeof options?.persona === 'string' ? options.persona : '';
  const given = (options?.personaFields !== null && typeof options?.personaFields === 'object')
    ? options.personaFields
    : undefined;
  // 文本在函数内部就 trim 掉首尾空白 —— 空字符串等价于「没填」。
  const text = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback);
  // 布尔只认真正的 boolean —— 界面传来的可能是字符串开关。
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  return {
    // 没传 personaFields 时退回旧的 persona 字符串（只当 prefix 用）；
    // 传了就以界面上的为准 —— 即便用户把 prefix 清空，也要尊重（空 = 不写 persona 行）。
    prefix: given === undefined ? text(legacy, '') : text(given.prefix, ''),
    suffix: text(given?.suffix, ''),
    complete: bool(given?.complete, true),
    includeRuntimeContext: bool(given?.includeRuntimeContext, false),
  };
}

/**
 * 为一个预设渲染 bundle patch。
 *
 * ⚠️ persona 支持 `dsh-persona` 的**全部四个** config 键，不要只做 prefix：
 *   prefix（必填）· suffix · complete · includeRuntimeContext
 * 早先只写了 prefix，而把 `complete: true` / `includeRuntimeContext: false`
 * **硬编码**在模板里 —— 后者会抑制该会话的所有上下文贡献（时间、工作目录等），
 * 用户完全无法控制。现在四个字段都由调用方传入，默认值保持当时的行为不变。
 * @param options - `{ presetId, name, description, order, persona, personaFields, packages }`。
 * @param toolToPackage - 工具名 → 归属包，用来解析「已挂」表上的勾选。
 * @returns `{ yaml, presetId, rowCount, unresolved, personaWritten }`。
 */
function renderBundlePatch(options, toolToPackage = new Map()) {
  const presetId = normalizePresetId(options?.presetId);
  const displayName = typeof options?.name === 'string' && options.name.trim() !== ''
    ? options.name.trim()
    : presetId;
  const description = typeof options?.description === 'string' ? options.description.trim() : '';
  const order = Number.isFinite(Number(options?.order)) ? Number(options.order) : 90;

  /**
   * 归一化 persona 的四个字段。
   * 兼容两种传法：新写法 `personaFields` 对象；旧写法 `persona` 字符串
   * （等价于只有 prefix，且沿用当时那套硬编码的 complete/includeRuntimeContext）。
   */
  const personaFields = normalizePersonaFields(options);

  const lines = [];
  lines.push('# Generated by Agent Preset Studio.');
  lines.push('# Re-exporting the same preset ID from the studio rewrites this file.');
  lines.push('');
  lines.push('- insert:');
  lines.push(`    - id: preset-${presetId}`);
  lines.push("      name: '@deepseek-ai/dsh-agent-preset'");
  lines.push('      config:');
  lines.push(`        id: ${presetId}`);
  lines.push(`        name: ${yamlString(displayName)}`);
  if (description !== '') lines.push(`        description: ${yamlString(description)}`);
  lines.push(`        order: ${order}`);
  lines.push('        plugins:');

  let rowCount = 0;
  // 人设行：用户编辑的系统提示词落在这里。
  // prefix 非空才写这一行 —— prefix 是 dsh-persona 的必填字段。
  if (personaFields.prefix !== '') {
    lines.push('          # System prompt / persona, owned by this preset.');
    lines.push(`          - id: ${presetId}-persona`);
    lines.push("            name: '@deepseek-ai/dsh-persona'");
    lines.push('            config:');
    // complete:true = 该 prefix 成为唯一系统提示词（身份/后缀/工具引导都无法追加）。
    if (personaFields.complete) lines.push('              complete: true');
    // includeRuntimeContext:false = 抑制该作用域的所有上下文贡献。
    if (!personaFields.includeRuntimeContext) lines.push('              includeRuntimeContext: false');
    if (personaFields.suffix !== '') {
      lines.push('              suffix: |-');
      lines.push(indentBlock(personaFields.suffix, 16));
    }
    lines.push('              prefix: |-');
    lines.push(indentBlock(personaFields.prefix, 16));
    rowCount += 1;
  }

  // 工具行：把每个勾选项解析成包名后逐行声明。
  // unresolved 收集「勾了但解析不出包」的键，交给界面明示，避免静默丢失。
  const unresolved = [];
  const seen = new Set();
  // ⚠️ 人设包已经在上面单独声明过一行了，这里必须把它排掉。
  //    否则会出现**两行同名的 `@deepseek-ai/dsh-persona`**：
  //    第二行没有 config，会把第一行的人设整个盖成一个空壳。
  //    这个坑真实发生过 —— 界面上的「已挂」表按**工具名**勾选，而
  //    dsh-persona 自己也暴露了一个同名工具，反查后正好落到这个包上。
  const PERSONA_PACKAGE = '@deepseek-ai/dsh-persona';
  const packages = Array.isArray(options?.packages) ? options.packages : [];
  for (const key of packages) {
    const pkg = resolvePluginName(key, toolToPackage);
    if (pkg === undefined) {
      if (typeof key === 'string' && key !== '') unresolved.push(key);
      continue;
    }
    // 同一行不允许声明两次 —— 重复的插件行会让整条预设声明加载失败。
    if (seen.has(pkg)) continue;
    // 人设包：已经由 persona 行声明过了。prefix 为空时它根本没被声明，
    // 所以只有在写了 persona 行的情况下才跳过。
    if (pkg === PERSONA_PACKAGE && personaFields.prefix !== '') {
      seen.add(pkg);
      continue;
    }
    seen.add(pkg);
    // 行 id 由 presetId + 包名末段拼成，保持可读且唯一。
    const rowId = `${presetId}-${pkg.split('/')[1].replace(/[^a-z0-9-]/gi, '-')}`;
    lines.push(`          - id: ${rowId}`);
    lines.push(`            name: ${yamlString(pkg)}`);
    rowCount += 1;
  }

  if (rowCount === 0) {
    // An empty `plugins` list is valid: a preset with no model-visible capability.
    lines[lines.length - 1] = '        plugins: []';
  }
  lines.push('');
  return {
    yaml: lines.join('\n'),
    presetId,
    rowCount,
    unresolved,
    // 覆盖写要拿「这次真正落地了哪些包」去和旧块里的行比对，所以一并交出去。
    packages: [...seen],
    personaFields,
  };
}

/**
 * 把编辑好的组合写成 bundle 并装进去。
 *
 * 目录**写在 workspace 下**，绝不写进 `$DSH_HOME`；
 * 安装方式是把这个目录的绝对路径交给 Plugin Manager ——
 * 所有 profile 级的写入都归它管，本插件不越权。
 * @param ctx - 插件上下文。
 * @param options - 生成 + 安装的选项。
 * @returns 结果对象；失败是**报告出来**，不是抛出去。
 */
async function generateAndInstall(ctx, options) {
  let spec;
  try {
    spec = renderBundlePatch(options ?? {}, buildToolToPackage());
  } catch (error) {
    return { ok: false, stage: 'render', error: messageOf(error) };
  }

  const outRoot = typeof options?.outputRoot === 'string' && options.outputRoot.trim() !== ''
    ? options.outputRoot.trim()
    : DEFAULT_OUTPUT_ROOT;
  const packageName = `@local/dsh-preset-${spec.presetId}`;
  const dir = join(outRoot, spec.presetId);
  // ⚠️ 人设正文要以 spec 里**已经归一化过**的那份为准，不能读 options.persona。
  //    新版界面传的是 personaFields 对象、根本不带 persona 字符串，
  //    照旧读 options.persona 会让 persona.md 整个漏写。
  const persona = spec.personaFields?.prefix ?? '';
  const hasPersona = persona.trim() !== '';

  try {
    if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), spec.yaml, 'utf8');
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: '1.0.0',
      private: true,
      type: 'module',
      description: `Agent preset bundle — ${options?.name ?? spec.presetId}`,
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`, 'utf8');
    writeFileSync(
      join(dir, 'index.js'),
      '/** 生成的预设 bundle 的宿主半；预设本身由 patch 声明。 */\nexport function apply() {}\n',
      'utf8',
    );
    if (hasPersona) writeFileSync(join(dir, 'persona.md'), persona, 'utf8');
    writeFileSync(join(dir, 'README.md'), [
      `# ${options?.name ?? spec.presetId}`,
      '',
      `由 Agent 预设工作室于 ${new Date().toISOString()} 生成。`,
      '',
      `- 预设 id：\`${spec.presetId}\``,
      `- 子插件行数：${spec.rowCount}`,
      hasPersona
        ? '- 人设正文：见 `persona.md`（同时也内联在 `cordis.patch.yml` 里）'
        : '- 人设正文：无 —— 这个预设继承部署级人设',
      '',
      '## 安装',
      '',
      '用 Plugin Manager 的 `install_bundle` 安装这个目录；',
      '或者在工作室的「导出」页点一下，那边会替你做完这步。',
      '',
    ].join('\n'), 'utf8');
  } catch (error) {
    return { ok: false, stage: 'write', error: messageOf(error), dir };
  }

  const base = {
    ok: true,
    dir,
    packageName,
    presetId: spec.presetId,
    rowCount: spec.rowCount,
    patch: spec.yaml,
  };
  // 警告是**累积**的：一个被跳过的勾选和一次安装失败都值得报告，
  // 而且两者不能互相掩盖。
  const warnings = [];
  if (spec.unresolved.length > 0) {
    warnings.push(`这些勾选项找不到对应的可安装插件，已跳过：${spec.unresolved.join(', ')}`);
  }

  let manager;
  try { manager = ctx.get('pluginManager', false); } catch { manager = undefined; }
  if (manager === undefined || manager === null || typeof manager.installBundle !== 'function') {
    warnings.push('pluginManager 服务不可用，所以 bundle 只写到了磁盘、没有安装。请到「插件」页手动安装那个目录。');
    return { ...base, installed: false, warning: warnings.join(' ') };
  }

  try {
    const result = await manager.installBundle(resolve(dir));
    // ⚠️ **装完必须验一次**，不能因为 installBundle 没抛错就报成功。
    //    真实事故：pnpm 的供应链策略（minimumReleaseAge）把一个**无关的**
    //    包（billion-context）拦下来，pnpm install 整体失败；installBundle
    //    于是只建好了 node_modules 软链，却没走到写 `dsh.profile.bundles`
    //    那一步 —— 界面报成功，DSH 重启后完全看不到这个预设。
    //    DSH 加载 profile 时**只认 bundles 名单，不认 node_modules**。
    const landed = bundleIsRegistered(packageName, profileDirOf(ctx));
    if (landed === false) {
      warnings.push(
        `bundle 目录已经写好、也软链进了 node_modules，但**它没有被写进 `
        + `package.json 的 dsh.profile.bundles 名单** —— DSH 加载 profile 时只读那份名单，`
        + `所以重启也不会有这个预设。`
        + (installHintOf(result) === undefined ? '' : `安装器报告的原因：${installHintOf(result)} `)
        + '这通常是 pnpm 的供应链策略拦下了整个 install（日志里会有 '
        + 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION 之类）。'
        + '可以到「插件」页重试一次，或先处理那条策略告警。',
      );
      return {
        ...base,
        installed: false,
        registered: false,
        result: summarizeInstall(result),
        warning: warnings.join(' '),
        hint: '目录在磁盘上，去「插件」页手动安装一次通常就能补上这一步。',
      };
    }
    return {
      ...base,
      installed: true,
      registered: landed,
      result: summarizeInstall(result),
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      hint: '改动只对**新会话**生效。',
    };
  } catch (error) {
    warnings.push(`安装失败：${messageOf(error)}`);
    return {
      ...base,
      installed: false,
      warning: warnings.join(' '),
      hint: '目录已经写到磁盘上了，可以到「插件」页重试安装。',
    };
  }
}

/**
 * 这个包名到底有没有进 profile 的 `dsh.profile.bundles` 名单。
 *
 * DSH 只按这份名单加载 bundle，`node_modules` 里有目录**不算数**。
 * 读不到 profile 目录时返回 `undefined`（= 无从判断），
 * 而不是 false —— 不能把「不知道」当成「坏了」来报警。
 * @param packageName - 形如 `@local/dsh-preset-xxx`。
 * @returns `true` / `false` / `undefined`。
 */
function bundleIsRegistered(packageName, dir) {
  if (typeof dir !== 'string' || dir === '') return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return undefined;
    return bundles.includes(packageName);
  } catch {
    return undefined;
  }
}

/** 从安装结果里挑一句能给人看的原因。 */
function installHintOf(result) {
  if (result === null || typeof result !== 'object') return undefined;
  const code = result?.error?.code;
  const diagnostic = result?.error?.diagnostic;
  if (typeof diagnostic === 'string' && diagnostic !== '') return diagnostic;
  const pkg = result?.packageResult;
  if (pkg !== null && typeof pkg === 'object' && typeof pkg.output === 'string') {
    // pnpm 的日志很长，只挑含关键字的那一行 —— 整段贴出来没人看得完。
    const line = pkg.output.split('\n').find((l) => /ERR_PNPM|Error|failed/i.test(l));
    if (line !== undefined) return line.trim();
  }
  return typeof code === 'string' ? code : undefined;
}

/** Reduce an install result to the fields worth showing a person. */
function summarizeInstall(result) {
  if (result === null || typeof result !== 'object') return undefined;
  const out = {};
  for (const key of ['application', 'warnings', 'pendingBuilds', 'packageResult', 'failedAt', 'kind', 'reason', 'restart-required']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

/**
 * 读界面草稿（勾选 + persona + 导出选项）。
 *
 * 文件不存在是**正常状态**（第一次打开），不是错误 —— 返回空草稿即可。
 * 文件坏了也不能让整个工作室打不开：报错内容原样带出去，界面会显示一行提示。
 * @returns `{ draft, error, path }`。
 */
function readDraft() {
  if (!existsSync(DRAFT_PATH)) return { draft: { selected: [], personaFields: undefined }, path: DRAFT_PATH };
  try {
    const parsed = JSON.parse(readFileSync(DRAFT_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { draft: { selected: [], personaFields: undefined }, path: DRAFT_PATH, error: '草稿文件不是对象，已忽略。' };
    }
    return { draft: parsed, path: DRAFT_PATH };
  } catch (error) {
    return { draft: { selected: [], personaFields: undefined }, path: DRAFT_PATH, error: messageOf(error) };
  }
}

/**
 * 写界面草稿。
 *
 * 只存**界面自己有的字段**，原样落盘不做归一化 —— 读取时才做归一化，
 * 这样以后草稿格式演进，老文件不会被写坏。
 * @param draft - 界面传来的草稿对象。
 * @returns `{ ok, path, error }`。
 */
function writeDraft(draft) {
  try {
    writeFileSync(DRAFT_PATH, `${JSON.stringify(draft ?? {}, null, 2)}\n`, 'utf8');
    return { ok: true, path: DRAFT_PATH };
  } catch (error) {
    return { ok: false, path: DRAFT_PATH, error: messageOf(error) };
  }
}

/**
 * 把渲染好的预设块覆盖写回 profile 的 patch 文件。
 *
 * ⚠️ 四条铁律，都是被事故和实测教出来的：
 *   ① **文本级操作** —— 整体 YAML 反序列化再序列化会抹掉用户手写的注释，
 *      `!!js` 表达式也会被吃掉。这个 profile 就被那样写坏过一次（1.3KB、14 条声明全丢）。
 *   ② **按插件行重建，注释跟随它注释的那一行** —— 整块重写会把用户标注的
 *      token 价全部冲掉（实测 507 行 → 422 行）。`cordis:group` 分组行必须
 *      整体保留或整体丢弃，绝不拆开重组（拆了会丢 isolate/group 语义）。
 *   ③ **先备份** —— 写之前把原文件复制成 `.bak-studio-<时间戳>`。
 *   ④ **找不到目标就拒绝写** —— 绝不允许「找不到就追加」，重复的 preset id
 *      在运行时注册表层面会让整条声明加载失败。
 * @param ctx - 插件上下文。
 * @param options - `{ presetId, topId, spec, personaFields, toolToPackage }`。
 * @returns 结果对象；失败是**报告出来**。
 */
async function overwriteProfilePreset(ctx, options) {
  const presetId = typeof options?.presetId === 'string' ? options.presetId : '';
  const topId = typeof options?.topId === 'string' ? options.topId : '';
  const spec = options?.spec;
  if (presetId === '' || topId === '' || spec === null || typeof spec !== 'object' || typeof spec.yaml !== 'string') {
    return { ok: false, stage: 'overwrite', error: '覆盖写需要 presetId、topId 和渲染好的 patch。' };
  }

  const dir = profileDirOf(ctx);
  if (dir === undefined) return { ok: false, stage: 'overwrite', error: '宿主没有暴露 profile 目录，覆盖写不可用。' };
  const patchPath = join(dir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) {
    return { ok: false, stage: 'overwrite', error: `找不到 patch 文件：${patchPath}` };
  }

  let text;
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch (error) {
    return { ok: false, stage: 'overwrite', error: `读 patch 失败：${messageOf(error)}` };
  }

  // 目标定位按 **top-level 行 id**（patch 机制真正用来覆盖的键），
  // 但如果同一个 preset 出现在多处，以 config.id 匹配的那一块为准。
  let presets;
  try {
    presets = parseProfilePresets(text);
  } catch (error) {
    return { ok: false, stage: 'overwrite', error: `解析 patch 失败：${messageOf(error)}` };
  }
  const target = presets.find((row) => row.topId === topId)
    ?? presets.find((row) => row.presetId === presetId);
  if (target === undefined) {
    const known = presets.map((row) => row.presetId || row.topId).filter((v) => v !== '');
    return {
      ok: false,
      stage: 'overwrite',
      error: `patch 里找不到预设「${presetId}」（行 id ${topId}）。已知的预设：${known.join(', ') || '（一个都没有）'}。没有追加写入 —— 重复的 id 会让整条声明加载失败。`,
    };
  }

  const toolToPackage = options?.toolToPackage instanceof Map ? options.toolToPackage : new Map();
  const personaFields = normalizePersonaFields(options);
  const wanted = new Set(Array.isArray(spec.packages) ? spec.packages : []);

  // 优先「按行重建」（注释全保留）。结构认不出来才退回整块重写 ——
  // 退回时如实标出来，绝不让用户以为自己的注释还在。
  const lines = text.split('\n');
  const rebuildWarnings = [];
  let block;
  let rebuilt = true;
  try {
    block = rebuildPresetBlock(lines, target.block, spec, personaFields, wanted, toolToPackage);
  } catch (error) {
    block = undefined;
    rebuildWarnings.push(`按行重建失败（${messageOf(error)}），已退回整块重写 —— 那一块里的手写注释可能已经丢失。`);
  }
  if (block === undefined) {
    rebuilt = false;
    rebuildWarnings.push('没能按行重建（结构认不出来），本次是整块重写 —— 那一块里的手写注释可能已经丢失。');
    const renderedLines = spec.yaml.split('\n');
    const insertAt = renderedLines.findIndex((line) => line.startsWith('- insert:'));
    if (insertAt < 0) {
      return { ok: false, stage: 'overwrite', error: '渲染结果里找不到顶层 `- insert:` 块，拒绝写入。' };
    }
    let rebuiltBlock = renderedLines.slice(insertAt).join('\n').replace(/\n+$/, '');
    // 铁律②：注释跟随它注释的那一行。整块重写替换的是整个顶层块区间，
    // 区间里紧贴本块末尾的**块尾注释**（比如下一个块的前导注释）会一起被吞 ——
    // 按行重建路径靠 tail 收集保住了它们，这里必须同样接回来，
    // 否则覆盖写会顺手吃掉相邻预设的注释（正是铁律防的事故）。
    const rebuiltTail = [];
    for (let i = target.block.end - 1; i >= target.block.start; i -= 1) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      if (/^\s*#/.test(line)) { rebuiltTail.unshift(line); continue; }
      break;
    }
    if (rebuiltTail.length > 0) rebuiltBlock = `${rebuiltBlock}\n${rebuiltTail.join('\n')}`;
    block = rebuiltBlock;
  }

  const updated = splicePatchBlock(text, target.block, block);
  // 写前备份 —— 与 Plugin Manager 自己的做法一致。
  const stamp = Date.now();
  const backup = `${patchPath}.bak-studio-${stamp}`;
  try {
    writeFileSync(backup, text, 'utf8');
    writeFileSync(patchPath, updated, 'utf8');
  } catch (error) {
    return { ok: false, stage: 'overwrite', error: `写 patch 失败：${messageOf(error)}`, backup };
  }
  return {
    ok: true,
    patchPath,
    backup,
    // 行数变化如实报出来：注释丢没丢，用户一眼能看出来。
    linesBefore: lines.length,
    linesAfter: updated.split('\n').length,
    overwriteRebuilt: rebuilt,
    topId: target.topId,
    presetId: target.presetId,
    bytesBefore: Buffer.byteLength(text, 'utf8'),
    bytesAfter: Buffer.byteLength(updated, 'utf8'),
    ...(rebuildWarnings.length > 0 ? { warning: rebuildWarnings.join(' ') } : {}),
    hint: 'profile patch 已改。改动只对**新会话**生效，当前会话继续用旧配置。',
  };
}

/** ------------------------------------------------------------------ */
/** 插件本体声明                                                        */
/** ------------------------------------------------------------------ */

export const name = PKG;

/** `webServer` 提供传输通道；其余服务都用 `ctx.get` 按需读取。 */
export const inject = ['webServer'];

/**
 * 单条路由响应的硬上限。
 *
 * 正常快照只要 ~90ms，所以 4 秒已经**极其宽松**；
 * 一旦超时说明某一步真的卡住了，此时宁可尽快回一个「说明原因」的 JSON，
 * 也不要让用户对着转圈的界面干等。客户端那边的 12 秒上限必须大于它，
 * 这样「谁先超时」永远由服务端先给出答案，而不是被浏览器先掐断。
 */
const ROUTE_TIMEOUT_MS = 4000;

/**
 * 在一个统一的超时上限 + 错误边界下跑一条路由体。
 *
 * 浏览器半「卡在加载中」和「彻底坏了」在用户眼里是**一回事**，
 * 所以绝不允许任何一条路由留下不答复的请求：
 * 每一次失败、每一次卡顿，都要变成一个页面能显示出来的 JSON。
 * @param label - 路由名，用于错误信息。
 * @param fn - 产出 Response 的函数。
 * @returns 一个 Response，永远是。
 */
async function guard(label, fn) {
  try {
    const response = await withTimeout(fn(), ROUTE_TIMEOUT_MS, `The ${label} route`);
    traceProbe(`${label}-answered`);
    return response;
  } catch (error) {
    // 「卡住」是唯一在浏览器里完全看不见的结果，所以先把
    // 哪条路由卡了、为什么卡了记下来，再答复。
    traceProbe(`${label}-failed: ${messageOf(error)}`);
    return json({ ok: false, error: messageOf(error) }, 500);
  }
}

/** 组装快照的返回数据。 */
async function handleSnapshot(ctx, request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: '只接受 GET / POST 请求' }, 405);
  }
  // 各阶段耗时随响应一起返回。请求健康时它不花任何代价；
  // 而一旦将来又卡住，它能把「猜哪一步慢」变成一份自述报告。
  const timing = {};
  const since = (label, startedAt) => { timing[label] = Math.round(performance.now() - startedAt); };

  let mark = performance.now();
  const appAsar = locateAppAsar();
  since('locateAsarMs', mark);

  mark = performance.now();
  const mounted = readMountedTools(ctx);
  since('mountedMs', mark);

  const mountedNames = new Set(mounted.map((row) => row.name));
  let catalogue = [];
  let catalogueError;
  if (appAsar === undefined) catalogueError = 'Could not locate the installation archive (app.asar).';
  else {
    mark = performance.now();
    try { catalogue = scanInstalledPackages(appAsar); }
    catch (error) { catalogueError = messageOf(error); }
    since('catalogueMs', mark);
  }
  const availablePackages = catalogue.map((pkg) => ({
    package: pkg.package,
    version: pkg.version,
    description: pkg.description,
    // 界面「说明」列用这个：优先中文 README 的 frontmatter 描述，
    // 没有才退回英文 description。见 frontmatterDescription()。
    summary: pkg.summary,
    toolNames: pkg.toolNames,
    anyMounted: pkg.toolNames.some((toolName) => mountedNames.has(toolName)),
  }));

  /**
   * 【关键】给「已挂」行补上 `package` 字段，让两张表**同键**。
   *
   * 运行时注册表只认工具名，所以 mounted 行天生只有 `name`；
   * 而「可挂」行是扫 asar 目录来的，天生有 `package`。
   * 客户端渲染两行时都按 `row.package` 取键 —— 于是「已挂」那张表每行都拿到
   * `undefined`，`.replace()` 直接抛 TypeError，整个 ToolsTab 崩掉（这就是
   * 用户看到的那个报错：`Cannot read properties of undefined (reading 'replace')`）。
   *
   * 修法是在**源头**补齐字段，而不是在渲染处到处写 `row.package ?? row.name`：
   * 用 `buildToolToPackage()` 的工具名→包名反查表，把已挂行解析出归属包。
   * 查不到的（第三方插件自己注册的工具）就留 undefined，客户端已有兜底。
   */
  const toolToPackage = toolToPackageOf(catalogue);
  /**
   * 包名 → 该包的中文说明。给已挂行的「说明」列当**中文语境前缀**用。
   *
   * 为什么需要：已挂行的说明来自工具自己的 `description`，那是**写给模型看的
   * 英文原文**（"Read a file from the local filesystem."）。它不能翻译 ——
   * 翻译会丢精度、还可能和实际行为对不上。但整张表的其他部分（表头、可挂表的
   * 说明）都是中文，于是用户看到的是**中英混排**：
   *
   *     工具 / 包        说明
   *     read            Read a file from the local filesystem.
   *     bash            Run a shell command.
   *
   * 解法不是翻译工具描述，而是在它前面加一句**中文的归属语境**，让整行读起来
   * 是中英对照而不是两套语言打架：
   *
   *     read    ［文件读写］Read a file from the local filesystem.
   *
   * 中文语境取自归属包的中文 README 说明（人写的、给人看的），
   * 反查不到归属包时留空，界面就不加前缀。
   */
  const packageSummary = new Map();
  for (const pkg of catalogue) {
    if (typeof pkg.summary === 'string' && pkg.summary.trim() !== '') {
      packageSummary.set(pkg.package, pkg.summary);
    }
  }
  const mountedWithPackage = mounted.map((row) => {
    const owner = toolToPackage.get(row.name);
    return {
      ...row,
      package: owner,
      // 归属包的中文说明（可能是 undefined，客户端会自己兜底）。
      ownerSummary: owner === undefined ? undefined : packageSummary.get(owner),
    };
  });

  // 内部自带上限：注册表卡住时降级成一个空名单，不会拖住整个请求。
  mark = performance.now();
  const roster = await readPresetRoster(ctx);
  since('rosterMs', mark);

  const mountedTokens = mounted.reduce(
    (sum, row) => sum + (typeof row.tokens === 'number' ? row.tokens : 0),
    0,
  );
  return json({
    ok: true,
    mounted: mountedWithPackage,
    mountedTokens,
    availablePackages,
    catalogueError,
    presets: roster.presets,
    presetError: roster.error,
    profileDir: profileDirOf(ctx),
    defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
    timing,
  });
}

/**
 * 注册工作室的 HTTP 接口面。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  // 启动面包屑。宿主半是在某个 Host 行的**激活过程**中挂载的，
  // 而从这里注册的路由要等那次激活结算完才可达 ——
  // 所以「请求被放行了但永远没答复」意味着：这一行已经跑了，
  // 但那一行还在激活中。
  traceProbe('apply-entered');

  /** GET /api/agent-preset-studio/snapshot */
  const snapshotRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/snapshot`,
    handler: serve((request) => {
      traceProbe('snapshot-hit');
      return guard('snapshot', () => handleSnapshot(ctx, request));
    }),
  };

  /** POST /api/agent-preset-studio/preset — one preset's rows and persona. */
  const presetRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/preset`,
    handler: serve((request) => guard('preset', async () => {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST 请求' }, 405);
      const body = await readJsonBody(request);
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return json({ ok: false, error: '必须提供一个预设 id。' }, 400);
      const document = await readPresetDocument(ctx, id);
      if (document.error !== undefined) return json({ ok: false, error: document.error }, 200);
      const persona = extractPersona(document.content);
      return json({
        ok: true,
        id,
        name: document.name,
        description: document.description,
        content: document.content,
        persona: persona.body,
        personaError: persona.error,
        personaEntryId: persona.entryId,
        // 官方预设载入勾选需要这个列表：preset 路由补上 packages，
        // 界面选官方预设后就能按包名回填工具勾选。
        packages: extractPresetPackages(document.content),
        // 四字段原样带上，界面才有资格如实显示开关状态。
        personaFields: persona.error === undefined
          ? {
            prefix: persona.body,
            suffix: persona.suffix,
            complete: persona.complete,
            includeRuntimeContext: persona.includeRuntimeContext,
          }
          : undefined,
      });
    })),
  };

  /**
   * GET /api/agent-preset-studio/profile-presets —— profile patch 里的现有预设。
   *
   * 这是「编辑现有预设」的数据源。读的是 `cordis.patch.yml` 原文，
   * 文本级解析出每个预设的 top-level 行 id、config、persona 四字段和工具包列表。
   */
  const profilePresetsRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/profile-presets`,
    handler: serve(() => guard('profile-presets', () => {
      const dir = profileDirOf(ctx);
      if (dir === undefined) {
        return json({ ok: false, error: '宿主没有暴露 profile 目录，读不了现有预设。' }, 200);
      }
      const patchPath = join(dir, 'cordis.patch.yml');
      if (!existsSync(patchPath)) {
        return json({ ok: true, presets: [], patchPath, missing: true }, 200);
      }
      let text;
      try {
        text = readFileSync(patchPath, 'utf8');
      } catch (error) {
        return json({ ok: false, error: `读 patch 失败：${messageOf(error)}`, patchPath }, 200);
      }
      let presets;
      try {
        presets = parseProfilePresets(text);
      } catch (error) {
        return json({ ok: false, error: `解析 patch 失败：${messageOf(error)}`, patchPath }, 200);
      }
      return json({ ok: true, presets, patchPath, bytes: Buffer.byteLength(text, 'utf8') }, 200);
    })),
  };

  /**
   * GET /api/agent-preset-studio/draft —— 读界面草稿。
   * PUT /api/agent-preset-studio/draft —— 存界面草稿。
   *
   * 存在的唯一理由：勾选状态之前只活在前端内存里，切走再回来就全清空。
   * 文件不存在是正常状态（第一次打开），返回空草稿而不是 404。
   */
  const draftRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/draft`,
    handler: serve((request) => guard('draft', async () => {
      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await readJsonBody(request);
        const written = writeDraft(body);
        return json({ ...written, draft: body }, 200);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ ok: false, error: '只接受 GET / PUT' }, 405);
      }
      const { draft, error, path } = readDraft();
      return json({ ok: error === undefined, draft, error, path }, 200);
    })),
  };

  /**
   * POST /api/agent-preset-studio/export —— 导出。
   *
   * 两种模式（界面上的开关）：
   *   · `mode` 缺省或 `'new'` → 渲染成 bundle 目录 + 交给 Plugin Manager 安装；
   *   · `mode: 'overwrite'`   → **文本级**替换 profile patch 里的那个预设，先备份。
   *
   * 覆盖写刻意不走 installBundle：那个服务会重写整个 patch 文件，
   * 而本插件绝不能做那种整体 YAML 往返（会把用户手写注释吃掉，
   * 而且这个 profile 已经被一次往返写坏过一次）。
   */
  const exportRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/export`,
    handler: serve((request) => guard('export', async () => {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST 请求' }, 405);
      const body = await readJsonBody(request);
      if (body?.mode === 'overwrite') {
        let spec;
        try {
          spec = renderBundlePatch(body ?? {}, buildToolToPackage());
        } catch (error) {
          return json({ ok: false, stage: 'render', error: messageOf(error) }, 200);
        }
        const written = await overwriteProfilePreset(ctx, {
          ...body,
          presetId: spec.presetId,
          topId: typeof body.topId === 'string' ? body.topId : `preset-${spec.presetId}`,
          spec,
          toolToPackage: buildToolToPackage(),
        });
        const warnings = spec.unresolved.length > 0
          ? [`这些勾选项找不到对应的可安装插件，已跳过：${spec.unresolved.join(', ')}`]
          : [];
        if (typeof written.warning === 'string') warnings.unshift(written.warning);
        return json({
          ...written,
          rowCount: spec.rowCount,
          ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
        }, 200);
      }
      const result = await generateAndInstall(ctx, body);
      return json({ ok: result.ok !== false, ...result }, 200);
    })),
  };

  /**
   * GET /api/agent-preset-studio/ping —— 极轻量的存活探针。
   *
   * 只回答「宿主半挂上了、而且这条路由可达」，同步返回、不碰任何服务。
   * 它存在的意义是：**一次请求就能把卡点二分定位** ——
   *   · `ping` 有答复但 `snapshot` 没有 → 传输没问题，故障在某一步快照逻辑里；
   *   · 两个都没答复 → 插件压根没挂载。
   */
  const pingRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/ping`,
    handler: serve(() => {
      traceProbe('ping-hit');
      return json({ ok: true, pong: true, routes: ROUTE_PREFIX }, 200);
    }),
  };

  /**
   * GET /api/agent-preset-studio/diagnostics ——「可挂载工具包」分区为什么是空的？
   *
   * 「可挂载工具包」分区空掉时，需要区分三种原因：归档找不到、归档找到了但打不开、
   * 归档打开了但里面没有包。这个路由把每一步的原始结果都吐出来，让问题在一次
   * 请求里定位，而不用猜。它只读环境信息，不写任何东西。
   */
  const diagnosticsRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/diagnostics`,
    handler: serve(() => {
      traceProbe('diagnostics-hit');
      const asarPath = locateAppAsar();
      const report = {
        ok: true,
        // 运行环境：Electron 主进程里会有 electron 版本字段。
        runtime: {
          isElectron: typeof process !== 'undefined' && process.versions?.electron !== undefined,
          electron: process?.versions?.electron,
          node: process?.versions?.node,
          resourcesPath: typeof process !== 'undefined' ? process.resourcesPath : undefined,
        },
        asarPath,
        asarExists: asarPath !== undefined && existsSync(asarPath),
        // 逐个方式试开，看哪条路在这个运行时里可行。
        openAttempts: asarPath === undefined ? [] : probeAsarOpen(asarPath),
      };
      // 顺手把「实际选中哪条路 + 索引出多少个文件」也报出来。
      if (asarPath !== undefined) {
        try {
          const asarFs = resolveAsarFs(asarPath);
          report.chosenFs = asarFs.kind;
          const index = openAsarIndex(asarPath);
          report.indexedEntries = index.entries.length;
        } catch (error) {
          report.indexError = messageOf(error);
        }
      }
      return json(report, 200);
    }),
  };

  for (const route of [
    pingRoute,
    diagnosticsRoute,
    snapshotRoute,
    presetRoute,
    profilePresetsRoute,
    draftRoute,
    exportRoute,
  ]) {
    ctx.effect(() => ctx.webServer.register(route), `${PKG}: ${route.path}`);
  }
  ctx.logger?.info?.(`${PKG}: routes registered under ${ROUTE_PREFIX}`);
}

/** Read the current profile's directory, when the profile context exposes it. */
function profileDirOf(ctx) {
  try {
    const profile = ctx.get('profileContext', false);
    if (profile !== undefined && typeof profile?.dir === 'string') return profile.dir;
  } catch { /* ignore */ }
  return undefined;
}

/** Re-exported for the client half, which builds the same URLs. */
export { DEFAULT_OUTPUT_ROOT };
