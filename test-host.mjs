/**
 * Functional test for the studio's host half.
 *
 * Exercises the pure pieces — the patch renderer, the tool→package resolver,
 * the persona extractor — through the real module, not a copy.
 * Run: node test-host.mjs
 */

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL('E:/deepseek/agent-preset-studio/lib/index.js').href);
const { apply, inject, name, ROUTE_PREFIX } = mod;

let pass = 0;
let fail = 0;
const check = (label, condition, detail) => {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
};

console.log('\n== module surface ==');
check('name is the package id', name === '@local/dsh-agent-preset-studio', name);
check('inject asks for webServer only', Array.isArray(inject) && inject.length === 1 && inject[0] === 'webServer', JSON.stringify(inject));
check('route prefix is under /api', ROUTE_PREFIX === '/api/agent-preset-studio', ROUTE_PREFIX);
check('apply is a function', typeof apply === 'function');

/** Build a fake ctx that records the routes a plugin registers. */
function fakeCtx() {
  const routes = [];
  const effects = [];
  const services = new Map();
  return {
    routes,
    effects,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    effect: (fn, label) => { effects.push(label ?? 'effect'); const d = fn(); return d ?? (() => {}); },
    get: (key) => services.get(key),
    provide: (key, value) => services.set(key, value),
  };
}

/**
 * Drive one registered route the way the real server does: call
 * `handler(req, res)` and collect what the handler writes to `res`.
 *
 * This is deliberately the *raw* contract, not a Fetch one. Routes that return
 * a Response without writing to `res` hang the real socket, so a harness that
 * only awaited the return value would pass while production hangs. `settled`
 * is therefore the important assertion: a route that never ends its response
 * fails here for the same reason it fails in the app.
 * @param route - a registered route.
 * @param options - `{ method, body }` for the synthetic request.
 * @returns `{ status, headers, body, settled }`.
 */
async function callRoute(route, options = {}) {
  const method = options.method ?? 'GET';
  const body = options.body === undefined ? undefined : String(options.body);
  const req = {
    method,
    url: route.path,
    headers: body === undefined
      ? {}
      : { 'content-length': String(Buffer.byteLength(body)) },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  };
  let settled = false;
  const result = { status: undefined, headers: {}, body: undefined, settled: false };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers ?? {};
      res.headersSent = true;
      return res;
    },
    end(text) {
      result.body = text;
      settled = true;
      result.settled = true;
    },
  };
  await route.handler(req, res);
  // A handler that returns without calling end() leaves the socket open, which
  // is exactly the bug this harness must be able to see.
  result.settled = settled;
  return result;
}

/** Parse a route response body as JSON. */
function jsonOf(result) {
  try { return JSON.parse(result.body); } catch { return undefined; }
}

console.log('\n== route registration ==');
const ctx = fakeCtx();
apply(ctx);
check('registers exactly 5 routes', ctx.routes.length === 5, String(ctx.routes.length));
const paths = ctx.routes.map((r) => r.path).sort();
check('routes are ping/diagnostics/snapshot/preset/export',
  JSON.stringify(paths) === JSON.stringify([
    '/api/agent-preset-studio/diagnostics',
    '/api/agent-preset-studio/export',
    '/api/agent-preset-studio/ping',
    '/api/agent-preset-studio/preset',
    '/api/agent-preset-studio/snapshot',
  ].sort()), JSON.stringify(paths));
check('all routes are exact kind', ctx.routes.every((r) => r.kind === 'exact'));
check('all routes expose a handler', ctx.routes.every((r) => typeof r.handler === 'function'));

console.log('\n== every route ends its raw http response ==');
// The server calls `handler(req, res)` and owns the socket. A handler that
// returns a Response instead of writing to `res` never ends the response, so
// the request hangs with nothing in the log. Assert the contract directly for
// every route rather than trusting one sample.
for (const route of ctx.routes) {
  const method = route.path.endsWith('/import') ? 'POST' : 'GET';
  const result = await callRoute(route, method === 'POST' ? { method, body: '{}' } : {});
  check(`${route.path.split('/').pop()} writes a status`,
    typeof result.status === 'number', String(result.status));
  check(`${route.path.split('/').pop()} calls res.end()`,
    result.settled === true && typeof result.body === 'string' && result.body !== '');
  check(`${route.path.split('/').pop()} sets a JSON content type`,
    String(result.headers['content-type'] ?? '').includes('application/json'),
    String(result.headers['content-type']));
  check(`${route.path.split('/').pop()} body parses as JSON`,
    jsonOf(result) !== undefined, String(result.body).slice(0, 120));
}

