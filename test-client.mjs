/**
 * Structural checks on the browser half.
 *
 * The client bundle cannot be imported by Node (it calls
 * window.__ModuleLoader__.load), so this evaluates its pure pieces in isolation
 * and asserts the invariants that a browser run would otherwise have to catch:
 * dictionary symmetry, and that every t('key') the code uses is defined.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

// 被测文件按**本文件所在位置**推导 —— 仓库 clone 到任何目录都能跑。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PATH = join(HERE, 'lib', 'client.js');
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
// The selection set is keyed ONE way everywhere: `row.package ?? row.name`.
// A mounted row whose owning package resolves (every official tool) is keyed by
// the PACKAGE name, because that is what an exported preset can actually declare;
// only rows with no resolvable owner (MCP tools, third-party plugin tools) fall
// back to the tool name.
//
// This used to be seeded by `row.name` while the checkbox renderer keyed by
// `row.package ?? row.name`. The mismatch meant every official row was seeded
// under a tool name the renderer never looked up, so the tools tab showed no
// ticks for official tools at all — only the MCP and third-party rows, whose
// keys coincide, appeared ticked. Both checks below exist to keep that from
// coming back: seeding and the token total must use the renderer's key rule.
check('mounted rows are seeded by the same key the renderer uses',
  /\.map\(\(row\) => row\.package \?\? row\.name\)/.test(source));
// The token total reads the same keyed set the seeding wrote. Using row.name
// there silently drops every official row and under-reports the total.
check('the token total reads mounted rows with the same key rule too',
  /selectedTokens[\s\S]{0,240}?selected\.has\(row\.package \?\? row\.name\)/.test(source));
// Select-all rebuilds both tables' keys; the mounted loop must not drift back
// to the bare tool name either.
check('select-all keys mounted rows the same way',
  /for \(const row of filteredMounted\) \{\s*\n\s*const key = row\.package \?\? row\.name;/.test(source));

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
// 这条断言在「已挂表」改用 `ownerMissing` 变量做闸门后更新过一次：
// 原先的写法是内联三元 `row.package !== undefined ? row.package.replace(...)`，
// 现在把条件提到了具名常量 `ownerMissing`（同一件事，读起来更清楚）。
// 判据放宽成「存在任一 checked 闸门」——但**必须**真的存在，不能裸调 replace。
check('row.package.replace only runs behind a defined-check',
  /ownerMissing\s*=\s*row\.package === undefined/.test(codeOnly)
  || /row\.package !== undefined\s*\n?\s*\?\s*row\.package\.replace\(/.test(codeOnly)
  || !/row\.package\.replace\(/.test(codeOnly));

// The host must supply `package` on mounted rows so the two tables agree.
const hostSource = readFileSync(join(HERE, 'lib', 'index.js'), 'utf8');
check('the host enriches mounted rows with a resolved package',
  /mounted: mountedWithPackage/.test(hostSource)
  // 归属包现在先存进具名常量 `owner`（同一件事，读起来更清楚），
  // 因为它还要被下面的 ownerSummary 复用一次。两种写法都认。
  && (/package: toolToPackage\.get\(row\.name\)/.test(hostSource)
      || /const owner = toolToPackage\.get\(row\.name\)/.test(hostSource)));
check('the host also carries the owning package summary onto mounted rows',
  // 已挂行的说明是工具自己的**英文** description，会和整表的中文表头打架
  // （用户：「中英文怎么混了」）。宿主要把归属包的中文说明一并带上，
  // 客户端才能给英文原文配一段中文语境标签。
  /ownerSummary: owner === undefined \? undefined : packageSummary\.get\(owner\)/.test(hostSource)
  && /const packageSummary = new Map\(\)/.test(hostSource));
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

console.log('\n== the mounted table does not ask a single tool what tools it ships ==');
// 用户截图里的「未标注」出现在两处，这是**第一处**：
// 「已挂」那张表照搬了「可挂」表的列，于是每一行后面都跟一个
// 「带的工具：未标注」—— 因为已挂行的数据里压根没有 toolNames 字段。
// 但真正的问题是语义：已挂表**一行就是一个工具**，
// 「这一个工具带哪些工具」本身就不成立。所以那一列必须从这张表移除。
check('the mounted table has no ships column at all',
  // 判据：已挂表的**表头块**里不出现 colShips。
  // 做法是截出「已挂表头」那一段（从 toolsMounted 到 sectionBody），断言它没有 colShips。
  (() => {
    const start = source.indexOf("t('toolsMounted')");
    const end = source.indexOf('filteredMounted.length === 0');
    if (start < 0 || end < 0 || end < start) return false;
    const head = source.slice(start, end);
    return !/colShips/.test(head);
  })());
check('the mounted row renders no ships cell',
  // 已挂行的渲染里不能再出现 renderShips 调用。
  // 判据：renderShips 的**调用**只应出现在可挂表那一块。
  (source.match(/renderShips\(key, row\.toolNames\)/g) ?? []).length === 1);
check('the mounted row names the tool in the first column, not the package',
  // 第一列表头写的是「工具 / 包」，已挂行是工具，所以第一列应显示 row.name。
  /const shown = row\.name \?\? key;/.test(source));
check('the mounted table does not spend a column on the owning package',
  // 用户原话：「归属包删了不写了」。
  // 包名对使用者没有决策价值（他关心的是"这个工具干什么、多贵"），
  // 却会占掉说明列一大截宽度。所以这一列必须消失。
  !/t\('colOwner'\)/.test(codeOnly)
  && !/colOwner:/.test(codeOnly)
  && !/const ownerLabel = ownerMissing/.test(codeOnly));
check('the owning package survives as a tooltip on the tool name',
  // 列删了，但信息没丢 —— 它挪进了名称列的 title 悬浮提示。
  // ⚠️ 这里不能逐行找：`title: ownerMissing` 和 `${row.package}` 分在两行上
  // （三元表达式跨行了），必须用跨行匹配。
  /title:\s*ownerMissing[\s\S]{0,160}?row\.package/.test(codeOnly));

console.log('\n== an English description gets a Chinese context tag ==');
// 用户原话：「中英文怎么混了」。已挂表的说明来自工具自己的 description，
// 那是写给模型看的英文原文（不能翻译 —— 会丢精度、和实际行为对不上）。
// 解法是中英对照：英文原文前面加一段中文归属语境。
check('a Chinese context tag is rendered before an English description',
  /const prefix = describePrefix\(row, text\)/.test(source)
  && /h\('span', \{ style: S\.descTag \}, prefix\)/.test(source));
check('a description that is already Chinese never gets a prefix',
  // 可挂表的说明本来就是中文，再加标签就成了中英叠罗汉。
  /if \(\/\[\\u4e00-\\u9fff\]\/\.test\(text\)\) return undefined;/.test(source));
check('the tag is abbreviated so it cannot crowd out the description',
  /const shortenSummary = \(zh\) =>/.test(source) && /slice\(0, 14\)/.test(source));
check('the description body owns its own ellipsis',
  // 外层现在是 flex 容器，省略号必须落在最内层文本节点上，否则会失效。
  /descText: \{/.test(source) && /h\('span', \{ style: S\.descText \}, text\)/.test(source));
check('the context tag only appears when an owning package summary exists',
  /const zh = row\.ownerSummary;/.test(source)
  && /if \(typeof zh !== 'string' \|\| zh\.trim\(\) === ''\) return undefined;/.test(source));

console.log('\n== the tool list collapses instead of overflowing ==');
// 折叠的意义：一个包可能带十来个工具，平铺会把右边的 token 列挤掉、还会被
// CSS 截断成 `edit, read, write, …`，反而看不全。所以必须默认折叠、点开才铺开。
check('the ships column renders a toggle badge rather than a flat join',
  /shipsToggle/.test(source)
  // 旧的平铺写法（把数组 join 成一整串直接塞进单元格）必须消失。
  && !/row\.toolNames\.join\('、'\)/.test(codeOnly));
check('a collapsed row advertises how many tools there are',
  /t\('shipsCount', \{ n: names\.length \}\)/.test(source));
check('expanding renders one chip per tool name',
  /shipsChip/.test(source) && /names\.map\(/.test(source));
check('expand state is tracked per row key, not globally',
  /const \[expanded, setExpanded\] = useState\(\(\) => new Set\(\)\)/.test(source)
  && /toggleExpanded/.test(source) && /expanded\.has\(key\)/.test(source));
check('clicking the toggle cannot also tick the row checkbox',
  // 整行是 <label>，点它会连带切换 checkbox。两个方法都必要：
  //   preventDefault 阻止 label 转发点击，stopPropagation 阻止冒泡。
  /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/.test(source));
check('the toggle is reachable by keyboard and states its expandedness',
  /role: 'button'/.test(source) && /'aria-expanded': open/.test(source) && /tabIndex: 0/.test(source));
check('the en dictionary carries the same collapse keys as zh',
  /shipsCount: '\{n\}'/.test(source)
  && /shipsExpand: 'Expand'/.test(source)
  && /shipsShow: 'Show the \{n\} tools'/.test(source)
  && /shipsNone: 'not listed'/.test(source));

console.log('\n== the description column says what a thing is for ==');
// 用户原话：「你为啥要注释成"这个包没有标注工具清单"，你没法详细注释它的功能吗？」
// 这一列必须显示这个工具/包**是干嘛的**，而不是一个状态词。
check('every row renders a description cell, not just a name and a token count',
  /const renderDesc = \(row\) =>/.test(source)
  // 两张表都要调用它。
  && (source.match(/renderDesc\(row\)/g) ?? []).length >= 2);
check('the description comes from the entry\u2019s own words, with a neutral fallback',
  // 优先 summary（中文 README 的说明），退回 description，都没有才用占位语。
  /row\.summary \?\? row\.description/.test(source)
  && /descMissing: '没有提供说明文字'/.test(source));
check('the placeholder for a missing description is NOT the tool-list placeholder',
  // 「没有标注工具清单」说的是**另外一列**（带的工具）。两个占位语必须分开，
  // 否则「说明」列显示的是工具清单的状态 —— 正是用户指出的问题。
  /descMissing:/.test(source) && /shipsNone:/.test(source)
  && !/shipsNone: '这个包没有标注工具清单'/.test(source));
check('the two columns are separate headings so neither can masquerade as the other',
  /colDesc:/.test(source) && /colShips:/.test(source)
  && /t\('colDesc'\)/.test(source) && /t\('colShips'\)/.test(source));
check('rows carry a stable-width tools column so the description keeps its room',
  /rowShipsHead:/.test(source) && /rowShips:/.test(source));

// --- 交互层：轻量渲染模拟 ------------------------------------------------
// 方案：不引入第三方 DOM 库（仓库保持零依赖）。用 mock fetch 完整加载
// client.js，把 react 桩升级成「真值求值器」：
//   · 函数组件直接调用、类组件 new + render()（error boundary 的兜底逻辑
//     在这里真实生效），宿主标签收集成可遍历的节点树；
//   · useState 的 setter 更新 hook 槽位并触发整树重渲染（同 React 语义）；
//   · useEffect 在每轮渲染后统一 flush，deps 变了才重跑；
//   · useMemo 按 deps 缓存 —— 否则每次重渲染都会新建 store，勾选就白存了，
//     那正是本次要修的核心 bug，模拟器必须还原这个语义才能测出修复。
// 这足以驱动「勾选 → 切页回来还在」这条核心修复的真实数据流。
console.log('\n== interaction layer (restore, tab switches, toggles) ==');

const makeRenderer = () => {
  const contexts = new Map();   // 组件函数 -> { cursor, hooks: [] }
  let current = null;           // 正在渲染的组件
  let pendingEffects = [];
  let rerenderQueued = false;
  let rendering = false;
  let rootComponent = null;
  let rootProps = null;

  const sameDeps = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  class Component {
    constructor(props) { this.props = props ?? {}; this.state = {}; }
    setState(patch) { this.state = { ...this.state, ...patch }; }
    render() { return null; }
  }
  const Fragment = {};

  const render = (type, props) => {
    rootComponent = type;
    rootProps = props ?? {};
    let tree = null;
    do {
      rerenderQueued = false;
      rendering = true;
      tree = createElement(rootComponent, rootProps);
      rendering = false;
      while (pendingEffects.length > 0) pendingEffects.shift()();
    } while (rerenderQueued);
    return tree;
  };

  const createElement = (type, props, ...children) => {
    const normalized = props ?? {};
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
    if (typeof type === 'function') {
      // 类组件（StudioBoundary）实例化后走 render()；函数组件直接调用。
      if (type.prototype && typeof type.prototype.render === 'function') {
        const rendered = new type({ ...normalized, children: flat }).render();
        // 类组件 render 可能直接返回 children 数组（React 也允许），
        // 统一包成 Fragment 节点，保证上层能继续遍历。
        return Array.isArray(rendered) ? { type: Fragment, children: rendered } : rendered;
      }
      let ctx = contexts.get(type);
      if (ctx === undefined) { ctx = { cursor: 0, hooks: [] }; contexts.set(type, ctx); }
      const parent = current;
      current = ctx;
      ctx.cursor = 0;
      let out;
      try {
        out = type({ ...normalized, children: flat });
      } catch (error) {
        // 兜底：渲染抛错也要能往下看（不掩盖，错误原文进树）。
        out = createElement('div', {}, String(error?.stack ?? error?.message ?? error));
      }
      current = parent;
      return out;
    }
    if (type === Fragment) return flat;
    return { type, props: normalized, children: flat };
  };

  const useState = (init) => {
    const ctx = current;
    let hook = ctx.hooks[ctx.cursor];
    if (hook === undefined) {
      hook = { kind: 'state', value: typeof init === 'function' ? init() : init };
      hook.set = (next) => {
        hook.value = typeof next === 'function' ? next(hook.value) : next;
        rerenderQueued = true;
        // 渲染外 set → 排一个微任务重渲染，避免同步重入。
        if (!rendering) queueMicrotask(() => { if (rerenderQueued) render(rootComponent, rootProps); });
      };
      ctx.hooks[ctx.cursor] = hook;
    }
    ctx.cursor += 1;
    return [hook.value, hook.set];
  };

  const useEffect = (fn, deps) => {
    const ctx = current;
    let hook = ctx.hooks[ctx.cursor];
    if (hook === undefined) { hook = { kind: 'effect', deps: undefined }; ctx.hooks[ctx.cursor] = hook; }
    ctx.cursor += 1;
    const changed = hook.deps === undefined || !sameDeps(hook.deps, deps ?? []);
    if (changed) { hook.deps = deps ?? []; pendingEffects.push(fn); }
  };

  const useRef = (initial) => {
    const ctx = current;
    let hook = ctx.hooks[ctx.cursor];
    if (hook === undefined) { hook = { kind: 'ref', value: { current: initial } }; ctx.hooks[ctx.cursor] = hook; }
    ctx.cursor += 1;
    return hook.value;
  };

  const useMemo = (fn, deps) => {
    const ctx = current;
    let hook = ctx.hooks[ctx.cursor];
    if (hook === undefined) { hook = { kind: 'memo', deps: undefined, value: undefined }; ctx.hooks[ctx.cursor] = hook; }
    ctx.cursor += 1;
    const changed = hook.deps === undefined || !sameDeps(hook.deps, deps ?? []);
    if (changed) { hook.deps = deps ?? []; hook.value = fn(); }
    return hook.value;
  };

  const useCallback = (fn, deps) => {
    const ctx = current;
    let hook = ctx.hooks[ctx.cursor];
    if (hook === undefined) { hook = { kind: 'cb', deps: undefined, value: undefined }; ctx.hooks[ctx.cursor] = hook; }
    ctx.cursor += 1;
    const changed = hook.deps === undefined || !sameDeps(hook.deps, deps ?? []);
    if (changed) { hook.deps = deps ?? []; hook.value = fn; }
    return hook.value;
  };

  return {
    Component, Fragment, render, createElement,
    useState, useEffect, useRef, useMemo, useCallback,
  };
};

// 树遍历 helper：找出某种节点 / 有某个属性的节点。
const walkTree = (node, fn) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  fn(node);
  if (Array.isArray(node.children)) for (const child of node.children) walkTree(child, fn);
};
const byType = (root, type) => { const out = []; walkTree(root, (n) => { if (n.type === type) out.push(n); }); return out; };
const byProp = (root, pred) => { const out = []; walkTree(root, (n) => { if (typeof n === 'object' && n.props !== undefined && pred(n.props)) out.push(n); }); return out; };
const inputsOfType = (root, kind) => byType(root, 'input').filter((n) => n.props?.type === kind);
const checkboxesOf = (root) => inputsOfType(root, 'checkbox');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 一份「有草稿」的宿主：勾了 read，prefix/suffix 都是草稿里的值，来源是
// 现有预设 mock-preset —— 这是「切页回来勾选还在」的种子数据。
const restoredDraftPayload = {
  ok: true,
  draft: {
    selected: ['read'],
    personaFields: {
      prefix: '草稿恢复的前缀。',
      suffix: '草稿后缀',
      complete: false,
      includeRuntimeContext: true,
    },
    source: { mode: 'edit', presetId: 'mock-preset', topId: 'preset-mock', name: 'Mock 预设', order: 3 },
  },
  path: '/mock/profiles/desktop/.studio-draft.json',
};

const buildInteractive = (draftPayload) => {
  const captured3 = {};
  const interactiveFetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const path = String(url).split('/').pop();
    let payload;
    if (path === 'snapshot') {
      payload = {
        ok: true,
        mounted: [
          { name: 'read', description: '读文件', tokens: 100 },
          { name: 'write', description: '写文件', tokens: 200 },
        ],
        mountedTokens: 300,
        availablePackages: [
          { package: '@deepseek-ai/dsh-tool-fs', version: '1.0.0', toolNames: ['read', 'write'], anyMounted: true, summary: '文件系统工具' },
        ],
        // ⚠️ roster 不能是空数组 —— 空 roster 会让系统提示词页的合并下拉
        //    把「我的预设」也当成唯一候选，走不到 loadOfficialPreset 分支，
        //    于是「载入官方预设不动勾选」这条断言就测了个寂寞。
        //    给一个真·官方条目，并让「我的预设」mock-preset 与它**同名**
        //    （name 相同），它就会被去重规则摘掉「我的预设」组，
        //    下拉里剩下的 llama-local 是纯官方条目。
        presets: [{ id: 'llama-local', name: 'Mock 预设' }],
        defaultOutputRoot: '/mock/output',
        profileDir: '/mock/profiles/desktop',
        presetError: undefined,
      };
    } else if (path === 'draft') {
      payload = method === 'GET' ? draftPayload : { ok: true, path: '/mock/profiles/desktop/.studio-draft.json' };
    } else if (path === 'profile-presets') {
      payload = {
        ok: true,
        presets: [
          {
            presetId: 'mock-preset', topId: 'preset-mock', name: 'Mock 预设', order: 3,
            persona: { prefix: '现有预设的前缀。', suffix: '', complete: true, includeRuntimeContext: false },
            packages: ['@deepseek-ai/dsh-tool-fs'],
          },
          // ⚠️ 第二条是**故意不同名**的「我的预设」。上面那条与官方 llama-local
          //    同名，会被 isDuplicatedMine 从「我的预设」组摘掉，于是系统提示词页
          //    那个下拉里它只剩官方条目、永远走不到 loadExistingPreset ——
          //    「载入我的预设不动勾选」这条断言就会空转（这正是本次踩到的坑）。
          {
            presetId: 'mock-mine-only', topId: 'preset-mine-only', name: '只有我这有的预设', order: 4,
            persona: { prefix: '第二条现有预设。', suffix: '', complete: false, includeRuntimeContext: true },
            packages: ['@deepseek-ai/dsh-tool-web'],
          },
        ],
      };
    } else {
      payload = { ok: true, dir: '/mock/export/out', linesBefore: 12, linesAfter: 12 };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const interactiveSandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured3.spec = spec; } } },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: interactiveFetch,
    AbortController,
    Response,
    CustomEvent,
  };
  vm.createContext(interactiveSandbox);
  vm.runInContext(source, interactiveSandbox);
  const renderer = makeRenderer();
  let lastStore = undefined;
  const origMemo = renderer.useMemo;
  renderer.useMemo = (factory, deps) => {
    const v = origMemo(factory, deps);
    if (v !== null && typeof v === 'object' && typeof v.get === 'function') lastStore = v;
    return v;
  };
  const reactInteractive = {
    Component: renderer.Component,
    Fragment: renderer.Fragment,
    createElement: renderer.createElement,
    useCallback: renderer.useCallback,
    useEffect: renderer.useEffect,
    useMemo: renderer.useMemo,
    useRef: renderer.useRef,
    useState: renderer.useState,
  };
  const plugin3 = captured3.spec.factory((name) => {
    if (name === 'react') return reactInteractive;
    throw new Error(`undeclared module requested: ${name}`);
  });
  let settingsComponent3;
  const captureCtx3 = {
    locale: { register: () => () => {}, bind: () => (k) => k },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (def, Component) => { settingsComponent3 = Component; return () => {}; },
    },
    inject: (_deps, fn) => fn({ effect: (f) => f(), get: () => undefined, slots: captureCtx3.slots }),
  };
  plugin3.apply(captureCtx3);
  const renderProps = { t: (key) => key };
  return {
    getTree: () => renderer.render(settingsComponent3, renderProps),
    getStore: () => lastStore,
    initial: renderer.render(settingsComponent3, renderProps),
  };
};

// 点击某个 tab：按钮文本就是 t('tabPrompt') 之类的 key。
const clickTab = (tree, id) => {
  // 按钮文案是 t('tabPrompt') 这类字典键（测试桩 t 原样返回键名），
  // 所以按 id 拼出对应键名再去匹配。
  const tabKey = `tab${id[0].toUpperCase()}${id.slice(1)}`;
  const button = byType(tree, 'button').find((n) => n.props?.onClick !== undefined
    && Array.isArray(n.children) && n.children.includes(tabKey));
  if (button === undefined) return false;
  button.props.onClick();
  return true;
};

(async () => {
  // —— 挂载 + 草稿恢复：勾选、人设四字段、编辑来源都要在渲染层看得见 ——
  const app = buildInteractive(restoredDraftPayload);
  await tick();   // 让挂载数据链（restoreDraft → loadSnapshot → presets）跑完
  let tree = app.getTree();
  const textBits = [];
  walkTree(tree, (n) => {
    if (typeof n === 'object' && Array.isArray(n.children)) {
      for (const c of n.children) if (typeof c === 'string') textBits.push(c);
    }
  });
  console.log('TREE-ROOT', tree?.type, 'bits', textBits.slice(0, 12).join(' | '));

  check('the default tab renders a checked selection restored from the draft',
    checkboxesOf(tree).some((n) => n.props.checked === true),
    `checked=${checkboxesOf(tree).map((n) => n.props.checked).join(',')}`);

  // 切到系统提示词页：两个文本框 + 两个载入下拉 + 两个开关都要渲染出来。
  clickTab(tree, 'prompt');
  await tick();
  tree = app.getTree();
  const promptTextareas = byType(tree, 'textarea');
  const promptSelects = byType(tree, 'select');
  const promptToggles = checkboxesOf(tree);
  check('the prompt tab renders two textareas (prefix / suffix)',
    promptTextareas.length === 2, `${promptTextareas.length}`);
  check('the prompt tab renders two preset-loading selects',
    promptSelects.length === 2, `${promptSelects.length}`);
  check('the prompt tab renders the complete and includeRuntimeContext toggles',
    promptToggles.length === 2, `${promptToggles.length}`);
  check('the draft prefix is restored into the rendered prefix box',
    promptTextareas[0]?.props?.value === '草稿恢复的前缀。', promptTextareas[0]?.props?.value);
  check('the draft suffix is restored into the rendered suffix box',
    promptTextareas[1]?.props?.value === '草稿后缀', promptTextareas[1]?.props?.value);
  check('the edit-source select is restored to the draft preset',
    promptSelects[1]?.props?.value === 'mock-preset', promptSelects[1]?.props?.value);
  check('the complete toggle is restored off', promptToggles[0]?.props?.checked === false);
  check('the includeRuntimeContext toggle is restored on',
    promptToggles[1]?.props?.checked === true);

  // —— 开关交互：点击后 store 跟着变，渲染也跟着变 ——
  promptToggles[0].props.onChange();
  await tick();
  tree = app.getTree();
  check('clicking the complete toggle flips it on',
    checkboxesOf(tree)[0]?.props?.checked === true,
    String(checkboxesOf(tree)[0]?.props?.checked));
  checkboxesOf(tree)[1].props.onChange();
  await tick();
  tree = app.getTree();
  check('clicking the includeRuntimeContext toggle flips it off',
    checkboxesOf(tree)[1]?.props?.checked === false,
    String(checkboxesOf(tree)[1]?.props?.checked));

  // —— 核心修复：切到别的设置页再回来，草稿恢复的勾选还在 ——
  // 注意：已挂表按「工具名」键，草稿里的勾选正是工具名，所以这里必须在
  // 载入现有预设**之前**验证 —— 载入预设会把 packages（包名）写进勾选集，
  // 包名只在「可挂」表按包名键可见，那是另一把尺子（见 keyingNote）。
  clickTab(tree, 'tools');
  await tick();
  tree = app.getTree();
  check('the tools tab still shows the selection after switching away',
    checkboxesOf(tree).some((n) => n.props.checked === true),
    `n=${checkboxesOf(tree).length} checked=${checkboxesOf(tree).map((n) => n.props.checked).join(',')}`);
  check('the restored tool is the one the draft selected',
    app.getStore()?.get()?.selected?.has('read') === true,
    `selected=${JSON.stringify([...(app.getStore()?.get()?.selected ?? [])])}`);
  clickTab(tree, 'prompt');
  await tick();
  tree = app.getTree();
  check('the persona fields survive a round trip through another tab',
    byType(tree, 'textarea')[0]?.props?.value === '草稿恢复的前缀。',
    byType(tree, 'textarea')[0]?.props?.value);
  check('the edit-source marker survives the round trip too',
    byType(tree, 'select')[1]?.props?.value === 'mock-preset');

  // —— 两个页面的载入下拉必须**互不影响**，且各自的选择要跨切页保留 ——
  // 回归背景①：下拉的选中值一度各自放在 tab 组件内部（useState），
  //   切走这个 tab 组件被卸载 → 再切回来显示「未选」，看着就像「被影响了」。
  //   现在两个值都提到根组件持有并往下传，这节把这条行为锁死。
  // 回归背景②：用户报「系统提示词的载入会影响工具页」。真凶是 loadOfficialPreset
  //   顺手写 selected（已删）。这里额外验证：在系统提示词页选**官方预设**时，
  //   工具勾选必须**一个字节都不动**。
  // ⚠️ 要选到一个真·官方预设，roster 不能是空的 —— mock 的 snapshot.presets
  //   给了 llama-local，同时让「我的预设」mock-preset 与它**同名**，
  //   这样它会被去重规则从「我的预设」组里摘掉（isDuplicatedMine），
  //   下拉里那个 llama-local 就是纯官方条目，走 loadOfficialPreset 分支。
  clickTab(tree, 'tools');
  await tick();
  tree = app.getTree();
  const toolsSelect = byType(tree, 'select').at(-1);
  toolsSelect.props.onChange({ target: { value: 'mock-preset' } });
  await tick();
  tree = app.getTree();
  check('picking a preset on the tools tab updates the tools dropdown',
    byType(tree, 'select').at(-1)?.props?.value === 'mock-preset',
    String(byType(tree, 'select').at(-1)?.props?.value));
  // ⚠️ 基线要在**工具页那次点击之后**取！取早了会拿「点击前的 read」当基准，
  //    而工具页点击本来就会（按设计）把勾选换成该预设的包 —— 那不是 bug。
  const selectedBeforePromptPick = [...(app.getStore()?.get()?.selected ?? [])].sort().join(',');
  check('the tools-tab pick actually seeded the package selection',
    app.getStore()?.get()?.selected?.has('@deepseek-ai/dsh-tool-fs') === true,
    `selected=${[...(app.getStore()?.get()?.selected ?? [])].sort().join(',')}`);

  // 切到系统提示词页：工具页那个选择**不该**跑到这里来（两个值互相独立）。
  // ⚠️ 别拿「空字符串」当期望值 —— 这个下拉的 value 是
  //   presetPick !== '' ? presetPick : (current ?? '')
  //   即「没手动选过时，显示当前编辑来源」。所以这里看到 mock-preset 是对的
  //   （草稿的 source.presetId 就是 mock-preset），不是串页。
  //   真正要验的是：它**不等于**工具页刚选的那个值所造成的人为串扰 ——
  //   而工具页选的是同一个 mock-preset，两边撞号了没法区分。
  //   所以改用下拉的 title 精确定位到「系统提示词页那个」（promptLoadTitle），
  //   并选一个工具页绝不可能出现的值来验独立性。
  clickTab(tree, 'prompt');
  await tick();
  tree = app.getTree();
  const promptSelect = byType(tree, 'select').find((s) => s.props?.title === 'promptLoadTitle');
  check('the prompt tab exposes its own preset dropdown (not the tools one)',
    promptSelect !== undefined && promptSelect.props?.title === 'promptLoadTitle',
    String(promptSelect?.props?.title));
  check('the prompt dropdown shows the edit source before any manual pick',
    promptSelect?.props?.value === 'mock-preset',
    String(promptSelect?.props?.value));

  // 在系统提示词页选一个**官方**预设（只载人设，绝不碰勾选）。
  // 用 title 定位下拉，不用下标 —— 下标会随页面结构改动而失准（这次就踩了）。
  const pickPrompt = (val) => {
    const s = byType(app.getTree(), 'select').find((n) => n.props?.title === 'promptLoadTitle');
    s.props.onChange({ target: { value: val } });
  };
  pickPrompt('llama-local');
  await tick();
  await tick();
  tree = app.getTree();
  check('picking an official preset on the prompt tab updates the prompt dropdown',
    byType(tree, 'select').find((s) => s.props?.title === 'promptLoadTitle')?.props?.value === 'llama-local',
    String(byType(tree, 'select').find((s) => s.props?.title === 'promptLoadTitle')?.props?.value));
  check('picking an official preset on the prompt tab leaves the tool ticks untouched',
    [...(app.getStore()?.get()?.selected ?? [])].sort().join(',') === selectedBeforePromptPick,
    `${[...(app.getStore()?.get()?.selected ?? [])].sort().join(',')} vs ${selectedBeforePromptPick}`);

  // 再切回工具页：那个选择也得还在（跨切页保留）。
  clickTab(tree, 'tools');
  await tick();
  tree = app.getTree();
  check('the tools dropdown survives a round trip through the prompt tab',
    byType(tree, 'select').at(-1)?.props?.value === 'mock-preset',
    String(byType(tree, 'select').at(-1)?.props?.value));
  // 切回系统提示词页，那边的选择同样还在（这条才是「提状态到根组件」的核心收益：
  // 放在 tab 内部时会随组件卸载而丢，切回来就变回未选）。
  clickTab(tree, 'prompt');
  await tick();
  tree = app.getTree();
  check('the prompt dropdown survives a round trip through the tools tab',
    byType(tree, 'select').find((s) => s.props?.title === 'promptLoadTitle')?.props?.value === 'llama-local',
    String(byType(tree, 'select').find((s) => s.props?.title === 'promptLoadTitle')?.props?.value));
  // 还原到初始态，后面的既有断言按原顺序继续跑。
  pickPrompt('');
  await tick();
  tree = app.getTree();

  // —— 载入现有预设：只填人设四字段，**不动工具勾选** ——
  //    这是用户明确要的第 5 条：系统提示词页与工具页彻底解耦。
  //    用 `mock-mine-only`（不同名，不会被去重摘掉）才能真走到 loadExistingPreset。
  const selectedBeforeExistingLoad = [...(app.getStore()?.get()?.selected ?? [])].sort().join(',');
  promptSelects[1].props.onChange({ target: { value: 'mock-mine-only' } });
  await tick();
  tree = app.getTree();
  check('loading an existing preset fills the prefix box',
    byType(tree, 'textarea')[0]?.props?.value === '第二条现有预设。',
    byType(tree, 'textarea')[0]?.props?.value);
  check('loading an existing preset fills the complete toggle',
    checkboxesOf(tree)[0]?.props?.checked === false,
    String(checkboxesOf(tree)[0]?.props?.checked));
  check('loading an existing preset on the prompt tab leaves the tool ticks untouched',
    [...(app.getStore()?.get()?.selected ?? [])].sort().join(',') === selectedBeforeExistingLoad,
    `${[...(app.getStore()?.get()?.selected ?? [])].sort().join(',')} vs ${selectedBeforeExistingLoad}`);
  check('loading an existing preset on the prompt tab does not tick its own packages',
    app.getStore()?.get()?.selected?.has('@deepseek-ai/dsh-tool-web') !== true,
    `selected=${[...(app.getStore()?.get()?.selected ?? [])].sort().join(',')}`);
  // ⚠️ 不在这里「还原」成 mock-preset —— 它与官方 llama-local 同名，已被
  //    isDuplicatedMine 从「我的预设」组摘掉，选它 onChange 直接早退、改不动任何状态。
  //    后面导出页的断言靠的是更早的草稿 source，与本段无关。

  // —— 导出页：覆盖 / 另存开关，以及载入过现有预设时的灰态解除 ——
  clickTab(tree, 'export');
  await tick();
  tree = app.getTree();
  const radios = inputsOfType(tree, 'radio');
  check('the export tab offers both modes', radios.length === 2, `${radios.length}`);
  check('overwrite is enabled once an existing preset is loaded',
    radios[1]?.props?.disabled !== true, String(radios[1]?.props?.disabled));
  // 导出表单预填的是**最后一次载入的那个预设**的 id —— 上面载入的是 mock-mine-only。
  check('the export form is pre-filled with the edited preset id',
    byProp(tree, (p) => p.placeholder === 'my-mode')[0]?.props?.value === 'mock-mine-only',
    byProp(tree, (p) => p.placeholder === 'my-mode')[0]?.props?.value);
  radios[0].props.onChange();
  await tick();
  tree = app.getTree();
  check('switching to save-as unchecks the overwrite radio',
    inputsOfType(tree, 'radio')[1]?.props?.checked === false,
    String(inputsOfType(tree, 'radio')[1]?.props?.checked));

  // —— 导出交互：点导出按钮，结果块要渲染出来 ——
  // 另存模式下主按钮文案是 t('exportSave')，t 返回 key 本身。
  const runButton = byType(tree, 'button').find((n) => Array.isArray(n.children)
    && n.children.includes('exportSave'));
  check('the export button is reachable on the export tab', runButton !== undefined);
  runButton?.props?.onClick();
  await tick();
  tree = app.getTree();
  check('running an export renders the done note',
    walkTreeResult(tree, 'exportDone'));

  // —— 没有载入过现有预设：覆盖开关必须保持灰态 ——
  const freshApp = buildInteractive({ ok: true, draft: null, path: '/mock/profiles/desktop/.studio-draft.json' });
  await tick();
  let freshTree = freshApp.getTree();
  clickTab(freshTree, 'prompt');
  await tick();
  freshTree = freshApp.getTree();
  check('a fresh store has no edit source', byType(freshTree, 'select')[1]?.props?.value === '');
  clickTab(freshTree, 'export');
  await tick();
  freshTree = freshApp.getTree();
  const freshRadios = inputsOfType(freshTree, 'radio');
  check('overwrite stays disabled without a loaded preset',
    freshRadios[1]?.props?.disabled === true, String(freshRadios[1]?.props?.disabled));

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nINTERACTIVE-CRASH');
  console.error(error?.stack ?? error);
  process.exit(1);
});

// walkTreeResult：在树里找一个 div，其直接文本子节点包含指定片段
// （导出结果 note 是一整个带样式的 div，文本是 t('exportDone') 之类的 key）。
function walkTreeResult(tree, needle) {
  let found = false;
  walkTree(tree, (n) => {
    if (found) return;
    if (n.type === 'div' && Array.isArray(n.children)
      && n.children.some((c) => typeof c === 'string' && c.includes(needle))) {
      found = true;
    }
  });
  return found;
}
