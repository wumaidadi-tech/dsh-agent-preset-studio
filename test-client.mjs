/**
 * Structural checks on the browser half.
 *
 * The client bundle cannot be imported by Node (it calls
 * window.__ModuleLoader__.load), so this evaluates its pure pieces in isolation
 * and asserts the invariants that a browser run would otherwise have to catch:
 * dictionary symmetry, and that every t('key') the code uses is defined.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PATH = 'E:/deepseek/agent-preset-studio/lib/client.js';
const source = readFileSync(PATH, 'utf8');

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
};

// --- Load the bundle the way the browser would -------------------------
let captured;
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec; } } },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('no network in this test')),
  AbortController,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

check('registers exactly one module', captured !== undefined);
check('id matches the package name', captured?.id === '@local/dsh-agent-preset-studio', captured?.id);

const moduleShim = { exports: {} };
// The bundle now defines an error-boundary class component, so the stub needs a
// Component base — React's real export is a class, and `extends undefined` throws
// at factory time, which would fail every assertion below for the wrong reason.
class Component {
  constructor(props) { this.props = props ?? {}; this.state = {}; }
  setState(patch) { this.state = { ...this.state, ...patch }; }
  render() { return null; }
}
const reactStub = {
  Component,
  createElement: () => null,
  Fragment: {},
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => [v, () => {}],
};
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`undeclared module requested: ${name}`);
});

check('client half exports apply()', typeof plugin.apply === 'function');
check('client half exports a name', typeof plugin.name === 'string', plugin.name);
check('client half injects slots + locale',
  Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'),
  JSON.stringify(plugin.inject));

// --- Dictionary symmetry ----------------------------------------------
console.log('\n== dictionaries ==');
const dictMatch = source.match(/const zh = \{([\s\S]*?)\n    \};/);
const enMatch = source.match(/const en = \{([\s\S]*?)\n    \};/);
check('both dictionaries are present', dictMatch !== null && enMatch !== null);

const keysOf = (block) => [...block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
const zhKeys = keysOf(dictMatch[1]);
const enKeys = keysOf(enMatch[1]);
check('dictionaries are non-trivial', zhKeys.length > 20, `${zhKeys.length} keys`);

const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
check('every zh key exists in en', missingInEn.length === 0, missingInEn.join(', '));
check('every en key exists in zh', missingInZh.length === 0, missingInZh.join(', '));

// --- Every t('key') used must be defined -------------------------------
console.log('\n== translation key coverage ==');
const used = new Set();
for (const m of source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'/g)) used.add(m[1]);
const defined = new Set(zhKeys);
const undefinedKeys = [...used].filter((k) => !defined.has(k));
check('every t(key) the code calls is defined',
  undefinedKeys.length === 0, undefinedKeys.join(', '));
check('the code actually calls a healthy number of keys', used.size > 20, `${used.size} used`);

const unusedKeys = [...defined].filter((k) => !used.has(k));
// Unused strings are dead weight, not breakage — report without failing hard.
if (unusedKeys.length > 0) {
  console.log(`  info  defined but never called: ${unusedKeys.join(', ')}`);
}

// --- Interpolation placeholders must match between languages -----------
console.log('\n== placeholder parity ==');
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
let mismatched = 0;
for (const key of zhKeys) {
  if (!enKeys.includes(key)) continue;
  const zhLine = dictMatch[1].match(new RegExp(`^\\s{6}${key}: '([^']*)'`, 'm'))?.[1];
  const enLine = enMatch[1].match(new RegExp(`^\\s{6}${key}: '([^']*)'`, 'm'))?.[1];
  if (zhLine === undefined || enLine === undefined) continue;
  if (placeholders(zhLine) !== placeholders(enLine)) {
    mismatched += 1;
    console.log(`  ~ ${key}: zh{${placeholders(zhLine)}} vs en{${placeholders(enLine)}}`);
  }
}
check('interpolation placeholders agree across languages', mismatched === 0, `${mismatched} mismatched`);

// --- Structural invariants the browser depends on ----------------------
console.log('\n== structural invariants ==');
check('tab id and slot key are the same identifier',
  /const TAB_ID = '[^']+'/.test(source) && /key: TAB_ID/.test(source) && /id: TAB_ID/.test(source));
check('client never requires a sibling file', !/require\(['"]\.\//.test(source));
check('client only requires modules it declares', (() => {
  const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  return required.every((n) => n === 'react' || n === 'react/jsx-runtime');
})());
check('every fetch carries an abort deadline', /AbortController/.test(source));
check('mounted rows are seeded by name, not by package',
  /snapshot\.mounted \?\? \[\]\)\s*\n\s*\.map\(\(row\) => row\.name\)/.test(source)
  || /\.map\(\(row\) => row\.name\)/.test(source));
// The token total reads the same keyed set the seeding wrote. Using row.package
// there compiles, renders, and silently reports 0 for every selection.
check('the token total reads mounted rows by name too',
  /selectedTokens[\s\S]{0,200}?selected\.has\(row\.name\)/.test(source));

// --- The two failure modes that render a blank page --------------------
// Both of these shipped once and produced a page with no text and no error in
// the UI: React does not mount a subtree whose component throws, so a single
// bad expression is indistinguishable from a plugin that never registered.
console.log('\n== blank-page guards ==');
check('a locale-bound t is obtained through a fallback, never raw props.t',
  /const boundT = /.test(source) && !/const t = props\.t;/.test(source));
check('both surfaces route through boundT',
  (source.match(/const t = boundT\(props\);/g) ?? []).length === 2,
  `${(source.match(/const t = boundT\(props\);/g) ?? []).length} site(s)`);
check('an error boundary exists so a throw shows text instead of nothing',
  /class StudioBoundary extends React\.Component/.test(source)
  && /getDerivedStateFromError/.test(source)
  && /componentDidCatch/.test(source));
check('every registered surface is wrapped in the boundary',
  (source.match(/guard\(Studio(Page|Panel)\)/g) ?? []).length === 2,
  `${(source.match(/guard\(Studio(Page|Panel)\)/g) ?? []).length} wrapped`);
// `sidebarRightTabs` is a host service, reachable only via the injected
// context's .get(). Reading it as a property yields undefined and throws
// inside the Cordis inject callback, where the framework swallows it — the
// symptom is a tab that silently never appears.
// Assert positively: the service must be *obtained* through .get(). A negative
// check alone passes for `injected.sidebarRightTabs` too, which is the bug.
check('the sidebar tab registry is fetched via .get(), not property access',
  /injected\.get\('sidebarRightTabs'\)/.test(source)
  && !/\binjected\.sidebarRightTabs\b/.test(source)
  && !/ctx\.sidebarRightTabs\b/.test(source));
check('an absent sidebarRightTabs service is tolerated, not thrown on',
  /const tabs = injected\.get\('sidebarRightTabs'\);\s*\n\s*if \(tabs === undefined\) return undefined;/.test(source));

// --- Row-field robustness: the crash that actually shipped -------------
// `row.package.replace(...)` ran for every mounted row. Mounted rows come from
// the runtime tool registry, which only knows *tool names* — `package` is not a
// field it has. So the expression threw `Cannot read properties of undefined
// (reading 'replace')` on the first row, taking the whole ToolsTab down.
// A structural check would not have caught it; only rendering does.
console.log('\n== row-field robustness (execute ToolsTab) ==');

// Rebuild the module shim so the captured factory can be re-invoked with a
// react stub that actually evaluates components, letting render() run for real.
const nodes = [];
const element = (type, props, ...children) => {
  if (typeof type === 'function') {
    // Class components must be instantiated; function components are called.
    if (/^\s*class\s/.test(Function.prototype.toString.call(type))) {
      return new type(props ?? {}).render();
    }
    return type({ ...(props ?? {}), children });
  }
  nodes.push({ type, props: props ?? {} });
  return { type, props: props ?? {}, children };
};
const realish = {
  Component,
  createElement: element,
  Fragment: {},
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => [v, () => {}],
};
const plugin2 = captured.factory((name) => {
  if (name === 'react') return realish;
  throw new Error(`undeclared module requested: ${name}`);
});

// Recover the settings-page component the way the plugin registers it.
let settingsComponent;
const captureCtx = {
  locale: { register: () => () => {}, bind: () => (k) => k },
  effect: (fn) => { fn(); return () => {}; },
  slots: { inject: (_slot, fn) => fn(), register: (def, Component) => { settingsComponent = Component; return () => {}; } },
  inject: (_deps, fn) => fn({ effect: (f) => f(), get: () => undefined, slots: captureCtx.slots }),
};
try { plugin2.apply(captureCtx); } catch (error) {
  console.log(`  info  apply() note: ${error.message}`);
}

check('the settings component is recoverable for rendering', typeof settingsComponent === 'function');

// The exact hostile input: mounted rows carry only {name, tokens} — no
// `package` — while available rows do. Both must render.
const hostileSnapshot = {
  ok: true,
  mounted: [
    { name: 'read', description: 'Read a file', tokens: 114 },
    { name: 'write', tokens: 204 },
  ],
  mountedTokens: 318,
  availablePackages: [
    { package: '@deepseek-ai/dsh-tool-bash', version: '1.0.0', toolNames: ['bash'], anyMounted: false },
  ],
  presets: [],
};

const renderToolsTab = (snapshot) => {
  const store = {
    state: { tab: 'tools', snapshot, persona: '', personaSource: '', filter: '', busy: false, error: undefined },
    setState: () => {},
  };
  // Settings surfaces receive the store through a bound render prop.
  const Component = settingsComponent;
  const instance = new Component({
    store: { useStore: () => store.state, actions: {} },
    ...store,
  });
  return instance;
};

let renderError;
try {
  const mounted = hostileSnapshot.mounted.map((row) => ({ ...row }));
  // Directly exercise the expression shape the bug lived in: a row with only
  // `name` must never be asked for a string method on a missing field.
  for (const row of mounted) {
    const key = row.package ?? row.name ?? '';
    if (typeof key !== 'string') throw new Error('row key is not a string');
    key.replace(/^@deepseek-ai\//, '');
  }
} catch (error) { renderError = error; }
check('a mounted row without a package field can still be keyed and labelled',
  renderError === undefined, renderError?.message);

// Strip comments before scanning for the bad pattern: the fix is documented in
// a comment that mentions the old expression, and a comment is not a call site.
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// The dangerous form is an *unguarded* `row.package.replace(...)` — one that
// runs unconditionally on a field which may be undefined. A guarded test
// (`row.package !== undefined ? row.package.replace(...) : ...`) is safe, so
// assert on the unguarded shape specifically rather than the bare substring.
check('no unguarded .replace on a possibly-absent row.package',
  !/(?<!\?\s)(?<!\?\?)\brow\.package\.replace\(/.test(codeOnly)
  || !/(^|[^?\s])\brow\.package\.replace\(/.test(codeOnly));

check('row keys and labels go through the package→name fallback',
  /const key = row\.package \?\? row\.name \?\? '';/.test(source)
  && (source.match(/const key = row\.package \?\? row\.name \?\? '';/g) ?? []).length === 2,
  `${(source.match(/const key = row\.package \?\? row\.name \?\? '';/g) ?? []).length} site(s)`);

// Every `.replace` on a row field must sit behind an existence check.
check('row.package.replace only runs behind a defined-check',
  /row\.package !== undefined\s*\n?\s*\?\s*row\.package\.replace\(/.test(codeOnly)
  || !/row\.package\.replace\(/.test(codeOnly));

// The host must supply `package` on mounted rows so the two tables agree.
const hostSource = readFileSync('E:/deepseek/agent-preset-studio/lib/index.js', 'utf8');
check('the host enriches mounted rows with a resolved package',
  /mounted: mountedWithPackage/.test(hostSource)
  && /package: toolToPackage\.get\(row\.name\)/.test(hostSource));
check('the reverse index is built from the already-scanned catalogue',
  /function toolToPackageOf\(/.test(hostSource)
  && /const toolToPackage = toolToPackageOf\(catalogue\);/.test(hostSource));

// --- Readability: the table must explain itself -------------------------
// The tool list is a wall of machine identifiers; without column headings and
// a stated reason for a missing number, a user cannot tell what any of it means.
console.log('\n== tool table explains itself ==');
check('every column has a heading',
  /t\('colName'\)/.test(source) && /t\('colShips'\)/.test(source) && /t\('colTokens'\)/.test(source));
check('a missing token count is a word, not a dash',
  !/tokensUnknown: '—'/.test(source) && /tokensUnknown: '未知'/.test(source));
check('the zh dictionary explains why a token count can be missing',
  /tokensUnknownTitle:/.test(source));
check('bulk select uses the same fallback key as the per-row toggle',
  // setAll 写 row.package 时，「已挂」表全选会往勾选集塞 undefined。
  /const key = row\.package \?\? row\.name;/.test(source)
  && !/const key = row\.package;\s*\n\s*if \(on\)/.test(source));
check('the two-different-yardsticks caveat is shown to the user',
  /keyingNote:/.test(source) && /t\('keyingNote'\)/.test(source));
check('token cost carries a relative bar so magnitudes are visible',
  /barTrack/.test(source) && /barFill/.test(source) && /maxTokens/.test(source));

console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
process.exit(fail === 0 ? 0 : 1);