console.log('\n== the adapter is what prevents the hang ==');
// Guard against the exact regression that shipped once: a Fetch-shaped handler
// wired straight into the http route. Reproduce that wiring and show it never
// settles, so this test fails loudly if the adapter is ever bypassed.
const naiveResult = await (async () => {
  let ended = false;
  const req = { method: 'GET', url: '/x', headers: {}, async *[Symbol.asyncIterator]() {} };
  const res = { headersSent: false, writeHead() { return res; }, end() { ended = true; } };
  // The naive form: return a Response, never touch res.
  await (async () => new Response('{"ok":true}'))(req, res);
  return { ended };
})();
check('a Fetch-shaped handler alone never ends the response',
  naiveResult.ended === false, String(naiveResult.ended));
const guardedResult = await callRoute(ctx.routes.find((r) => r.path.endsWith('/ping')));
check('the shipped routes do end it', guardedResult.settled === true);


console.log('\n== ping route is a pure liveness probe ==');
// ping exists to separate "the plugin never mounted" from "one snapshot step is
// stuck", so it must answer without reading any service and without awaiting.
const pingRoute = ctx.routes.find((r) => r.path.endsWith('/ping'));
const pingResponse = await callRoute(pingRoute);
const pingBody = jsonOf(pingResponse);
check('ping answers 200', pingResponse.status === 200, String(pingResponse.status));
check('ping reports ok', pingBody?.ok === true, JSON.stringify(pingBody));
check('ping needs no service to answer', pingBody?.pong === true, JSON.stringify(pingBody));
check('ping ends its response', pingResponse.settled === true);

console.log('\n== snapshot route, with no services bound ==');
const snapshotRoute = ctx.routes.find((r) => r.path.endsWith('/snapshot'));
const snapshotResponse = await callRoute(snapshotRoute);
const snapshotBody = jsonOf(snapshotResponse);
check('snapshot answers 200', snapshotResponse.status === 200, String(snapshotResponse.status));
check('snapshot ends its response', snapshotResponse.settled === true);
check('snapshot reports ok', snapshotBody?.ok === true, JSON.stringify(snapshotBody).slice(0, 200));
check('mounted is an array', Array.isArray(snapshotBody?.mounted), typeof snapshotBody?.mounted);
check('mountedTokens is a number', typeof snapshotBody?.mountedTokens === 'number', String(snapshotBody?.mountedTokens));
check('availablePackages is an array', Array.isArray(snapshotBody?.availablePackages));
check('catalogue actually scanned something', snapshotBody.availablePackages.length > 0,
  `${snapshotBody.availablePackages.length} packages; error=${snapshotBody.catalogueError ?? 'none'}`);
check('defaultOutputRoot is set', typeof snapshotBody.defaultOutputRoot === 'string' && snapshotBody.defaultOutputRoot !== '', snapshotBody.defaultOutputRoot);
check('presetError names the missing service',
  typeof snapshotBody.presetError === 'string' && snapshotBody.presetError.includes('agentPresets'),
  snapshotBody.presetError);
check('snapshot reports per-stage timings',
  typeof snapshotBody.timing === 'object' && typeof snapshotBody.timing.catalogueMs === 'number',
  JSON.stringify(snapshotBody.timing));

console.log('\n== catalogue shape ==');
const sample = snapshotBody.availablePackages[0];
check('catalogue rows carry package', typeof sample?.package === 'string', JSON.stringify(sample)?.slice(0, 120));
check('catalogue rows carry toolNames', Array.isArray(sample?.toolNames), typeof sample?.toolNames);
check('catalogue rows carry anyMounted', typeof sample?.anyMounted === 'boolean');
const withTools = snapshotBody.availablePackages.filter((p) => p.toolNames.length > 0);
check('at least one package resolved tool names', withTools.length > 0, `${withTools.length} of ${snapshotBody.availablePackages.length}`);
console.log(`  info  catalogue: ${snapshotBody.availablePackages.length} packages, ` +
  `${snapshotBody.availablePackages.reduce((n, p) => n + p.toolNames.length, 0)} tool names`);

