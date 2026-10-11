/**
 * Pre-flight: verify the installed plugin is loadable the way DSH loads it.
 *
 * Checks the manifest the loader reads, resolves both halves through the
 * profile's own node_modules link, and confirms the host half exports the
 * shape a Cordis plugin must.
 *
 * ⚠️ 这是一条**安装预检**，不是源码测试：它检查的是「本机 profile 里的安装状态」。
 * profile 不存在（还没安装 DSH / 没装本插件）时直接跳过并说明，不算失败 ——
 * 源码完整性由 test-host.mjs / test-client.mjs 负责。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// profile 位置按**当前用户的 home** 推导，不写死任何人的机器路径。
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop');
const PKG = '@local/dsh-agent-preset-studio';

const profileManifestPath = join(PROFILE, 'package.json');
if (!existsSync(profileManifestPath)) {
  console.log('== install pre-flight ==');
  console.log(`  info no DSH profile at ${PROFILE}`);
  console.log('  info 插件尚未安装（或 profile 不在这个位置）—— 跳过安装预检。');
  console.log('  info 安装方法见 README 的「安装」一节。源码测试请跑 test-host.mjs / test-client.mjs。');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
};

console.log('\n== profile manifest ==');
const profile = JSON.parse(readFileSync(profileManifestPath, 'utf8'));
const bundles = profile.dsh?.profile?.bundles ?? [];
check('plugin is listed as a bundle', bundles.includes(PKG), bundles.join(', '));
check('plugin is a declared dependency',
  Object.prototype.hasOwnProperty.call(profile.dependencies ?? {}, PKG),
  JSON.stringify(profile.dependencies?.[PKG]));
// 依赖指向哪台机器的哪个目录因人而异，所以只断言**语义**：
// 是个 link: 且链接目标真的存在（pnpm 的 workspace 链接装法）。
// ⚠️ link: 目标可能是**绝对路径**（本机就是这么装的）也可能是相对 profile 的
// 相对路径 —— 两种都要认：绝对路径直接用，相对路径拼到 profile 下再验。
const depSpec = profile.dependencies?.[PKG];
const depTarget = typeof depSpec === 'string' && depSpec.startsWith('link:')
  ? depSpec.slice('link:'.length)
  : undefined;
const depResolves = (() => {
  if (depTarget === undefined) return false;
  // Windows 盘符（C:/）与 POSIX 根（/）都算绝对路径。
  if (/^([a-zA-Z]:[\\/]|\/)/.test(depTarget)) return existsSync(depTarget);
  return existsSync(join(PROFILE, depTarget));
})();
check('dependency is a link: that resolves to a real directory',
  depResolves, String(depSpec));

console.log('\n== resolution through the profile link ==');
const linkedRoot = join(PROFILE, 'node_modules', PKG);
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(linkedRoot, 'package.json'), 'utf8'));
  check('manifest resolves through node_modules', true);
} catch (error) {
  check('manifest resolves through node_modules', false, error.message);
  process.exit(1);
}
check('manifest name matches the bundle entry', manifest.name === PKG, manifest.name);
check('declares a bundle patch', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh?.bundle));
check('declares a client half', manifest.dsh?.client !== undefined, JSON.stringify(manifest.dsh?.client));
check('client injects the packages it touches',
  Array.isArray(manifest.dsh?.client?.inject)
  && manifest.dsh.client.inject.some((n) => n.includes('locale')),
  JSON.stringify(manifest.dsh?.client?.inject));
check('declares an icon (used by the plugins page)', typeof manifest.icon === 'string', manifest.icon);

console.log('\n== files the manifest promises ==');
for (const rel of manifest.files ?? []) {
  const ok = rel.includes('*') ? true : (() => {
    try { readFileSync(join(linkedRoot, rel)); return true; } catch { return false; }
  })();
  check(`present: ${rel}`, ok);
}
check('main entry exists', (() => {
  try { readFileSync(join(linkedRoot, manifest.main)); return true; } catch { return false; }
})(), manifest.main);

console.log('\n== patch the bundle contributes ==');
const patchPath = join(linkedRoot, manifest.dsh.bundle.patch);
const patchText = readFileSync(patchPath, 'utf8');
console.log('--- cordis.patch.yml ---');
console.log(patchText.trim());
console.log('--- end ---');
check('patch is a YAML list (comments allowed above it)',
  /^\s*-\s/m.test(patchText), patchText.split('\n')[0]);
check('patch inserts the plugin row', patchText.includes('agent-preset-studio'));
check('row name matches the package', patchText.includes(PKG), patchText.match(/name:.*/)?.[0]);

console.log('\n== host half loads ==');
const host = await import(pathToFileURL(join(linkedRoot, 'lib/index.js')).href);
check('exports a name', typeof host.name === 'string', host.name);
check('name matches the package', host.name === PKG, host.name);
check('exports apply()', typeof host.apply === 'function');
check('exports inject', Array.isArray(host.inject), JSON.stringify(host.inject));
check('inject asks for webServer', host.inject.includes('webServer'));

console.log('\n== client half is a well-formed module-loader bundle ==');
const clientText = readFileSync(join(linkedRoot, 'lib/client.js'), 'utf8');
check('calls window.__ModuleLoader__.load', clientText.includes('window.__ModuleLoader__.load'));
check('declares the matching id', clientText.includes(`id: '${PKG}'`));
check('registers a factory', clientText.includes('factory(require)') || clientText.includes('factory: (require)'));
check('requires only table-provided modules',
  !/require\(['"]\.\//.test(clientText),
  (clientText.match(/require\(['"][^'"]+['"]\)/g) ?? []).join(' '));
check('defines both dictionaries inline', clientText.includes('const zh = {') && clientText.includes('const en = {'));
// The client bundle is served to the browser, so it must not reach for node.
check('no node built-in imports', !/require\(['"]node:/.test(clientText));
check('registers the settings section', clientText.includes("'settings.section'"));
check('registers the sidebar tab type', clientText.includes('sidebarRightTabs'));
check('body key equals the tab id', /key: TAB_ID/.test(clientText) && /id: TAB_ID/.test(clientText));

console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
process.exit(fail === 0 ? 0 : 1);
