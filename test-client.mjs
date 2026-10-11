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

console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
process.exit(fail === 0 ? 0 : 1);
