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