console.log('\n== catalogue tool names are real tool names, not parameter noise ==');
// 这组断言的由来：用户截图反馈「可挂」区每个包后面跟着一串
//   run_in_background, job_output, job_kill, sandbox_permissions, justification…
// —— 全是**参数名**。根因是本仓库的包 README **没有 Summary 章节**，
// 于是老实现每次都掉进「整篇 README 反引号词」兜底分支，把参数名一并收了。
// 现在改为从包的 description 里提取，下面把这条契约钉死。
const allNames = snapshotBody.availablePackages.flatMap((p) => p.toolNames);
// 一批**已知是参数名或配置字段**的词 —— 它们一旦出现在工具清单里就是回归。
const PARAM_NOISE = [
  'timeout', 'selected', 'custom', 'kind', 'offset', 'limit', 'file_path',
  'content', 'old_string', 'new_string', 'run_in_background', 'sandbox_permissions',
  'justification', 'wait', 'mode', 'header', 'options', 'label', 'description',
  'workdir', 'command', 'append', 'signal',
];
const leaked = allNames.filter((n) => PARAM_NOISE.includes(n));
check('no parameter names were mistaken for tool names',
  leaked.length === 0, leaked.join(', '));
check('tool names are snake_case identifiers',
  allNames.every((n) => /^[a-z][a-z0-9_]*$/.test(n)),
  allNames.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n)).join(', '));
// 逐包核对几个**已知事实**（值来自包自己的描述，不是猜的）：
//   dsh-tool-fs        → "filesystem tools (read, write, edit)"
//   dsh-tool-fs-search → "discovery tools (glob, grep) backed by … ripgrep"
//   dsh-tool-jobs      → "job control tools (job_output, job_list, job_kill)"
//   dsh-tool-web       → "web tools (web_search, web_fetch)"
const EXPECTED = new Map([
  // 值来自包自己的说明（中文 README frontmatter 优先，英文 description 兜底）。
  // dsh-tool-fs 的 read_image 只在中文说明里出现（英文 description 里没有），
  // 所以这条同时验证了「中文来源确实被用上了」。
  ['@deepseek-ai/dsh-tool-fs', ['edit', 'read', 'read_image', 'write']],
  ['@deepseek-ai/dsh-tool-fs-search', ['glob', 'grep']],
  ['@deepseek-ai/dsh-tool-jobs', ['job_kill', 'job_list', 'job_output']],
  ['@deepseek-ai/dsh-tool-web', ['web_fetch', 'web_search']],
  // ⚠️ 这一条是「来源 5」的守门断言，最容易再退化，必须钉死。
  // dsh-mcp-resources 全身上下没有一处「结构化」的工具名：
  //   · 包名不匹配 dsh-tool-* / dsh-skills-* → 来源 4 的包名反推对它无效
  //   · 英文 description 只描述功能（"Scoped MCP resource discovery…"）
  //   · 中文 frontmatter 说明也只描述功能，一个工具名都没写
  // 三个工具名**只出现在中文 README 的正文自然语言里**，且都被反引号包着。
  // 一旦有人「优化」掉来源 5，这里立刻变红。
  ['@deepseek-ai/dsh-mcp-resources', ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource']],
]);
for (const [pkg, want] of EXPECTED) {
  const row = snapshotBody.availablePackages.find((p) => p.package === pkg)
    ?? snapshotBody.availablePackages.find((p) => p.package === pkg) // 同上（可挂表按包名）
    ?? { toolNames: [] };
  // 表里可能因为「已挂」被过滤掉，那就从原始目录里找（mounted 行也带包名）。
  const fromMounted = snapshotBody.mounted.find((m) => m.package === pkg);
  const got = row.toolNames.length > 0 ? row.toolNames : (fromMounted?.toolNames ?? []);
  check(`${pkg.replace('@deepseek-ai/', '')} lists exactly ${JSON.stringify(want)}`,
    JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
// 括号里的包路径不能被当成工具名（`(@vscode/ripgrep)` 曾经混进来过）。
check('a parenthesised package path is not treated as a tool name',
  !allNames.includes('ripgrep') && !allNames.some((n) => n.includes('@')),
  allNames.filter((n) => n.includes('@')).join(', '));
check('a package with no stated tool list reports an empty array, not noise',
  snapshotBody.availablePackages.some((p) => Array.isArray(p.toolNames)));
// ⚠️ 用户截图里看到的「未标注」，直接来源就是某个包的 toolNames 是空数组 ——
// 界面在那种情况下只能显示占位语。现在 22 个包**全都**能报出工具名，
// 所以这条改成硬断言：不允许再有任何包报空。
// （历史上只有 dsh-mcp-resources 报空，根因是它的工具名藏在中文 README 正文里，
//   四条来源都够不着；见 extractToolNames 的来源 5。）
const emptyLists = snapshotBody.availablePackages
  .filter((p) => !Array.isArray(p.toolNames) || p.toolNames.length === 0)
  .map((p) => p.package);
check('no catalogue package reports an empty tool list any more',
  emptyLists.length === 0, emptyLists.join(', '));

console.log('\n== every catalogue row carries a human-readable summary ==');
// 用户原话：「你为啥要注释成"这个包没有标注工具清单"，你没法详细注释它的功能吗？」
// 于是宿主半除了工具名，还要给出**这句说明**，界面才有话可说。
// 来源优先中文 README 的 frontmatter（人写的、给人看的），
// 没有才退回 package.json 的英文 description。
const summarised = snapshotBody.availablePackages.filter(
  (p) => typeof p.summary === 'string' && p.summary.trim() !== '',
);
check('the summary field is present on every catalogue row',
  snapshotBody.availablePackages.every((p) => 'summary' in p));
check('nearly every package has a real summary, not an empty string',
  summarised.length >= snapshotBody.availablePackages.length - 1,
  `${summarised.length} of ${snapshotBody.availablePackages.length}`);
// 中文说明必须真的是中文 —— 否则说明列显示的还是很长的英文实现描述。
const chineseSummaries = summarised.filter((p) => /[\u4e00-\u9fff]/.test(p.summary));
check('most summaries are in Chinese (the README.zh frontmatter is preferred)',
  chineseSummaries.length >= summarised.length * 0.7,
  `${chineseSummaries.length} of ${summarised.length} are Chinese`);
// 中文说明里不能残留面向维护者的套话尾巴 —— 那是给维护者看的，不是给用户看的。
// ⚠️ 只做**软断言**：正则抠自然语言不可能 100%。实测有 3 个包的句式过于特殊
// （`dsh-tool-goal` 的套话嵌在句中间、`dsh-tool-subagent-control` 的套话在句首、
// `dsh-tool-subagent` 的尾巴与正文同句），切不干净。
// 与其为每个个例再叠正则（每叠一层就多一分误伤风险），不如接受少量残留：
// 留着一句啰嗦的套话，远好过把整句说明切没。安全网（looksMangled）会挡住
// 切坏的情况，所以这里只要求「大多数是干净的」。
const withBoilerplate = chineseSummaries.filter((p) => /维护者|使用者/.test(p.summary));
check('the maintainer-facing boilerplate is stripped from most summaries',
  withBoilerplate.length <= 3,
  `${withBoilerplate.length} of ${chineseSummaries.length}: `
    + withBoilerplate.map((p) => p.package.replace('@deepseek-ai/', '')).join(', '));
// 更重要的：**没有任何一条说明被切坏**（剩半句残话比留套话糟得多）。
check('no summary was mangled into a fragment by the boilerplate stripper',
  chineseSummaries.every((p) => p.summary.length >= 6
    && !/^[的了与和及或以及、，,。；;：:]/u.test(p.summary)),
  chineseSummaries.filter((p) => p.summary.length < 6
    || /^[的了与和及或以及、，,。；;：:]/u.test(p.summary))
    .map((p) => `${p.package}: ${p.summary}`).join(' | '));
// 说明不能是 "Model-facing … over the ctx.x seam" 这种写给实现者的话。
check('summaries are not raw implementation notes',
  chineseSummaries.some((p) => !/^Model-facing/.test(p.summary)));
check('the summary is distinct from the raw English description',
  snapshotBody.availablePackages.some(
    (p) => typeof p.summary === 'string' && p.summary !== p.description,
  ));

console.log('\n== export route: mounted tool names resolve to packages ==');
// Pick a package that has known tool names, then feed its TOOL names in.
const target = withTools[0];
const outRoot = mkdtempSync(join(tmpdir(), 'aps-test-'));
const exportRoute = ctx.routes.find((r) => r.path.endsWith('/export'));
const exportResponse = await callRoute(exportRoute, {
  method: 'POST',
  body: JSON.stringify({
    presetId: 'Test Studio Preset',
    name: 'Test Studio Preset',
    description: "It's a test",
    order: 77,
    persona: '# Persona\n\nLine one.\n\n  indented line\n',
    packages: [target.toolNames[0], target.package, 'not-a-package'],
    outputRoot: outRoot,
  }),
});
const exportBody = jsonOf(exportResponse);
check('export answers 200', exportResponse.status === 200, String(exportResponse.status));
check('export ends its response', exportResponse.settled === true);
check('export reports ok', exportBody?.ok === true, JSON.stringify(exportBody).slice(0, 300));
check('preset id normalized', exportBody.presetId === 'test-studio-preset', exportBody.presetId);
check('row count = persona + de-duplicated packages', exportBody.rowCount === 2, String(exportBody.rowCount));
check('unresolvable entry is warned about, not silently dropped',
  typeof exportBody.warning === 'string' && exportBody.warning.includes('not-a-package'), exportBody.warning);

const patch = readFileSync(join(outRoot, 'test-studio-preset', 'cordis.patch.yml'), 'utf8');
console.log('\n--- generated cordis.patch.yml ---');
console.log(patch);
console.log('--- end ---\n');

check('patch opens with - insert:', patch.includes('- insert:'));
check('preset row uses 4-space child indent', patch.includes('\n    - id: preset-test-studio-preset'));
check('declares the agent-preset package', patch.includes("name: '@deepseek-ai/dsh-agent-preset'"));
check('preset id inside config', patch.includes('        id: test-studio-preset'));
check('order rendered', patch.includes('        order: 77'));
check('single quotes escaped in YAML', patch.includes("It''s a test"), patch.match(/description:.*/)?.[0]);
check('persona uses an inline block scalar', patch.includes('              prefix: |-'));
check('persona body is indented 16', patch.includes('                # Persona'));
check('persona internal indentation survives', patch.includes('                  indented line'));
check('mounted tool name resolved to its package', patch.includes(`name: '${target.package}'`), target.package);
check('the package appears exactly once', (patch.match(new RegExp(`name: '${target.package.replace(/[/@]/g, '\\$&')}'`, 'g')) ?? []).length === 1);
check('row ids are prefixed with the preset id', patch.includes(`          - id: test-studio-preset-${target.package.split('/')[1]}`));

console.log('\n== export route: empty persona falls back to plugins: [] ==');
const bareRoot = mkdtempSync(join(tmpdir(), 'aps-bare-'));
const bareResponse = await callRoute(exportRoute, {
  method: 'POST',
  body: JSON.stringify({ presetId: 'bare', persona: '', packages: [], outputRoot: bareRoot }),
});
const bareBody = jsonOf(bareResponse);
const barePatch = readFileSync(join(bareRoot, 'bare', 'cordis.patch.yml'), 'utf8');
check('bare export succeeds', bareBody?.ok === true, JSON.stringify(bareBody).slice(0, 200));
check('bare export has zero rows', bareBody?.rowCount === 0, String(bareBody?.rowCount));
check('empty plugins list is written inline', barePatch.includes('        plugins: []'), barePatch.split('\n').slice(-6).join(' | '));
check('no persona row is emitted', !barePatch.includes('dsh-persona'));

console.log('\n== method guards ==');
const badMethod = await callRoute(snapshotRoute, { method: 'DELETE' });
check('snapshot rejects DELETE with 405', badMethod.status === 405, String(badMethod.status));
check('rejected requests still end their response', badMethod.settled === true);
const badExport = await callRoute(exportRoute, { method: 'GET' });
check('export rejects GET with 405', badExport.status === 405, String(badExport.status));
const badPreset = await callRoute(ctx.routes.find((r) => r.path.endsWith('/preset')), {
  method: 'POST',
  body: '{}',
});
const badPresetBody = jsonOf(badPreset);
check('preset route requires an id', badPresetBody?.ok === false && badPreset.status === 400, JSON.stringify(badPresetBody));

console.log('\n== a stalled registry must not hang the snapshot ==');
// The registry's list() awaits each definition's activation diagnostic, and a
// definition waiting on a Host service never settles. That is the bug that left
// the studio page spinning: reproduce it and prove the route still answers.
const stalled = fakeCtx();
apply(stalled);
stalled.provide('agentPresets', {
  remoteExportList: () => new Promise(() => {}),   // never settles
  readDocument: () => new Promise(() => {}),
});
const stalledRoute = stalled.routes.find((r) => r.path.endsWith('/snapshot'));
const startedAt = Date.now();
const stalledResponse = await callRoute(stalledRoute);
const elapsed = Date.now() - startedAt;
const stalledBody = jsonOf(stalledResponse);
check('snapshot still answers despite a stalled registry',
  stalledResponse.status === 200, String(stalledResponse.status));
check('it answers with ok: true (roster is only an enrichment)',
  stalledBody?.ok === true, JSON.stringify(stalledBody).slice(0, 200));
check('it gives up waiting well under the blanket route timeout',
  elapsed < 7000, `${elapsed} ms`);
check('the stall is reported as presetError, not swallowed',
  typeof stalledBody.presetError === 'string' && stalledBody.presetError.includes('did not answer'),
  stalledBody.presetError);
check('tools still come back when the roster stalls',
  Array.isArray(stalledBody.mounted) && Array.isArray(stalledBody.availablePackages),
  `mounted=${stalledBody.mounted?.length} available=${stalledBody.availablePackages?.length}`);
console.log(`  info  answered in ${elapsed} ms with a registry that never resolves`);

const stalledPresetRoute = stalled.routes.find((r) => r.path.endsWith('/preset'));
const stalledPreset = await callRoute(stalledPresetRoute, {
  method: 'POST',
  body: '{"id":"standard"}',
});
const stalledPresetBody = jsonOf(stalledPreset);
check('the preset route also answers instead of hanging',
  stalledPreset.status === 200, String(stalledPreset.status));
check('it reports the timeout rather than a generic failure',
  stalledPresetBody?.ok === false
  && typeof stalledPresetBody.error === 'string'
  && stalledPresetBody.error.includes('did not answer'),
  JSON.stringify(stalledPresetBody));

console.log('\n== mounted tools come from the registry\'s public projection ==');
// ctx.tools.schemas() is the documented call; the internal layer walk is only
// a fallback. Prove the public path is taken and both schema shapes are read.
const toolsCtx = fakeCtx();
apply(toolsCtx);
let schemasCalled = 0;
toolsCtx.provide('tools', {
  schemas: () => {
    schemasCalled += 1;
    return [
      { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
      // OpenAI-style nesting must also be understood.
      { type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object' } } },
    ];
  },
  // A bogus internal shape that must NOT be consulted when schemas() works.
  layers: { broken: { tools: { entries: () => { throw new Error('should not be reached'); } } } },
});
const toolsResponse = await callRoute(
  toolsCtx.routes.find((r) => r.path.endsWith('/snapshot')),
);
const toolsBody = jsonOf(toolsResponse);
check('schemas() was called', schemasCalled === 1, String(schemasCalled));
check('both schema shapes are read', toolsBody.mounted.length === 2,
  JSON.stringify(toolsBody.mounted.map((r) => r.name)));
check('flat schema keeps its name', toolsBody.mounted.some((r) => r.name === 'read' && r.description === 'Read a file'));
check('nested schema keeps its name', toolsBody.mounted.some((r) => r.name === 'write' && r.description === 'Write a file'));
check('every mounted row carries a token estimate',
  toolsBody.mounted.every((r) => typeof r.tokens === 'number' && r.tokens > 0),
  JSON.stringify(toolsBody.mounted.map((r) => r.tokens)));
check('mountedTokens sums the rows',
  toolsBody.mountedTokens === toolsBody.mounted.reduce((n, r) => n + r.tokens, 0),
  String(toolsBody.mountedTokens));
check('mounted rows are sorted by name',
  toolsBody.mounted.map((r) => r.name).join() === 'read,write');

// --- Mounted rows must carry a resolved `package` ----------------------
// The client renders both tables with `row.package`, but the runtime tool
// registry only knows tool *names*. Without this enrichment every mounted row
// yielded undefined and the render threw on `.replace`, blanking the tools tab.
console.log('\n== mounted rows gain a package for the shared render path ==');
check('every mounted row exposes a package field (possibly undefined)',
  toolsBody.mounted.every((r) => Object.prototype.hasOwnProperty.call(r, 'package')),
  JSON.stringify(toolsBody.mounted.map((r) => r.package)));
// `read`/`write` are shipped by a real package, so the reverse index should
// resolve at least one of them on this machine's actual install.
const resolvedPackages = toolsBody.mounted.map((r) => r.package).filter((p) => typeof p === 'string');
check('the reverse index resolves real owners from the install catalogue',
  resolvedPackages.length > 0 || toolsBody.availablePackages.length === 0,
  `resolved ${resolvedPackages.length} of ${toolsBody.mounted.length}; catalogue=${toolsBody.availablePackages.length}`);
check('the enrichment preserves the original tool name',
  toolsBody.mounted.every((r) => typeof r.name === 'string' && r.name !== ''));

// --- The archive index must not leak descriptors ------------------------
// shipped once as `return { entries, fd }` with no dispose: every scan leaked
// one handle. The process ran until EMFILE, after which a bare `catch {}`
// turned the failure into "no packages found" — an empty panel section with
// no error anywhere. Assert both halves of the fix.
console.log('\n== archive index hygiene ==');
const hostSource = readFileSync('E:/deepseek/agent-preset-studio/lib/index.js', 'utf8');
check('the index closes its header descriptor', /finally\s*\{[\s\S]{0,200}?closeSync\(fd\)/.test(hostSource));
check('the index holds no long-lived descriptor',
  !/\breturn\s*\{[^}]*\bfd\b[^}]*\}/.test(hostSource)
  && !/index\.fd\b/.test(hostSource));
check('a failed index open throws instead of silently yielding []',
  !/const index = openAsarIndex\(appAsar\);\s*\n\s*if \(index === undefined\) return \[\];/.test(hostSource));

// --- Electron's asar interception is worked around, and observable ------
// `fs.openSync('.../app.asar')` succeeds in plain Node but ENOENTs inside the
// Electron main process, where Electron's patched fs treats a `.asar` path
// segment as a directory. The plugin must prefer `original-fs` and keep a
// fallback, and it must be able to report which route it actually got.
console.log('\n== electron asar interception ==');
check('an unpatched-fs strategy exists', /function resolveAsarFs\(/.test(hostSource));
check('an unpatched-fs loader exists and is tried before the patched fs',
  /function loadOriginalFs\(/.test(hostSource)
  && /anchor\('original-fs'\)/.test(hostSource)
  && /const originalFs = loadOriginalFs\(\);/.test(hostSource));
check('the loader tries more than one resolution anchor',
  // 插件是经软链接安装的，import.meta.url 落在开发目录，找不到 Electron；
  // 必须用 process.execPath 兜底。
  /createRequire\(process\.execPath\)/.test(hostSource));
check('a trailing-slash alias is the documented fallback',
  /replace\(\/\\\.asar\$\/, '\.asar\/'\)/.test(hostSource));
check('the open strategy actually reports which route it took',
  /kind: 'original-fs'/.test(hostSource) && /kind: 'node-fs'/.test(hostSource));
check('every probe attempt closes the handle it opened',
  /finally\s*\{[\s\S]{0,120}?closeSync\(fd\)/.test(hostSource));
check('a diagnostics route reports why the catalogue is empty',
  /\/diagnostics`/.test(hostSource) && /probeAsarOpen\(/.test(hostSource));

console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
process.exit(fail === 0 ? 0 : 1);
