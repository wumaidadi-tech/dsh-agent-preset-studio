/**
 * @local/dsh-agent-preset-studio — 浏览器半（跑在界面上）
 *
 * 一个插件挂两个面：
 *   settings.section        —— 工作室本体：工具勾选、人设编辑、导出
 *   sidebar.right.pane.tab  —— 右侧栏面板：把「当前挂了什么」实时读出来
 *
 * 下面这些契约**都是对着 app.asar 里已发布的包实读核对过的**（详见 API-参考.md）：
 *   · ctx.locale.register(ns, {zh, en}) → disposer；ctx.locale.bind(ns) → t(key, params)
 *   · ctx.slots.inject(slot, () => ctx.slots.register({...}, Component))
 *   · 注册的组件什么时候能拿到 `t`？**当且仅当**该注册声明了 `locale: NS`。
 *     是渲染器把 bind(NS) 塞进 kit 里的（ui-renderer 的 `standardKit`）。
 *     `inject` 只负责提供「业务 share」，跟 `t` 的来源无关。
 *   · `sidebarRightTabs` 是 **Host 服务**，必须这样取：
 *     `ctx.inject(['sidebarRightTabs'], (c) => c.get('sidebarRightTabs'))`；
 *     **绝不能当属性读**。服务缺席时要容忍，不能抛。
 *   · 注册表自己的方法是 register({ id, kind, title(address), guide, keepMounted })
 *     —— 调在**服务对象**上，不是调在 ctx 上。
 *   · tab 正文是按 `entryKey = definition.id` 派发的，
 *     所以正文 slot 的 `key` **必须等于** tab 类型的 `id`。
 *
 * 语言字典**故意写成内联字面量**：__ModuleLoader__ 工厂里的 `require`
 * 只能解析「浏览器模块表」里有的模块，所以同目录的 `./locale/zh.json` 是解析不到的。
 *
 * @module @local/dsh-agent-preset-studio
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-preset-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PKG = 'dsh-agent-preset-studio';
    const TAB_ID = 'agent-preset-studio';
    const ENDPOINT = '/api/agent-preset-studio';
    const NS = 'agentPresetStudio';

    /** ------------------------------------------------------------------ */
    /** dictionaries (inline — see the header note)                         */
    /** ------------------------------------------------------------------ */

    const zh = {
      nav: 'Agent 预设工作室',
      title: 'Agent 预设工作室',
      subtitle: '挑选工具、编辑系统提示词，导出成可安装的预设包。',
      refresh: '重新扫描',
      scanning: '扫描中…',
      loading: '正在读取宿主状态…',
      tabTools: '工具',
      tabPrompt: '系统提示词',
      tabExport: '导出预设',

      // ── 两张表 = 两分法：插件工具 / 官方工具（2026-10-12 按用户要求**真正**分开）──
      // 上表 = 注册表里**没有归属包**的行：MCP 服务器工具 + 第三方插件自己注册的工具。
      // 下表 = 自带安装目录里的官方包（有归属包，预设按包名声明它们）。
      // 曾经官方工具也混在上表里（按工具名列），标题却叫「插件工具」——
      // 用户明确指出这两类必须分开，于是上表只留无归属包的行，
      // 下表改成列出**全部**官方包（不再把已挂载的藏掉）。
      toolsMounted: '插件工具',
      toolsAvailable: '官方工具',
      toolsNoMounted: '没有匹配的插件工具。',
      toolsNoAvailable: '没有匹配的官方工具。',
      // 「插件工具」表的折叠开关文案。这张表**整张禁勾**，默认收起只留摘要；
      // 展开后也是纯只读清单（没有复选框）—— 用户三次反馈「改不了要他何用」。
      pluginSectionShow: '展开看看这些工具是什么、各占多少 token',
      pluginSectionHide: '收起插件工具清单',
      pluginSectionNote: 'MCP / 第三方插件提供，预设无权开关',
      // ── 两张表共用的**一条**提示，写在一起、放两张表上方 ─────────────
      // 以前是每张表标题下各挂半句，读起来要来回拼；用户要求合成一条。
      // ⚠️ 这条提示现在描述的是**真的分开**：上面那张已经没有官方工具了。
      keyingNote: '两张表按来源分开：上面是**插件工具**，下面是**官方工具**。\n'
        + '上表是注册表里**没有归属包**的行 —— MCP 服务器提供的工具，'
        + '以及第三方插件自己注册的工具。它们由 MCP 连接器 / 插件自己管理，'
        + '预设只能声明包名，所以对它们**无权开关，请到具体插件里开关**；'
        + '整张表是只读清单（没有复选框），默认折叠，展开只为看明细和开销。\n'
        + '下表是 DSH 自带安装目录里的官方包，**全部列出来**（不再把已挂载的藏掉），'
        + '每行标了「已挂 几号/总数」和当前占用的 token —— 包还没挂上时算不出代价，'
        + '显示「未知」，那表示此刻不占上下文、不是免费。勾选后整包写进导出的预设。',
      // 官方包的 token 算不出来时的原因（包还没挂上 → 没有它的工具定义）。
      pkgTokensUnknownTitle: '这个包当前一个工具都没挂上，拿不到它的工具定义，'
        + '所以算不出 token 占用 —— 意思是「此刻不占上下文」，不是免费。',
      // 没有归属包的行为什么勾不上 —— 说得直白些，别让用户以为是坏了。
      toolNotDeclarable: '预设声明不了',
      toolNotDeclarableTitle: '这个工具不属于任何安装包（MCP 服务器提供的，或第三方插件自己注册的）。'
        + '预设只能按包名声明，所以它勾不上、也不会被写进导出的预设。'
        + '**预设无权开关，请到具体插件里开关** —— MCP 服务器提供的去 MCP 连接器，'
        + '第三方插件的工具去那个插件自己的设置里开关。',
      toolSearch: '过滤工具名 / 包名 / 说明…',
      toolSelectAll: '全选',
      toolSelectNone: '全不选',
      toolClearAll: '清空',

      // 表头：把三列各是什么讲清楚，否则用户只看到一串标识符和数字。
      colName: '工具 / 包',
      colDesc: '说明',
      colShips: '带的工具',
      colTokens: '占用 token',
      // 无归属包时的说明（不是错误，只是反查不到）。
      toolNoOwner: '第三方注册，查不到归属安装包',
      // token 算不出来时的说明。用文字而不是一个破折号 ——
      // 「—」让用户完全不知道是「为零」「不算」还是「算失败」。
      tokensUnknown: '未知',
      tokensUnknownTitle: '宿主没有提供这一行的工具定义，所以算不出 token 占用。',
      // 说明文字缺失时的兜底。
      // ⚠️ 这里**不能**写「没有标注工具清单」—— 那句话说的是「工具清单」，
      // 而这一列显示的是「这个工具/包是干嘛的」，两者不是一回事。
      // 用户明确指出过这个问题。
      descMissing: '没有提供说明文字',
      descMissingTitle: '安装包里没有写这一项的用途说明。勾选不受影响。',
      descNoZh: '第三方工具，无中文说明',
      // 说明列的显式「展开 / 收起」按钮：用户反馈点击整段文字太难发现，
      // 改成始终可见的文字按钮。按钮名按用户要求写「描述展开 / 收起描述」。
      descExpand: '描述展开',
      descCollapse: '收起描述',
      // 折叠/展开
      shipsCount: '{n} 个',
      shipsExpand: '展开',
      shipsCollapse: '收起',
      shipsShow: '查看这 {n} 个工具',
      shipsHide: '收起工具清单',
      // MCP 分组折叠：同一 MCP 服务的多个工具折叠成一行组头。
      mcpGroupCount: '{n} 个工具',
      mcpGroupShow: '展开这 {n} 个工具',
      mcpGroupHide: '收起这组工具',
      shipsNone: '未标注',
      shipsNoneTitle: '这个包的自述信息里没有列出它提供哪些工具。'
        + '这不影响勾选 —— 勾上后整包都会挂载。',
      // 每行末尾的柱状条标题。
      relativeCost: '相对占用（最大的那一项作为满格）',
      selectedCount: '{n} selected',
      selectedCountTitle: '「已选」数的是勾上的**官方包**个数 —— 勾选集里只放包名。'
        + 'MCP / 第三方插件工具没有归属包、勾不了，所以不进这个数。'
        + '旁边那个 token 合计，是这些包**当前已挂工具**的 token 之和；'
        + '包还没挂上时是 0（此刻不占上下文），不是免费。',
      estimatedTools: '估算 {n} token',

      promptHint: '对应 persona 行的 prefix 字段。complete: true 时它就是全部系统提示词。',
      promptPlaceholder: '在这里写这个预设的系统提示词…',
      loadFromPreset: '从运行时名单载入…',
      loadFromPresetTitle: '把某个现有预设的人设读进来当底稿',
      // 「载入现有预设」—— 读的是 profile patch 里的预设，
      // 连工具勾选和人设四字段一起载入，导出的「覆盖」才有意义。
      loadExisting: '载入现有预设（可覆盖）…',
      loadExistingTitle: '从 profile 的 patch 文件里读一个现有预设，人设和工具勾选一起载入',
      loadExistingMeta: '{n} 个包',
      // 系统提示词页的合并载入下拉（与工具页「从预设载入勾选」同款结构）：
      // 官方预设 + 我的预设用 optgroup 分组。**只回填人设四字段，不碰工具勾选**。
      promptLoadTitle: '选一个官方预设或现有预设，只把它的系统提示词读进来 —— 不动工具勾选',
      // 两个页面是**完全独立**的：工具页那个下拉只管勾选，这一个只管人设。
      promptLoadReplacesTools: '两个页面的载入互不影响：这里载入只改系统提示词，不碰工具勾选；工具页那个下拉只改勾选。覆盖导出用的是工具页当前的勾选，想覆盖回原样就先去工具页把同一个预设载一遍。',
      loadSelection: '从预设载入勾选…',
      loadSelectionTitle: '选一个官方预设或现有预设，只把它的工具勾选读进来 —— 不动人设四字段，也不改变编辑来源',
      loadSelectionOfficial: '官方预设',
      loadSelectionMine: '我的预设',
      existingUnavailable: '读不到 profile 里的现有预设，「载入 / 覆盖」暂时不可用 —— 但编辑和新建照常能用：',
      draftDamaged: '上次的草稿读不出来，已按全新一份处理（下面是没读到的原因）：',
      editingExisting: '正在编辑现有预设「{id}」。导出的「覆盖」会就地改写它在 patch 里的那一块；关掉开关则另存为一个新的预设。',
      hasGroups: '这个预设里有 {n} 个 cordis:group 分组。分组是整体保留或整体取消的 —— 组里还有工具被勾着，这一组就会整组留下。',
      // ── 人设四字段 ────────────────────────────────────────────────
      // 这四个字段就是一份「预设人设」的全部内容，面向小白用户的解释：
      //   · prefix（必填）—— 开场白 / 人设正文。填了：每次新会话 AI 都先读到
      //     这段话，按它扮演角色、按它干活；不填：AI 没有身份说明，全靠默认配置，
      //     等于没有定制人设。
      //   · suffix（选填）—— 结尾补充说明。填了：AI 处理问题时还会参考这段
      //     结尾，里面可写 {{model}}（模型名）等已注册变量，会自动替换成真实值。
      //     ⚠️ 不要写 {{cwd}}：DSH 0.2.1 起不再注册该变量，写了会让提示词组装
      //     直接报错（unknown prompt variable）。当前工作目录已由 includeRuntimeContext
      //     自动注入的运行时上下文提供，无需再写一遍。
      //     不填：这段留空会遮蔽全局后缀，即部署级配置里的
      //     全局结尾补充也不会用进来。
      //   · complete（开关）—— 开：你写的这段 prefix 就是唯一的系统提示词，
      //     身份、结尾、工具引导、监听器追加的内容统统不再加进来，你写什么就是
      //     什么；关：只当作开头，其余按部署级配置继续补齐。
      //   · includeRuntimeContext（开关，默认开）—— 开：AI 能看到时间、工作目录
      //     等环境上下文，回答更贴合实际；关：这些环境信息全部屏蔽，AI 在纯净
      //     上下文里工作。
      prefixHint: '必填。人设正文，渲染成 deployment:persona-prefix 段落。',
      suffixHint: '选填。渲染成 deployment:persona-suffix 模板；留空会遮蔽全局后缀。支持 {{model}} 这类变量；不要写 {{cwd}}（DSH 0.2.1 起不再注册，工作目录已由运行时上下文自动提供）。',
      suffixPlaceholder: '例如：Always answer in English.',
      personaSwitches: '人设语义开关',
      completeLabel: 'complete —— 这段 prefix 就是全部系统提示词',
      completeHint: '开：身份、后缀、工具引导、监听器追加的内容全部无法再加进来，你写什么就是什么。关：只当作前缀，其余按部署级配置补齐。',
      contextLabel: 'includeRuntimeContext —— 保留运行时上下文',
      contextHint: '关：这一层会抑制所有上下文贡献（时间、工作目录等），模型看不到它们。开（默认）：上下文照常注入。',
      rosterUnavailable: '读不到预设名单，「从运行时名单载入」暂时不可用 —— 但编辑器照常能用：',
      chars: '{n} 字符',
      estTokens: '≈{n} token',
      estTokensNote: '估算规则与宿主一致：4 字符 ≈ 1 token。中文实际约为此值的 1.5 倍。',

      exportPresetId: '预设 id',
      exportPresetIdHint: '新会话里选择用的标识符，只能用小写字母、数字和连字符',
      exportPresetIdHintOverwrite: '保持和原来一致 —— 改了就变成另存为一个新预设了',
      exportPresetName: '显示名',
      exportPresetNameHint: '留空则用 id',
      exportPresetDesc: '描述',
      exportPresetDescHint: '在选择卡片里显示的一行说明',
      exportPresetOrder: '排序',
      exportPresetOrderHint: '数字，越小越靠前',
      exportOutDir: '输出目录',
      exportMode: '导出方式',
      exportModeNew: '另存为一个新预设',
      exportModeOverwrite: '覆盖原预设',
      exportModeNewHint: '生成一个 bundle 目录并交给 Plugin Manager 安装。不碰你的 patch 文件。',
      exportModeOverwriteHint: '就地改写 patch 文件里那个预设的那一块，写前自动备份。',
      exportModeOverwriteLocked: '先在「系统提示词」页载入一个现有预设，才能覆盖它 —— 否则无从知道该改哪一块。',
      exportOverwriteDetail: '将改写 {file} 里 id 为 {id} 的那一块。\n写入前会先备份成 cordis.patch.yml.bak-studio-<时间戳>。\n只重写你改动过的部分：没动的那几行连同你手写的注释原样保留。改动只对**新会话**生效。',
      exportSave: '生成并安装',
      exportOverwriteRun: '覆盖写回 patch',
      exportSaving: '正在生成…',
      exportDone: '预设包已生成。',
      exportOverwriteDone: '已覆盖写回 patch 文件。',
      exportBackup: '备份：',
      exportLines: 'patch 行数 {before} → {after}（变少了说明你取消勾选的那些行连同注释一起去掉了）',
      exportRebuiltFallback: '⚠️ 没能按行重建，本次是整块重写 —— 那一块里的手写注释可能已经丢失（备份里有原文）。',
      exportFailed: '生成失败。',
      exportWarning: '警告',
      exportPreview: '生成的 cordis.patch.yml',
      exportNeedId: '请先填写预设 id。',
      exportNeedPersona: '还没写系统提示词 —— 导出的预设会沿用部署级人设。',

      sidebarTitle: 'Agent 预设',
      sidebarHint: '查看已注册工具与预设构成',
      sidebarCurrent: '当前会话预设',
      sidebarTools: '已注册工具行',
      sidebarPromptTokens: '人设 token',
      sidebarOpen: '打开工作室',

      errNoHost: '读不到宿主数据 —— 宿主半可能没起来。',
    };

    const en = {
      nav: 'Agent preset studio',
      title: 'Agent preset studio',
      subtitle: 'Pick tools, edit the system prompt, export an installable preset bundle.',
      refresh: 'Rescan',
      scanning: 'Scanning…',
      loading: 'Reading host state…',
      tabTools: 'Tools',
      tabPrompt: 'System prompt',
      tabExport: 'Export',

      toolsMounted: 'Plugin tools',
      toolsAvailable: 'Official tools',
      toolsNoMounted: 'No plugin tool matches.',
      toolsNoAvailable: 'No official tool matches.',
      pluginSectionShow: 'Expand to see what these tools are and what they cost',
      pluginSectionHide: 'Collapse the plugin tool list',
      pluginSectionNote: 'supplied by MCP / third-party plugins — a preset cannot switch them',
      toolNotDeclarable: 'preset cannot declare this',
      toolNotDeclarableTitle: 'This tool belongs to no install package — an MCP server supplies it, or a third-party plugin registers it. '
        + 'A preset can only declare package names, so it cannot be ticked and will never be written into an exported preset. '
        + '**A preset has no authority over those switches — flip them in the owning plugin** '
        + '(MCP servers via the MCP connector, third-party tools inside that plugin\'s own settings).',
      pkgTokensUnknownTitle: 'None of this package\'s tools is currently mounted, so its tool definitions are unavailable '
        + 'and its token cost cannot be estimated. That means "costs nothing right now", not "free".',
      toolSearch: 'Filter by tool, package or description…',
      toolSelectAll: 'Select all',
      toolSelectNone: 'Select none',
      toolClearAll: 'Clear',

      colName: 'Tool / package',
      colDesc: 'Description',
      colShips: 'Tools',
      colTokens: 'Tokens',
      toolNoOwner: 'Registered third-party; no owning install package found',
      tokensUnknown: 'n/a',
      tokensUnknownTitle: 'The host supplied no tool definition for this row, so its token cost cannot be estimated.',
      descMissing: 'No description provided',
      descMissingTitle: 'The install package documents no purpose for this entry. Ticking it is unaffected.',
      descNoZh: 'Third-party tool; no Chinese description',
      descExpand: 'Expand',
      descCollapse: 'Collapse',
      shipsCount: '{n}',
      shipsExpand: 'Expand',
      shipsCollapse: 'Collapse',
      shipsShow: 'Show the {n} tools',
      shipsHide: 'Hide the tool list',
      mcpGroupCount: '{n} tools',
      mcpGroupShow: 'Show the {n} tools',
      mcpGroupHide: 'Collapse this group',
      shipsNone: 'not listed',
      shipsNoneTitle: 'The install package\u2019s own description does not say which tools it provides. '
        + 'Ticking it still mounts the whole package.',
      relativeCost: 'Relative cost (the largest row is full width)',
      selectedCount: '{n} selected',
      selectedCountTitle: 'The count tallies the official packages ticked — the selection set holds package names only. '
        + 'MCP and third-party plugin tools have no owning package and cannot be ticked, so they never enter this count. '
        + 'The token total beside it sums those packages\' currently mounted tools; an unmounted package contributes 0 '
        + '(it costs nothing right now), which is not the same as free.',
      estimatedTools: '≈{n} tokens',

      keyingNote: 'The two tables are split by source: plugin tools on top, official tools below.\n'
        + 'The top table holds registry rows with **no owning package** — tools supplied by MCP servers, '
        + 'plus tools a third-party plugin registers itself. The MCP connector or the plugin owns those switches: '
        + 'a preset declares package names only, so it has no authority over them — flip them in the owning plugin. '
        + 'That table is a read-only list (no checkboxes at all) and starts collapsed; expand it only to see what '
        + 'those tools are and what they cost.\n'
        + 'The bottom table lists the official packages in the built-in install directory — **all of them** '
        + '(nothing mounted is hidden any more), each marked with "mounted n/total" and its current token cost. '
        + 'A package with no tool mounted cannot be costed; it shows "n/a", meaning "costs nothing right now", '
        + 'not "free". Ticking one writes the whole package into the exported preset.',

      promptHint: 'Maps to the persona row\u2019s `prefix`. With complete: true it is the whole system prompt.',
      promptPlaceholder: 'Write this preset\u2019s system prompt here\u2026',
      loadFromPreset: 'Load from the roster\u2026',
      loadFromPresetTitle: 'Read an existing preset\u2019s persona in as a starting point',
      loadExisting: 'Load an existing preset\u2026',
      loadExistingTitle: 'Read a preset out of the profile\u2019s patch file \u2014 persona and tool ticks both',
      loadExistingMeta: '{n} pkgs',
      promptLoadTitle: 'Pick an official or existing preset and load only its system prompt \u2014 the tool ticks stay untouched',
      promptLoadReplacesTools: 'The two tabs are independent: this select only changes the system prompt and never touches the tool ticks; the tools-tab select only changes the ticks. Overwrite export uses the tools-tab ticks, so load the same preset there first if you want to overwrite back to its original list.',
      loadSelection: 'Load selection from preset\u2026',
      loadSelectionTitle: 'Pick an official or existing preset and import only its tool ticks \u2014 persona fields and the edit source stay untouched',
      loadSelectionOfficial: 'Official presets',
      loadSelectionMine: 'My presets',
      existingUnavailable: 'Existing presets in the profile could not be read, so "load / overwrite" is unavailable \u2014 editing and new presets still work:',
      draftDamaged: 'The last draft could not be read, so this is a fresh one (the reason it could not be read is below):',
      editingExisting: 'Editing the existing preset "{id}". Exporting in overwrite mode rewrites its block in the patch in place; turn the switch off to save it as a new preset instead.',
      hasGroups: 'This preset holds {n} cordis:group group(s). A group is kept or dropped whole \u2014 while any tool inside it stays ticked, the whole group stays.',
      prefixHint: 'Required. The persona body, rendered as the deployment:persona-prefix section.',
      suffixHint: 'Optional. Rendered as the deployment:persona-suffix template; leaving it empty masks the global suffix. Supports variables such as {{model}}; do NOT use {{cwd}} (no longer registered since DSH 0.2.1 — the working directory is supplied by the runtime context).',
      suffixPlaceholder: 'e.g. Always answer in English.',
      personaSwitches: 'Persona semantics',
      completeLabel: 'complete \u2014 this prefix is the whole system prompt',
      completeHint: 'On: identity, suffix, tool guidance and listener contributions can no longer be appended \u2014 what you write is what runs. Off: treat it as a prefix and let the deployment-level config fill in the rest.',
      contextLabel: 'includeRuntimeContext \u2014 keep runtime context',
      contextHint: 'Off: every context contribution is suppressed at this scope (time, working directory, \u2026) so the model cannot see them. On (default): context is injected as usual.',
      rosterUnavailable: 'The preset roster could not be read, so "load from the roster" is unavailable \u2014 the editor still works:',
      chars: '{n} chars',
      estTokens: '≈{n} tokens',
      estTokensNote: 'Same rule the host uses: 4 characters \u2248 1 token. CJK runs nearer 1.5\u00d7 that.',

      exportPresetId: 'Preset id',
      exportPresetIdHint: 'The identifier you pick a new session with; lower-case letters, digits and dashes',
      exportPresetIdHintOverwrite: 'Keep it identical \u2014 change it and this becomes a new preset instead',
      exportPresetName: 'Display name',
      exportPresetNameHint: 'Falls back to the id',
      exportPresetDesc: 'Description',
      exportPresetDescHint: 'The one-line blurb on the preset card',
      exportPresetOrder: 'Order',
      exportPresetOrderHint: 'Lower sorts first',
      exportOutDir: 'Output directory',
      exportMode: 'How to export',
      exportModeNew: 'Save as a new preset',
      exportModeOverwrite: 'Overwrite the existing preset',
      exportModeNewHint: 'Generate a bundle directory and hand it to Plugin Manager. Your patch file is not touched.',
      exportModeOverwriteHint: 'Rewrite that preset\u2019s block in the patch file in place, taking a backup first.',
      exportModeOverwriteLocked: 'Load an existing preset on the "System prompt" tab first \u2014 until then there is no block to rewrite.',
      exportOverwriteDetail: 'Will rewrite the block for id "{id}" in {file}.\nA backup named cordis.patch.yml.bak-studio-<timestamp> is taken before writing.\nOnly the parts you changed are rewritten: untouched lines keep your own comments verbatim. Changes apply to NEW sessions only.',
      exportSave: 'Generate and install',
      exportOverwriteRun: 'Overwrite the patch',
      exportSaving: 'Generating\u2026',
      exportDone: 'Preset bundle generated.',
      exportOverwriteDone: 'Written back over the patch file.',
      exportBackup: 'Backup:',
      exportLines: 'patch line count {before} \u2192 {after} (a drop means the rows you de-selected went away together with their comments)',
      exportRebuiltFallback: '\u26a0\ufe0f Could not rebuild row by row, so the whole block was rewritten \u2014 hand-written comments in it may be gone (the backup has the original).',
      exportFailed: 'Generation failed.',
      exportWarning: 'Warning',
      exportPreview: 'Generated cordis.patch.yml',
      exportNeedId: 'Fill in a preset id first.',
      exportNeedPersona: 'No system prompt yet — the exported preset will inherit the deployment persona.',

      sidebarTitle: 'Agent preset',
      sidebarHint: 'Inspect registered tools and preset composition',
      sidebarCurrent: 'This session\u2019s preset',
      sidebarTools: 'Registered tool rows',
      sidebarPromptTokens: 'Persona tokens',
      sidebarOpen: 'Open studio',

      errNoHost: 'No host data — the host half may not be running.',
    };

    /** ------------------------------------------------------------------ */
    /** host calls                                                          */
    /** ------------------------------------------------------------------ */

    /**
     * 调宿主。
     * 「请求卡住」必须表现为一个错误，而不是留一个转圈给用户看，
     * 所以每一次调用都自带超时上限。
     */
    const post = async (path, body, timeoutMs = 12000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${ENDPOINT}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`The host did not answer ${path} within ${timeoutMs} ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    /**
     * 【中文】GET / PUT 都要发的调用（草稿存取是 GET+PUT，不是纯 POST）。
     *
     * 与 `post` 共用同一套超时上限语义：卡住必须表现为错误，
     * 不能留一个转圈给用户看。
     */
    const send = async (path, method, body, timeoutMs = 12000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${ENDPOINT}/${path}`, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`The host did not answer ${path} within ${timeoutMs} ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    /**
     * 【中文】草稿防抖保存器。
     *
     * 勾选状态之前只活在前端内存里 —— 切到别的设置页再回来，组件重挂载，
     * 选择全清空（用户原话：「我选好之后，不小心取消了，选好的就没了」）。
     * 现在存到宿主文件，但**不能每点一下就写一次**：勾选是逐个点，
     * 每点一次写盘既吵又没意义。500ms 内的连续改动合并成一次写入。
     */
    const createDraftSaver = (store, delayMs = 500) => {
      let timer;
      let lastWritten;
      return (immediate) => {
        if (timer !== undefined) clearTimeout(timer);
        const state = store.get();
        const payload = {
          selected: [...state.selected],
          personaFields: state.personaFields,
          source: state.source,
        };
        // 内容没变就不写 —— 免得打开页面就产生一次无意义的磁盘写入。
        const key = JSON.stringify(payload);
        if (key === lastWritten) return;
        const write = () => {
          lastWritten = key;
          send('draft', 'PUT', payload, 4000).catch(() => {
            // 存草稿失败**不打断用户** —— 他正在编辑，别用弹窗打断他。
            // 真失败了下次打开就没了，但界面上的正事一点不受影响。
          });
        };
        if (immediate === true) write();
        else timer = setTimeout(write, delayMs);
      };
    };

    /** ------------------------------------------------------------------ */
    /** helpers                                                             */
    /** ------------------------------------------------------------------ */

    /** DSH's own estimator: 4 characters per token. */
    const estimateTokens = (text) => (typeof text === 'string' && text.length > 0
      ? Math.ceil(text.length / 4)
      : 0);

    const formatNumber = (n) => (typeof n === 'number' && Number.isFinite(n)
      ? n.toLocaleString()
      : '—');

    const LAYER = {
      1: 'var(--dsw-alias-bg-layer-1)',
      2: 'var(--dsw-alias-bg-layer-2)',
      3: 'var(--dsw-alias-bg-layer-3)',
    };
    const LABEL = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      quaternary: 'var(--dsw-alias-label-quaternary)',
    };
    const BORDER = 'var(--dsw-alias-border-l2)';
    const MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)';

    /** Shared style objects, built from theme tokens only. */
    const S = {
      root: {
        display: 'flex', flexDirection: 'column',
        height: '100%', minHeight: 0,
        color: LABEL.primary,
        fontSize: 13, lineHeight: 1.55,
      },
      header: { padding: '24px 0 0', flex: 'none' },
      title: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      subtitle: { margin: '4px 0 0', color: LABEL.secondary, fontSize: 12.5 },
      tabBar: {
        display: 'flex', alignItems: 'flex-end', gap: 2,
        marginTop: 18, flex: 'none',
        borderBottom: `1px solid ${BORDER}`,
      },
      tab: (active) => ({
        appearance: 'none', background: 'transparent', border: 0,
        borderBottom: `2px solid ${active ? LABEL.primary : 'transparent'}`,
        color: active ? LABEL.primary : LABEL.secondary,
        font: 'inherit', fontSize: 13, cursor: 'pointer',
        padding: '6px 12px', marginBottom: -1,
      }),
      body: { flex: 'auto', minHeight: 0, overflowY: 'auto', padding: '16px 0 40px' },
      section: {
        border: `1px solid ${BORDER}`,
        background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
        borderRadius: 10, marginBottom: 12, overflow: 'hidden',
      },
      sectionHead: {
        display: 'flex', alignItems: 'baseline', gap: 8,
        padding: '10px 14px',
        borderBottom: `1px solid ${BORDER}`,
        background: LAYER[2],
      },
      sectionTitle: { fontWeight: 600, flex: 'none' },
      sectionHint: {
        color: LABEL.tertiary, fontSize: 11.5, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      sectionBody: { padding: '6px 14px 10px' },
      row: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 0', minWidth: 0,
      },
      rowName: {
        fontFamily: MONO, fontSize: 12, flex: 'none', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowDesc: {
        color: LABEL.tertiary, fontSize: 11.5,
        flex: 1, minWidth: 0,
        // 横向排布：中文语境标签 + 说明正文。
        // 没有前缀时只有一个子元素，布局退化成「单行省略」，和以前一样。
        display: 'flex', alignItems: 'center', minWidth: 0,
        overflow: 'hidden', whiteSpace: 'nowrap',
      },
      // 说明正文（跟在中文标签后面那一段）。自己负责溢出省略，
      // 因为外层 rowDesc 是 flex 容器，省略号必须落在最内层的文本节点上。
      descText: {
        flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      // 说明正文**展开态**：不再省略、允许换行。
      // 已挂表的长描述默认单行省略（descText），点击展开后切到这一档，
      // 再点一次收起。可挂表的说明通常是短中文，保持不展开。
      descTextOpen: {
        flex: 1, minWidth: 0,
        whiteSpace: 'normal', wordBreak: 'break-word',
        // 兜底：长 URL / 无空格长串在窄容器里也能安全断行，
        // 不会退化成「一个字母站一行」。
        overflowWrap: 'anywhere',
        lineHeight: 1.5,
      },
      // 说明列里的**中文语境前缀**（方括号标签）。
      // 用途：已挂行的说明是工具自己的英文 description（模型看到的原文），
      // 直接显示会和整张表的中文表头打架（用户截图反馈「中英文怎么混了」）。
      // 这里给英文原文配一段中文归属语境，读起来是中英对照：
      //   ［文件读写］Read a file from the local filesystem.
      // 做成定宽收缩的标签，把剩余空间让给后面的英文原文。
      descTag: {
        flex: '0 1 auto', minWidth: 0,
        marginRight: 6,
        padding: '0 5px', borderRadius: 4,
        fontSize: 10.5, lineHeight: '16px',
        color: LABEL.secondary,
        background: LAYER[2],
        border: `1px solid ${BORDER}`,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      },
      // 「查不到中文说明」的灰标签：比语境标签再淡一档（quaternary），
      // 一眼就知道这是英文说明、没有中文对照，而不是一行普通文字。
      descTagThirdParty: {
        flex: '0 1 auto', minWidth: 0,
        marginRight: 6,
        padding: '0 5px', borderRadius: 4,
        fontSize: 10.5, lineHeight: '16px',
        color: LABEL.quaternary,
        background: LAYER[2],
        border: `1px solid ${BORDER}`,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      },
      // 说明列的显式「展开 / 收起」小按钮。用户反馈「点击整段文字」太难发现，
      // 改成始终可见的文字按钮：折叠态显示「展开」，展开态显示「收起」。
      descToggle: {
        flex: 'none', cursor: 'pointer', userSelect: 'none',
        marginLeft: 6,
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10.5, lineHeight: '16px', padding: '0 6px',
        borderRadius: 4,
        border: `1px solid ${BORDER}`,
        background: 'transparent',
        color: LABEL.secondary,
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      },
      // MCP 分组折叠：同一 MCP 服务的多个工具折叠成一行组头，
      // 组头显示服务名 + 工具数 + 展开三角；展开后组内每行仍独立勾选。
      mcpGroup: { margin: '2px 0 0' },
      mcpGroupHead: {
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '6px 8px', margin: '2px 0',
        borderRadius: 6,
        border: `1px solid ${BORDER}`,
        background: LAYER[2],
        color: LABEL.secondary, fontSize: 11.5,
        cursor: 'pointer', userSelect: 'none', textAlign: 'left',
      },
      mcpGroupCaret: { flex: 'none', fontSize: 10, color: LABEL.tertiary },
      mcpGroupTitle: { fontFamily: MONO, fontWeight: 600, minWidth: 0 },
      mcpGroupMeta: { color: LABEL.tertiary, fontSize: 10.5 },
      // 展开后的**组体**：整体左缩进 + 左边框竖线，形成「二级页面」的
      // 视觉层级 —— 用户反馈展开后组内行和普通行长得一模一样，
      // 看不出谁属于哪个组。加了这条线之后，组内成员一眼就能和
      // 顶层单行工具区分开。
      mcpGroupBody: {
        display: 'flex', flexDirection: 'column', gap: 2,
        margin: '2px 0 4px 10px', paddingLeft: 12,
        borderLeft: `2px solid ${BORDER}`,
      },
      // 「这个包带的工具」列 —— 默认只显示一个可点的摘要徽标，点开才铺开全部工具名。
      // 为什么要折叠：有的包带 10+ 个工具，横着铺满一行还会被截断成 `...`，
      // 既看不全也把右边那列挤走。折叠后默认一眼能扫完所有行。
      //
      // 这一列**定宽**（不随内容伸缩）：徽标本身很窄且宽度稳定，
      // 定宽能让「说明」列安稳地占据剩余空间，而不会在展开时被挤扁。
      rowShips: {
        flex: '0 0 auto', minWidth: 0,
        display: 'flex', alignItems: 'center', gap: 6,
        justifyContent: 'flex-start',
      },
      // 表头里「带的工具」那一格：给它一个和行内徽标大致对齐的宽度。
      // ⚠️ 现在**只有可挂表**在用（已挂表没有这一列）。
      rowShipsHead: {
        flex: '0 0 auto', width: 92,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      // 折叠开关：长得像徽标，带一个小三角提示可点。
      shipsToggle: (open) => ({
        flex: 'none', cursor: 'pointer', userSelect: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, lineHeight: '18px', padding: '0 7px',
        borderRadius: 999,
        border: `1px solid ${BORDER}`,
        background: open ? 'var(--dsw-alias-fill-tsp-secondary)' : 'transparent',
        color: open ? LABEL.secondary : LABEL.tertiary,
        whiteSpace: 'nowrap',
      }),
      // 展开后的浮层：工具名逐个排开，兼容长名字自动换行。
      shipsPanel: {
        flex: 1, minWidth: 0,
        display: 'flex', flexWrap: 'wrap', gap: 4,
        padding: '3px 0',
      },
      shipsChip: {
        fontFamily: MONO, fontSize: 11, lineHeight: '17px',
        padding: '0 6px', borderRadius: 4,
        border: `1px solid ${BORDER}`,
        background: LAYER[2],
        color: LABEL.secondary,
        whiteSpace: 'nowrap',
      },
      // 「这个包没有标注工具清单」的说明文字（信息缺失，不是错误，所以用中性色）。
      shipsMissing: {
        flex: 1, minWidth: 0, fontSize: 11.5, color: LABEL.tertiary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowMeta: {
        color: LABEL.secondary, fontSize: 11,
        fontVariantNumeric: 'tabular-nums', flex: 'none',
        display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end',
      },
      // 列头：和行同样的布局，这样三列能对齐；颜色比正文更淡，不抢视线。
      colHead: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 14px 4px',
        color: LABEL.tertiary, fontSize: 10.5,
        borderBottom: `1px solid ${BORDER}`,
        marginBottom: 2,
      },
      // 数值 + 柱状条的横向容器。
      metaValue: { display: 'flex', alignItems: 'center', gap: 6 },
      // 柱状条的轨道（背景）与填充（前景）。
      // 宽度基准是「最贵的已挂行」，所以填充比例是相对的，不是绝对值。
      barTrack: {
        display: 'inline-block', width: 42, height: 4, borderRadius: 2,
        background: 'var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,0.18))',
        overflow: 'hidden', flex: 'none',
      },
      barFill: {
        display: 'block', height: '100%', borderRadius: 2,
        background: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      },
      badge: (on) => ({
        flex: 'none', fontSize: 10, lineHeight: '16px', padding: '0 6px',
        borderRadius: 999,
        border: `1px solid ${on ? 'transparent' : BORDER}`,
        background: on ? 'var(--dsw-alias-fill-tsp-secondary)' : 'transparent',
        color: on ? LABEL.secondary : LABEL.tertiary,
        whiteSpace: 'nowrap',
      }),
      input: {
        boxSizing: 'border-box', width: '100%',
        border: `1px solid ${BORDER}`,
        background: LAYER[2],
        color: LABEL.primary,
        font: 'inherit', fontSize: 12.5,
        borderRadius: 6, padding: '5px 10px', outline: 'none',
      },
      textarea: {
        boxSizing: 'border-box', width: '100%',
        border: `1px solid ${BORDER}`,
        background: LAYER[2],
        color: LABEL.primary,
        fontFamily: MONO,
        fontSize: 12.5, lineHeight: 1.6,
        borderRadius: 8, padding: '10px 12px', outline: 'none',
        resize: 'vertical',
      },
      field: { marginBottom: 10 },
      label: { display: 'block', fontSize: 12, marginBottom: 4 },
      labelHint: { color: LABEL.tertiary, fontSize: 11, marginLeft: 6 },
      button: (kind) => ({
        appearance: 'none', font: 'inherit', fontSize: 12.5, cursor: 'pointer',
        borderRadius: 6, padding: '5px 14px',
        border: `1px solid ${kind === 'primary' ? 'transparent' : BORDER}`,
        background: kind === 'primary' ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
        color: kind === 'primary' ? LAYER[3] : LABEL.primary,
      }),
      buttonSmall: {
        appearance: 'none', font: 'inherit', fontSize: 11.5, cursor: 'pointer',
        borderRadius: 5, padding: '2px 9px',
        border: `1px solid ${BORDER}`,
        background: 'transparent', color: LABEL.secondary,
      },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: 8,
        flexWrap: 'wrap', marginBottom: 12,
      },
      note: (tone) => ({
        borderRadius: 7, padding: '8px 11px', fontSize: 11.5, lineHeight: 1.6,
        marginTop: 8,
        background: LAYER[2],
        border: `1px solid ${BORDER}`,
        color: tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : LABEL.secondary,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }),
      pre: {
        margin: '8px 0 0', padding: '10px 12px',
        background: LAYER[2],
        border: `1px solid ${BORDER}`,
        borderRadius: 8, overflowX: 'auto',
        fontFamily: MONO,
        fontSize: 11.5, lineHeight: 1.6,
        color: LABEL.secondary,
        maxHeight: 340,
      },
      empty: {
        color: LABEL.tertiary, fontSize: 12, padding: '10px 0',
      },
      count: {
        color: LABEL.secondary, fontSize: 11.5,
        fontVariantNumeric: 'tabular-nums', marginLeft: 'auto', flex: 'none',
      },
      kpi: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0' },
      kpiValue: { fontFamily: MONO, fontSize: 13, fontVariantNumeric: 'tabular-nums' },
      kpiLabel: { color: LABEL.tertiary, fontSize: 11.5 },
    };

    /** ------------------------------------------------------------------ */
    /** shared store                                                        */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】每个界面一份 store，所以两个实例不会互相抢草稿。
     *
     * ⚠️ 但 store 是**纯内存**的：组件卸载重挂（切到别的设置页再回来、
     * 界面刷新、重开窗口）就会重建，选择全清空。所以它必须在挂载时
     * 从宿主文件恢复草稿（见 restoreDraft），并在改动时存回去。
     */
    function createStudioStore() {
      let state = {
        loading: true,
        error: undefined,
        snapshot: undefined,
        selected: new Set(),
        selectionSeeded: false,
        // 人设四字段。默认值刻意等于 dsh-persona 的**默认值**，
        // 而不是上一版硬编码的行为 —— 载入现有预设时如实显示，
        // 新建时才用用户自己拨过的开关。
        personaFields: {
          prefix: '',
          suffix: '',
          complete: false,
          includeRuntimeContext: true,
        },
        // 当前编辑的是哪个预设。undefined = 新建。
        source: undefined,
        personaSource: undefined,
        personaError: undefined,
        draftError: undefined,
        // 现有预设列表（profile patch 里读出来的）
        existingPresets: [],
        existingError: undefined,
        exporting: false,
        exportResult: undefined,
        // 覆盖 vs 另存：界面上给开关，两种都支持
        overwrite: false,
      };
      const listeners = new Set();
      const emit = () => { for (const fn of [...listeners]) fn(); };
      const set = (patch) => { state = { ...state, ...patch }; emit(); };
      return {
        get: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set,
      };
    }

    /** ------------------------------------------------------------------ */
    /** data loading                                                        */
    /** ------------------------------------------------------------------ */

    /** Read mounted tools + available packages + the preset roster. */
    const loadSnapshot = async (store) => {
      store.set({ loading: true, error: undefined });
      try {
        const snapshot = await post('snapshot', {});
        if (snapshot?.ok !== true) {
          throw new Error(snapshot?.error ?? 'unknown host error');
        }
        const before = store.get();
        // 用「当前已挂的工具」初始化勾选集，**只做一次**：
        // 重新扫描不能把用户已经勾好的选择悄悄清掉。
        // ⚠️ 只收**有归属包**的行。官方工具能反查到归属包（键 = 包名），
        // 所以初始状态就是「现在挂着的那些包」。
        // 没有归属包的（MCP 服务器工具、第三方插件自己注册的工具）在界面上是
        // **禁用复选框**（预设声明不了它们，见 renderMountedRow 的注释），
        // 塞进勾选集只会让「已选 N」虚高、并在导出时全部落进「未能落地」。
        const selected = before.selectionSeeded === true
          ? before.selected
          : new Set((snapshot.mounted ?? [])
              .map((row) => row.package)
              .filter((key) => typeof key === 'string' && key !== ''));
        store.set({
          snapshot,
          loading: false,
          error: undefined,
          selected,
          selectionSeeded: true,
          // 宿主读名单超时了，这件事值得显示出来；
          // 但它**不是页面的失败** —— 别的功能照常可用。
          rosterError: snapshot.presetError,
        });
      } catch (error) {
        store.set({ loading: false, error: error?.message ?? String(error) });
      }
    };

    /**
     * 【中文】从宿主文件恢复草稿（勾选 + 人设四字段 + 编辑来源）。
     *
     * 必须在 `loadSnapshot` **之前**跑：否则快照会先用「已挂工具」
     * 初始化勾选集，把草稿里的选择覆盖掉。
     *
     * 草稿里的键可能是**包名**（用户从「可挂」表勾的），
     * 而 mounted 是工具名 —— 两边都要留着，所以原样恢复，不做映射。
     * @param store - 目标 store。
     */
    const restoreDraft = async (store) => {
      try {
        const result = await send('draft', 'GET', undefined, 4000);
        const draft = result?.draft;
        if (draft === null || typeof draft !== 'object') return;
        const selected = Array.isArray(draft.selected)
          ? new Set(draft.selected.filter((k) => typeof k === 'string' && k !== ''))
          : undefined;
        const fields = draft.personaFields !== null && typeof draft.personaFields === 'object'
          ? draft.personaFields
          : undefined;
        const source = draft.source !== null && typeof draft.source === 'object'
          ? draft.source
          : undefined;
        // 一个字段都没有 → 没什么可恢复的，别把 store 写成空壳。
        if (selected === undefined && fields === undefined && source === undefined) return;
        store.set({
          ...(selected === undefined ? {} : { selected, selectionSeeded: true }),
          ...(fields === undefined ? {} : {
            personaFields: {
              prefix: typeof fields.prefix === 'string' ? fields.prefix : '',
              suffix: typeof fields.suffix === 'string' ? fields.suffix : '',
              complete: fields.complete === true,
              includeRuntimeContext: fields.includeRuntimeContext === false ? false : true,
            },
          }),
          ...(source === undefined ? {} : { source }),
          // 草稿文件坏了要如实说，但**不要**让工作室打不开。
          draftError: typeof result.error === 'string' ? result.error : undefined,
        });
      } catch {
        // 读不到草稿（老宿主半没这条路由等）不是错误 —— 正常退化成「不恢复」。
      }
    };

    /**
     * 【中文】读 profile patch 里的现有预设（「载入现有预设」下拉的数据源）。
     * @param store - 目标 store。
     */
    const loadExistingPresets = async (store) => {
      try {
        const result = await send('profile-presets', 'GET', undefined, 8000);
        if (result?.ok !== true) {
          store.set({ existingError: result?.error ?? 'unknown host error' });
          return;
        }
        store.set({
          existingPresets: Array.isArray(result.presets) ? result.presets : [],
          existingError: undefined,
        });
      } catch (error) {
        store.set({ existingError: error?.message ?? String(error) });
      }
    };

    /**
     * 合并载入下拉去重：官方预设（roster）与我的预设（profile patch）同名时，
     * 只保留官方那一条，避免同一预设在两个 optgroup 各出现一次。
     *
     * 比较依据 = 两个下拉里**显示出来的名字**（与渲染字面量严格一致）：
     *   官方 `p.name ?? p.id`；我的 `p.name === '' ? p.presetId : p.name`。
     * 官方 roster 的 id 与我的 presetId 实际对应关系以显示名为准 ——
     * 截图里 llama-local / 提示词·迭代 / 日常·任务 两边显示名完全相同。
     * 去重只影响「我的预设」optgroup 的渲染；onChange 的路由判断不变：
     * 保留的官方选项仍走 preset 路由（value=p.id），保留的我的选项仍走
     * loadExistingPreset（value=presetId）。
     * @param mine - `profile-presets` 返回的一条（我的预设）。
     * @param rosterList - 官方运行时名单（snapshot.presets 过滤 broken 后）。
     * @returns 该我的预设是否与官方同名（是则不再渲染）。
     */
    const isDuplicatedMine = (mine, rosterList) => {
      const mineName = (mine?.name === '' ? mine?.presetId : mine?.name) ?? '';
      return rosterList.some((r) => (r?.name ?? r?.id ?? '') === mineName);
    };

    /**
     * 【中文】载入一个现有预设到编辑器。
     *
     * ⚠️ 只写**系统提示词页的东西**（人设四字段 + source），**不写 `selected`**。
     * 工具勾选归工具页那个下拉管，两个页面互不影响 —— 这是用户明确要的行为。
     * 需要连工具清单一起换，就去工具页用那边的下拉载一次。
     *
     * 覆盖导出用的 `packages` 取自 `state.selected`（即工具页当前勾选），
     * 所以想覆盖回原样，得先在工具页把那个预设载一遍。
     *
     * @param store - 目标 store。
     * @param preset - `profile-presets` 返回的一条。
     */
    const loadExistingPreset = (store, preset) => {
      if (preset === null || typeof preset !== 'object') return;
      const fields = preset.persona ?? {};
      store.set({
        personaFields: {
          prefix: typeof fields.prefix === 'string' ? fields.prefix : '',
          suffix: typeof fields.suffix === 'string' ? fields.suffix : '',
          complete: fields.complete === true,
          includeRuntimeContext: fields.includeRuntimeContext === false ? false : true,
        },
        // source 记住是从哪个预设来的 —— 覆盖写要知道往哪个 topId 上写。
        source: {
          mode: 'existing',
          presetId: preset.presetId,
          topId: preset.topId,
          name: preset.name,
          order: preset.order,
          groups: Array.isArray(preset.groups) ? preset.groups : [],
        },
        personaSource: preset.presetId,
        personaError: fields.prefix === undefined || fields.prefix === ''
          ? '这个预设没有内联人设正文，它继承部署级人设。'
          : undefined,
        exportResult: undefined,
      });
    };

    /** Read one preset's persona body into the editor. */
    const loadPresetPersona = async (store, id) => {
      store.set({ personaError: undefined });
      try {
        const detail = await post('preset', { id });
        if (detail?.ok !== true) {
          store.set({ personaError: detail?.error ?? 'unknown host error' });
          return;
        }
        // 宿主会把四字段一起带回来；老宿主只给 persona 字符串，
        // 那时退回「只有 prefix」—— 也正好是 dsh-persona 的默认语义。
        const fields = detail.personaFields !== null && typeof detail.personaFields === 'object'
          ? detail.personaFields
          : {
            prefix: typeof detail.persona === 'string' ? detail.persona : '',
            suffix: '', complete: false, includeRuntimeContext: true,
          };
        store.set({
          personaFields: {
            prefix: typeof fields.prefix === 'string' ? fields.prefix : '',
            suffix: typeof fields.suffix === 'string' ? fields.suffix : '',
            complete: fields.complete === true,
            includeRuntimeContext: fields.includeRuntimeContext === false ? false : true,
          },
          personaSource: id,
          personaError: undefined,
        });
      } catch (error) {
        store.set({ personaError: error?.message ?? String(error) });
      }
    };

    /**
     * 【中文】把某个预设的**人设四字段**读进编辑器。**不碰工具勾选。**
     *
     * ⚠️ 这里曾经顺手把 `store.selected` 整个换成这个预设的 packages ——
     * 那是个真 bug，用户报的就是它：「系统提示词的『从预设载入』会影响工具页」。
     * 用户在工具页辛苦勾好的一堆，只因为来这儿载入一次人设就被全部冲掉。
     *
     * 而且这在语义上也不成立：`packages` 表达的是「这个预设挂了哪些包」，
     * 不是「用户想勾哪些」。勾选状态归 `selected`，只该由工具页的
     * 勾选框和「从预设载入勾选」那个下拉改动。
     * @param store - 目标 store。
     * @param id - 预设 id。
     */
    const loadOfficialPreset = async (store, id) => {
      store.set({ personaError: undefined });
      try {
        const detail = await post('preset', { id });
        if (detail?.ok !== true) {
          store.set({ personaError: detail?.error ?? 'unknown host error' });
          return;
        }
        // 宿主会把四字段一起带回来；老宿主只给 persona 字符串，
        // 那时退回「只有 prefix」—— 也正好是 dsh-persona 的默认语义。
        const fields = detail.personaFields !== null && typeof detail.personaFields === 'object'
          ? detail.personaFields
          : {
            prefix: typeof detail.persona === 'string' ? detail.persona : '',
            suffix: '', complete: false, includeRuntimeContext: true,
          };
        store.set({
          personaFields: {
            prefix: typeof fields.prefix === 'string' ? fields.prefix : '',
            suffix: typeof fields.suffix === 'string' ? fields.suffix : '',
            complete: fields.complete === true,
            includeRuntimeContext: fields.includeRuntimeContext === false ? false : true,
          },
          personaSource: id,
          personaError: undefined,
        });
      } catch (error) {
        store.set({ personaError: error?.message ?? String(error) });
      }
    };

    /** ------------------------------------------------------------------ */
    /** hooks                                                               */
    /** ------------------------------------------------------------------ */

    function useStudio(store) {
      const [state, setState] = useState(store.get());
      useEffect(() => store.subscribe(() => setState(store.get())), [store]);
      return state;
    }

    /** ------------------------------------------------------------------ */
    /** tools tab                                                           */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】工具页：两张表 + 过滤 + 全选。
     *
     * 分区依据（这是本页最重要的约定）：
     *   · 已挂工具（mounted）—— 来自运行时注册表，**按工具名做键**
     *   · 可挂载工具包（available）—— 来自安装目录扫描，**按包名做键**
     * 两表键不同，所以：
     *   1) 勾选状态里可能同时存在工具名和包名；
     *   2) token 合计只对「已挂」表算（宿主只给了已挂行的 token 估算）；
     *   3) 导出时宿主要把工具名反查回包名（见 host 端 resolvePluginName）。
     * 过滤框对两张表的「名字 + 该行 ship 的工具名列表」一起做子串匹配。
     */
    function ToolsTab({ store, state, t, selectionPreset, setSelectionPreset }) {
      const [filter, setFilter] = useState('');
      // 哪些行的「工具清单」是展开的。存行的键（工具名或包名）。
      // 默认全部折叠 —— 一张表动辄 20+ 行，展开状态太多页面就没法扫了。
      const [expanded, setExpanded] = useState(() => new Set());
      const toggleExpanded = useCallback((key) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
      }, []);
      // 「说明」列的展开状态：只对**已挂表**启用（可挂表说明是短中文，不用展开）。
      // 与 expanded 分开记账 —— 那是「带的工具」列的，同一行可能两个都展开。
      const [descExpanded, setDescExpanded] = useState(() => new Set());
      const toggleDescExpanded = useCallback((key) => {
        setDescExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
      }, []);
      // 工具页「从预设载入勾选」下拉的当前值由**根组件**持有并传入
      // （见 StudioPage 里的注释：放在 tab 内部会被卸载而丢失）。
      // MCP 分组折叠：哪些 MCP 服务组是展开的（键 = 服务名）。默认全部折叠。
      const [mcpOpen, setMcpOpen] = useState(() => new Set());
      const toggleMcpOpen = useCallback((svc) => {
        setMcpOpen((prev) => {
          const next = new Set(prev);
          if (next.has(svc)) next.delete(svc); else next.add(svc);
          return next;
        });
      }, []);
      // 「插件工具」整张表**默认折叠**。
      // 原因：这张表整张禁勾 —— MCP 工具与第三方插件工具没有归属包，预设无权开关，
      // 用户为此反馈过三次「改不了要他何用」。默认只留一行摘要，想看明细再展开。
      // 但它**不该被删掉**：那 40 多个工具正吃着几千 token，调预设预算时必须知道
      // 它们是啥、各占多少。默认占着一屏还摆一堆点不动的勾选框，才是问题所在。
      const [pluginOpen, setPluginOpen] = useState(false);
      const snapshot = state.snapshot;
      // 全部已注册工具（官方 / MCP / 第三方都先拿到，再按归属包拆开）。
      const mountedAll = useMemo(() => snapshot?.mounted ?? [], [snapshot]);

      // ── 两分法（2026-10-12 按用户要求真正分开，不再靠文案打补丁）─────────
      // 「插件工具」= 注册表里**没有归属包**的行 —— MCP 服务器提供的工具 +
      //   第三方插件自己注册的工具。它们由 MCP 连接器 / 插件自己管理，
      //   预设只能声明包名，所以对它们无权开关。
      // 「官方工具」= 自带安装目录里的官方包。它们有归属包，预设按包名声明它们。
      // 曾经官方工具也混在上面那张表里（按工具名），标题却叫「插件工具」——
      // 用户明确指出必须分开，于是上表只留无归属包的行，下表改成**全部**官方包。
      const pluginTools = useMemo(
        () => mountedAll.filter((row) => typeof row.package !== 'string'),
        [mountedAll],
      );
      // 官方包**全集**：不能再按 `anyMounted` 过滤 —— 那样已挂载的包会从两张表里
      // 一起消失，用户既看不到「现在挂着什么」，也没法把它从预设里去掉。
      const officialPackages = useMemo(() => snapshot?.availablePackages ?? [], [snapshot]);

      // 每个官方包「当前已挂的工具」与 token 合计，从 mounted 行现算 ——
      // 宿主已经给每行补了归属包名，所以不必再问宿主要第二份数据。
      // ⚠️ 刻意用**普通对象**而不是 Map：测试桩靠「useMemo 返回值里第一个带 .get 的
      //    对象」来捕获 store，Map 有 .get，会把 store 顶掉（真实踩过）。
      const packageStats = useMemo(() => {
        const stats = Object.create(null);
        for (const row of mountedAll) {
          if (typeof row.package !== 'string') continue;
          let entry = stats[row.package];
          if (entry === undefined) {
            entry = { toolNames: [], tokens: 0 };
            stats[row.package] = entry;
          }
          entry.toolNames.push(row.name);
          entry.tokens += typeof row.tokens === 'number' ? row.tokens : 0;
        }
        return stats;
      }, [mountedAll]);

      const selected = state.selected;

      // 过滤：空串 = 不过滤；否则不区分大小写做子串匹配。
      const needle = filter.trim().toLowerCase();
      const matches = useCallback(
        (text) => needle === '' || String(text ?? '').toLowerCase().includes(needle),
        [needle],
      );

      // 插件工具表：按工具名 + 描述匹配。
      const filteredMounted = useMemo(
        () => pluginTools.filter((row) => matches(row.name) || matches(row.toolNames?.join(' '))),
        [pluginTools, matches],
      );
      // 官方工具表：按包名 + 该包 ship 的工具名列表匹配。
      const filteredAvailable = useMemo(
        () => officialPackages.filter((row) => matches(row.package)
          || matches(row.toolNames?.join(' '))),
        [officialPackages, matches],
      );

      // 官方预设名单（运行时 roster）：和「系统提示词」页同源，来自
      // state.snapshot.presets。broken 的预设不参与下拉（选了也回填不了）。
      const roster = useMemo(
        () => (snapshot?.presets ?? []).filter((p) => p.broken === undefined),
        [snapshot],
      );

      // 合并下拉的「我的预设」组：与官方 roster 同名的条目不重复渲染，
      // 只保留官方那一次（去重依据见 isDuplicatedMine），onChange 路由不变。
      const minePresets = useMemo(
        () => (state.existingPresets ?? []).filter((p) => !isDuplicatedMine(p, roster)),
        [state.existingPresets, roster],
      );

      // MCP 分组：工具名形如 `mcp<下划线+><服务名>_...` 的归到同一个服务组，
      // 非 mcp_ 前缀的工具保持单行。⚠️ 不同宿主给 MCP 工具加前缀时
      // 下划线数量不统一：`mcp_connector_read`（单下划线）与
      // `mcp__playwright__browser_resize`（mcp 后双下划线）都见过，
      // 所以前缀用 `mcp_+` 贪婪吸收任意数量的下划线，再取第一段服务名。
      // 顺序保持 filteredMounted 原顺序，这样过滤框的匹配结果、
      // 全选/全不选的遍历顺序都不受影响。
      const mountedOrder = useMemo(() => {
        const order = [];
        const groups = new Map();
        for (const row of filteredMounted) {
          const hit = /^mcp_+([^_]+)(?:_|$)/.exec(row.name ?? '');
          if (hit === null) {
            order.push({ kind: 'row', row });
            continue;
          }
          const svc = hit[1];
          let bucket = groups.get(svc);
          if (bucket === undefined) {
            bucket = [];
            groups.set(svc, bucket);
            order.push({ kind: 'group', svc });
          }
          bucket.push(row);
        }
        return { order, groups };
      }, [filteredMounted]);

      // ── 渲染「说明」这一列 ────────────────────────────────────────
      //
      // ⚠️ 这一列显示的**必须是人话**，不是一个状态词。
      // 早先它显示的是「这个包没有标注工具清单」—— 那是**另一列**（带的工具）
      // 的占位语，被错放到这里了。用户明确指出：
      //   「后面没有像"这个包没有标注工具清单"的注释，而且你为啥要注释成
      //    "这个包没有标注工具清单"，你没法详细注释它的功能吗？」
      // 于是改成：显示这个工具/包**是干嘛的**（来自它自己的自述信息）。
      //
      // 数据来源分两种，都对：
      //   · 已挂工具行 → 工具自己的 description（英文，模型看到的原文）
      //   · 可挂包行   → 包的 summary（中文 README 的说明）
      // 两者都没有时才退到中性的「没有提供说明文字」。
      //
      // ⚠️ 已挂行有个**语言问题**（用户截图反馈「中英文怎么混了」）：
      // 工具自己的 description 是写给模型看的**英文**（"Read a file from the
      // local filesystem."），而表头、可挂表全是中文 → 一张表里两套语言打架。
      // 翻译它是不行的（会丢精度、和实际行为对不上），所以改成**中英对照**：
      // 在英文原文前面加一段**中文的归属语境**（取自归属包的中文说明），
      // 读起来就是「［文件读写］Read a file from the local filesystem.」，
      // 既保留了模型看到的原文，又让整列不至于全是外语。
      const renderDesc = (row) => {
        const text = row.summary ?? row.description;
        if (typeof text !== 'string' || text.trim() === '') {
          return h('span', { style: S.shipsMissing, title: t('descMissingTitle') }, t('descMissing'));
        }
        // 中文语境前缀：只在「说明是英文、但能查到归属包的中文说明」时加。
        // summary 已经是中文的行（可挂表）不加，避免中英叠罗汉。
        const prefix = describePrefix(row, text);
        // 查不到中文说明（说明是英文、且归属包也没给中文 summary）→ 灰标签点破，
        // 免得用户盯着英文猜这是不是自己的插件。
        const noZh = prefix === undefined && !/[\u4e00-\u9fff]/.test(text);
        // 已挂行按「工具名 / 包名」键记展开状态；可挂表不启用展开。
        // ⚠️ 已挂行的数据里没有 toolNames（那是包才有的字段），所以
        // 用 `Array.isArray(row.toolNames)` 区分两表 —— 有 toolNames = 可挂行。
        const expandable = !Array.isArray(row.toolNames);
        const descKey = row.package ?? row.name;
        const open = expandable === true && descExpanded.has(descKey);
        // 显式「展开 / 收起」小按钮：用户反馈「点击整段文字」太难发现，
        // 改成始终可见的文字按钮。整行是 <label>，点击必须
        // preventDefault + stopPropagation，否则会连带切换这一行的 checkbox。
        const toggle = expandable === true
          ? h('span', {
              style: S.descToggle,
              title: open ? t('descCollapse') : t('descExpand'),
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleDescExpanded(descKey);
              },
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
            }, open ? t('descCollapse') : t('descExpand'))
          : null;
        // 展开态：完整描述正常换行；折叠态：单行省略号（省略号必须落在最内层）。
        const body = open === true
          ? h('span', { style: S.descTextOpen }, text)
          : h('span', { style: S.descText }, text);
        if (prefix === undefined) {
          return h('span', { style: S.rowDesc, title: text },
            noZh ? h('span', { style: S.descTagThirdParty }, t('descNoZh')) : null,
            body,
            toggle);
        }
        return h('span', { style: S.rowDesc, title: `${prefix}\n${text}` },
          h('span', { style: S.descTag }, prefix),
          body,
          toggle);
      };

      // 判断要不要给这一行的说明加中文语境前缀，要的话返回那段中文。
      // 返回 undefined = 不加前缀。
      const describePrefix = (row, text) => {
        // 说明本身已经是中文（含 CJK 字符）→ 不需要前缀。
        if (/[\u4e00-\u9fff]/.test(text)) return undefined;
        // 归属包的中文说明（宿主半给的 ownerSummary）。
        const zh = row.ownerSummary;
        if (typeof zh !== 'string' || zh.trim() === '') return undefined;
        return shortenSummary(zh);
      };

      // 把一整句中文说明压成一个**短标签**（最长 10 个字）。
      // 例：「面向模型的 read、read_image、write 与 edit 工具。」
      //     → 「read、read_image、write 与 edit」（去掉套话头尾）
      // 压不出来就退回原句的前 10 个字 + 省略号。
      const shortenSummary = (zh) => {
        let s = zh.trim();
        // 去掉「面向模型的 …」「供…的 …」这类头
        s = s.replace(/^(?:面向|供)[^，,。；;]{0,12}的\s*/u, '');
        // 去掉「工具。」这类尾
        s = s.replace(/[。.]+$/u, '').replace(/(?:工具|说明)$/u, '');
        s = s.replace(/^[：:，,、\s]+/u, '');
        if (s.length > 14) s = `${s.slice(0, 14)}…`;
        return s === '' ? undefined : s;
      };

      // ── 渲染「带的工具」这一列（折叠）─────────────────────────────
      //
      // 为什么做成折叠：一个包可能带十来个工具，全部平铺会：
      //   ① 挤掉右边的 token 列；② 被 CSS 截断成 `edit, read, write, …`
      // 反而看不全。所以默认只显示「N 个」的徽标，点开才用标签墙铺开。
      //
      // 传进来的 `names` 是宿主半提取的工具名。为空时**不是错误** ——
      // 表示这个包的自述信息里没列出它有哪些工具，用中性文案说明即可。
      const renderShips = (key, names) => {
        if (!Array.isArray(names) || names.length === 0) {
          return h('span', { style: S.shipsMissing, title: t('shipsNoneTitle') }, t('shipsNone'));
        }
        const open = expanded.has(key);
        // 折叠态：一个可点的徽标，写明有几个工具。
        // ⚠️ 两个事件方法都必要：整行是 `<label>`，点它会连带切换 checkbox。
        //    · preventDefault → 阻止 label 把点击转给 input
        //    · stopPropagation → 阻止冒泡到 label
        // 少了任何一个，点「展开」都会顺手把这一行勾上/取消。
        const badge = h('span', {
          key: 'badge',
          style: S.shipsToggle(open),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleExpanded(key);
          },
          title: open ? t('shipsHide') : t('shipsShow', { n: names.length }),
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
        }, open ? '▾' : '▸', h('span', null, t('shipsCount', { n: names.length })));
        if (!open) return h('span', { style: S.rowShips }, badge);
        // 展开态：徽标 + 逐个工具名的标签。
        return h('span', { style: S.rowShips },
          badge,
          h('span', { style: S.shipsPanel },
            names.map((toolName) => h('span', { key: toolName, style: S.shipsChip }, toolName))),
        );
      };

      // 单个勾选开关。键可能是工具名，也可能是包名 —— 宿主端会分别处理。
      const toggle = useCallback((pkg) => {
        const next = new Set(store.get().selected);
        if (next.has(pkg)) next.delete(pkg); else next.add(pkg);
        store.set({ selected: next });
      }, [store]);

      // 全选 / 全不选。
      // ⚠️ 只作用于「官方工具」表 —— 「插件工具」表整张是禁用复选框，
      // 全选把它们算进来只会让「已选 N」虚高，导出时再全部落进「未能落地」。
      // ⚠️ 全选要重新构造 Set：旧实现从现有 selected 上增量加，
      // 过滤框外的旧勾选会残留成幽灵勾选（点了全选却不是「只有这些」）。
      // ⚠️ 全不选要清空**全部勾选**：旧实现只对一张表增量 delete，
      // 另一张表的勾选纹丝不动 —— 点了「全不选」却还一片勾着，正是当时修的 bug。
      const setAll = useCallback((on) => {
        if (!on) {
          store.set({ selected: new Set() });
          return;
        }
        const next = new Set();
        for (const row of filteredAvailable) {
          const key = row.package;
          if (typeof key !== 'string' || key === '') continue;
          next.add(key);
        }
        store.set({ selected: next });
      }, [filteredAvailable, store]);

      // 载入官方预设的工具勾选：官方预设只在运行时名单（roster）里，
      // 没有自带 packages 字段，需要向宿主 preset 路由再取一次（宿主会补
      // packages 列表）。失败时把下拉复位成未选，避免留下一看就是假的勾选。
      // 只回填 selected + selectionSeeded，不动 personaFields 与 source。
      const loadOfficialSelection = useCallback((storeRef, presetId) => {
        post('preset', { id: presetId }).then((payload) => {
          if (payload?.ok !== true) {
            setSelectionPreset('');
            return;
          }
          const packages = payload.packages;
          if (!Array.isArray(packages)) {
            setSelectionPreset('');
            return;
          }
          storeRef.set({
            selected: new Set(packages),
            selectionSeeded: true,
          });
        }).catch(() => {
          setSelectionPreset('');
        });
      }, [setSelectionPreset]);

      if (snapshot === undefined) {
        return h('div', { style: S.empty },
          state.loading === true ? t('loading') : t('errNoHost'));
      }

      // token 柱状条的满格基准：取「插件工具」表里最贵的那个。
      // 这样用户不用去比较两位数，一眼就能看出谁最占上下文。
      const maxTokens = pluginTools.reduce(
        (peak, row) => (typeof row.tokens === 'number' && row.tokens > peak ? row.tokens : peak),
        0,
      );

      // 合计 = 勾上的**官方包**当前占用的 token。
      // 按包算而不是按工具算：预设声明的是整个包，勾不勾也是以包为单位的。
      // 包还没挂上时算不出代价（没有它的工具定义），记 0 —— 这不是「免费」，
      // 而是「此刻不占上下文」，显示成未知更准确（见底部列）。
      const selectedTokens = officialPackages
        .filter((row) => selected.has(row.package))
        .reduce((sum, row) => sum + (packageStats[row.package]?.tokens ?? 0), 0);

      // 「插件工具」表摘要行用的总 token —— 折叠时也能看见这张表有多贵。
      const pluginTokens = pluginTools.reduce(
        (sum, row) => sum + (typeof row.tokens === 'number' ? row.tokens : 0),
        0,
      );

      // 单个已挂行。抽成函数是因为 MCP 分组后同一行既可能单列、
      // 也可能出现在某个展开的组里 —— 渲染逻辑完全一样，不能写两遍。
      const renderMountedRow = (row) => {
        // 「插件工具」表里的行**都没有归属包**（官方工具已经分到下面那张表了），
        // 所以键一律退回工具名；`ownerMissing` 现在恒为 true，保留这个判断只是
        // 为了数据异常时不至于崩（曾经 `row.package.replace(...)` 直接把整张表打崩）。
        // 官方工具按包名声明，是下面那张表的事，两边不再共用一套键。
        const key = row.package ?? row.name ?? '';
        // 名称列显示**工具名**（第一列表头写的是「工具 / 包」，这一行是工具）。
        const shown = row.name ?? key;
        const ownerMissing = row.package === undefined;
        // 这张表是**纯只读清单**：没有复选框、没有「预设声明不了」标记。
        // 整张表禁勾（MCP / 第三方插件工具没有归属包，预设无权开关），
        // 用户三次反馈「改不了要他何用」—— 摆一个点不动的勾选框比不摆更糟。
        // 这里只回答三个问题：它叫什么、干什么、占多少 token。
        // 两行结构（用户反馈）：第一行 = 工具名 + token；第二行 = 说明，占满整行。
        return h('div', {
          key,
          style: {
            ...S.row,
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 3,
          },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
          },
            h('span', {
              style: { ...S.rowName, flex: '0 1 auto' },
              // 归属包不单独占一列，但没丢掉 —— 悬浮在工具名上能看到。
              title: ownerMissing
                ? `${row.name}　（${t('toolNoOwner')}）`
                : `${row.name}　（${row.package}）`,
            }, shown),
            // token 占用：第一行最右侧。
            // 数值后面跟一条**相对柱**，以最贵的插件工具为满格 ——
            // 用户不必比较两位数，一眼就能看出谁最占上下文。
            // 算不出来时写「未知」并给出原因，不再甩一个让人猜的破折号。
            h('span', {
              style: { ...S.rowMeta, marginLeft: 'auto', flex: 'none' },
              title: typeof row.tokens === 'number'
                ? `占 ${row.tokens} token`
                : t('tokensUnknownTitle'),
            },
            typeof row.tokens === 'number'
              ? h('span', { style: S.metaValue },
                  h('span', null, formatNumber(row.tokens)),
                  maxTokens > 0
                    ? h('span', { style: S.barTrack, title: t('relativeCost') },
                        h('span', {
                          style: {
                            ...S.barFill,
                            width: `${Math.max(2, Math.round((row.tokens / maxTokens) * 100))}%`,
                          },
                        }))
                    : null,
                )
              : t('tokensUnknown')),
          ),
          // 第二行：说明 —— 这个工具是干嘛的（人话，见 renderDesc）。
          // 不再有复选框，所以不用再缩进对齐它，直接顶格。
          h('div', {
            style: {
              display: 'flex',
              width: '100%',
              boxSizing: 'border-box',
              minWidth: 0,
            },
          },
            renderDesc(row)),
        );
      };

      return h('div', null,
        h('div', { style: S.toolbar },
          h('input', {
            style: { ...S.input, flex: '0 1 280px' },
            placeholder: t('toolSearch'),
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          // ── 从预设载入勾选：只回填 selected + selectionSeeded，
          // 不动 personaFields 与 source（那是「系统提示词」页的职责）。
          // 数据源 = 官方预设（运行时 roster，来自 snapshot.presets）
          //         + 现有预设（profile-presets，state.existingPresets），
          // 两组用 optgroup 分开显示。官方预设没有 packages 字段，
          // 需要向宿主 preset 路由再要一次（宿主会补 packages）。
          h('select', {
            style: { ...S.input, flex: '0 1 220px' },
            title: t('loadSelectionTitle'),
            value: selectionPreset,
            onChange: (event) => {
              const presetId = event.target.value;
              setSelectionPreset(presetId);
              if (presetId === '') return;
              // 官方预设（运行时名单）：preset 路由返回里带 packages，
              // 异步取回来回填勾选；失败时把下拉复位成未选。
              if (roster.some((p) => p.id === presetId)) {
                loadOfficialSelection(store, presetId);
                return;
              }
              const found = (state.existingPresets ?? []).find((p) => p.presetId === presetId);
              if (found !== undefined) {
                store.set({
                  selected: new Set(Array.isArray(found.packages) ? found.packages : []),
                  selectionSeeded: true,
                });
              }
            },
          },
            h('option', { value: '' }, t('loadSelection')),
            roster.length > 0
              ? h('optgroup', { label: t('loadSelectionOfficial') },
                  roster.map((p) => h('option', { key: p.id, value: p.id }, `${p.name ?? p.id}`)))
              : null,
            minePresets.length > 0
              ? h('optgroup', { label: t('loadSelectionMine') },
                  minePresets.map((p) => h('option', { key: p.presetId, value: p.presetId },
                    `${p.name === '' ? p.presetId : p.name}　·　${t('loadExistingMeta', { n: (p.packages ?? []).length })}`)))
              : null,
          ),
          h('button', {
            style: S.buttonSmall,
            onClick: () => setAll(true),
          }, t('toolSelectAll')),
          h('button', {
            style: S.buttonSmall,
            onClick: () => setAll(false),
          }, t('toolSelectNone')),
          h('span', {
            style: S.count,
            // 「已选」数的是**勾选项**，而勾选集合里两种键共存：
            // 能反查回归属包的官方工具记的是【包名】（一项可能对应多个工具行），
            // MCP / 第三方工具记的是【工具名】。所以它不等于「会挂几个工具」，
            // 也不等于「会挂几个包」。悬浮说清楚，别让人自己猜。
            title: t('selectedCountTitle'),
          },
            `${t('selectedCount', { n: formatNumber(selected.size) })} · `
            + t('estimatedTools', { n: formatNumber(selectedTokens) })),
        ),

        // 两张表共用的一条提示：写在**两张表上方**，只写一次。
        // 以前是每张表标题下各挂半句，得来回拼着读；用户要求合起来写。
        h('div', { style: { ...S.note(null), marginTop: 0, marginBottom: 12 } },
          t('keyingNote')),

        // 「插件工具」：**只读清单**，默认折叠。
        // 整张表没有一个能勾的（MCP / 第三方插件工具没有归属包，预设无权开关），
        // 所以标题行就是个折叠开关，点开才看明细 —— 不摆勾选框，不摆「预设声明不了」。
        h('div', { style: S.section },
          h('button', {
            style: {
              ...S.sectionHead, width: '100%', textAlign: 'left',
              border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit',
            },
            onClick: () => setPluginOpen((open) => !open),
            'aria-expanded': pluginOpen,
            title: pluginOpen ? t('pluginSectionHide') : t('pluginSectionShow'),
          },
            h('span', { style: S.sectionTitle },
              h('span', { style: S.mcpGroupCaret }, pluginOpen ? '▾' : '▸'),
              ` ${t('toolsMounted')}`),
            h('span', { style: { ...S.sectionHint, flex: '1 1 auto' } },
              `${formatNumber(filteredMounted.length)} 个 · 约 `
              + `${formatNumber(pluginTokens)} token · ${t('pluginSectionNote')}`),
          ),
          pluginOpen === true
            ? h('div', null,
                // 列头：把三列各是什么写出来，否则用户只看到标识符 + 数字 + 破折号。
                // 这张表**只有三列**，比官方工具表少一列。两个「少」都是有理由的：
                //   ① 没有「带的工具」列 —— 已挂行的数据里根本没有 `toolNames`
                //      （那是包才有的），照搬过来每行都显示「未标注」；而且语义上也
                //      讲不通：「这一个工具带哪些工具」本就没有意义。用户截图反馈过。
                //   ② 没有「归属包」列 —— 曾经加过，但用户明确说「归属包删了不写了」。
                //      包名对使用者没有决策价值（他关心的是"这个工具干什么、多贵"），
                //      却占掉了说明列一大截宽度 —— 说明列被挤得只剩半句。
                //      归属包信息仍然保留在名称列的 `title` 悬浮提示里，需要时能看到。
                h('div', { style: S.colHead },
                  h('span', { style: { ...S.rowName, flex: '0 1 auto' } }, t('colName')),
                  h('span', { style: S.rowDesc }, t('colDesc')),
                  h('span', { style: S.rowMeta }, t('colTokens')),
                ),
                h('div', { style: S.sectionBody },
                  filteredMounted.length === 0
                    ? h('div', { style: S.empty }, t('toolsNoMounted'))
                    : mountedOrder.order.map((item) => {
                        // 非 MCP 前缀的工具保持单行。
                        if (item.kind === 'row') return renderMountedRow(item.row);
                        // MCP 分组：同一服务的多个工具折叠成一行组头。
                        // 组头是独立 button（不在 label 内），点击只切换折叠。
                        const svc = item.svc;
                        const members = mountedOrder.groups.get(svc);
                        const open = mcpOpen.has(svc);
                        return h('div', { key: `mcp:${svc}`, style: S.mcpGroup },
                          h('button', {
                            style: S.mcpGroupHead,
                            title: open ? t('mcpGroupHide') : t('mcpGroupShow', { n: members.length }),
                            onClick: () => toggleMcpOpen(svc),
                            'aria-expanded': open,
                          },
                            h('span', { style: S.mcpGroupCaret }, open ? '▾' : '▸'),
                            h('span', { style: S.mcpGroupTitle }, svc),
                            h('span', { style: S.mcpGroupMeta }, t('mcpGroupCount', { n: members.length })),
                          ),
                          open === true
                            // 组体整体缩进 + 左边框竖线，形成二级页面层级。
                            ? h('div', { style: S.mcpGroupBody },
                                members.map((row) => renderMountedRow(row)))
                            : null,
                        );
                      }),
                ),
              )
            : null,
        ),

        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('toolsAvailable')),
            h('span', { style: S.count }, formatNumber(filteredAvailable.length)),
          ),
          // 表头四列：名称 / 说明 / 带的工具 / 占用 token。
          // ⚠️ token 列是 2026-10-12 两分法改造时加的：这张表现在列**全部**官方包
          //    （含已挂载的），已挂载的那些能从 mounted 行算出 token 合计；
          //    还没挂上的没有工具定义、算不出来 —— 显示「未知」并给原因，不甩破折号。
          h('div', { style: S.colHead },
            h('span', { style: { ...S.rowName, flex: '0 1 auto' } }, t('colName')),
            h('span', { style: S.rowDesc }, t('colDesc')),
            h('span', { style: S.rowShipsHead }, t('colShips')),
            h('span', { style: S.rowMeta }, t('colTokens')),
          ),
          h('div', { style: S.sectionBody },
            snapshot.catalogueError
              ? h('div', { style: S.note('error') }, snapshot.catalogueError)
              : null,
            filteredAvailable.length === 0
              ? h('div', { style: S.empty }, t('toolsNoAvailable'))
              : filteredAvailable.map((row) => {
                  // 官方包按**包名**键；不假设字段一定存在（见上面插件表的说明）。
                  const key = row.package ?? row.name ?? '';
                  const shown = key === '' ? t('tokensUnknown') : key.replace(/^@deepseek-ai\//, '');
                  const stat = packageStats[key];
                  const mountedCount = stat === undefined ? 0 : stat.toolNames.length;
                  const totalTools = Array.isArray(row.toolNames) ? row.toolNames.length : 0;
                  return h('label', { key, style: S.row },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(key),
                      onChange: () => toggle(key),
                      style: { flex: 'none', margin: 0 },
                    }),
                    h('span', {
                      style: { ...S.rowName, flex: '0 1 auto' },
                      title: key,
                    }, shown),
                    // 第二列：说明 —— 这个包是干嘛的（人话，见 renderDesc）。
                    renderDesc(row),
                    // 第三列：这个包带哪些工具 —— 折叠展示（见 renderShips）。
                    renderShips(key, row.toolNames),
                    // 第四列：当前占用 token + 挂了几号。
                    h('span', {
                      style: { ...S.rowMeta, flex: 'none', marginLeft: 'auto' },
                      title: typeof stat?.tokens === 'number' && stat.tokens > 0
                        ? `当前 ${mountedCount}/${totalTools} 个工具在跑，占 ${stat.tokens} token`
                        : t('pkgTokensUnknownTitle'),
                    },
                      typeof stat?.tokens === 'number' && stat.tokens > 0
                        ? h('span', { style: S.metaValue },
                            h('span', null, formatNumber(stat.tokens)),
                            h('span', { style: { ...S.rowMeta, marginLeft: 5 } },
                              `已挂 ${mountedCount}/${totalTools}`))
                        : t('tokensUnknown')),
                  );
                }),
          ),
        ),

        // 老实说明一下：两张表的键不一样，所以这里直接写出来给用户看。
        // 用户看到「60 行」对「22 个包」肯定会疑惑，与其让他猜，不如写明。
        // 底部只留一行计数 —— 两张表的说明已经合并到上面那条提示里了。
        h('div', { style: { ...S.note(null), marginTop: 4 } },
          `${t('toolsMounted')} ${pluginTools.length} 行 · `
          + `${t('toolsAvailable')} ${officialPackages.length} 个包 · `
          + `已勾选 ${selected.size} 项`),
      );
    }

    /** ------------------------------------------------------------------ */
    /** prompt tab                                                          */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】系统提示词页：人设**四字段** + 两个载入入口。
     *
     * 为什么是四个字段：`dsh-persona` 的实现只读四个 config 键 ——
     *   prefix（必填）· suffix · complete · includeRuntimeContext。
     * 本插件早先只做了 prefix，还把后两个**硬编码**成
     * complete:true / includeRuntimeContext:false —— 后者会抑制该作用域的
     * 所有上下文贡献（时间、工作目录），而用户完全无法控制。
     * 现在四个都摆出来，默认值就是 dsh-persona 自己的默认值。
     */
    function PromptTab({ store, state, t, presetPick, setPresetPick }) {
      // 合并载入下拉的选中值由**根组件**持有并传入（与 store 里的 source
      // 解耦：选官方预设不写 source，选我的预设才写 —— 下拉自己记住当前项）。
      // 放根组件是为了切页往返后不丢，见 StudioPage 里的注释。
      const fields = state.personaFields ?? {
        prefix: '', suffix: '', complete: false, includeRuntimeContext: true,
      };
      const tokens = estimateTokens(fields.prefix);
      const roster = (state.snapshot?.presets ?? []).filter((p) => p.broken === undefined);
      const existing = state.existingPresets ?? [];
      // 合并下拉的「我的预设」组：与官方 roster 同名的条目不重复渲染，
      // 只保留官方那一次（去重依据见 isDuplicatedMine），onChange 路由不变。
      const minePresets = existing.filter((p) => !isDuplicatedMine(p, roster));
      const current = state.source?.presetId;

      const patch = (next) => store.set({
        personaFields: { ...fields, ...next },
        // 手改了就断开「从哪个预设载入」的标记 —— 否则草稿里的 source
        // 会让下次打开时以为这个改动已经存回预设了。
        ...(next.prefix !== undefined ? { personaSource: undefined } : {}),
      });

      /** 一个带说明的开关。`danger` 用于会改变语义的那一个。 */
      const toggle = (key, labelKey, hintKey) => h('label', {
        key,
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: '7px 0', cursor: 'pointer', minWidth: 0,
        },
      },
        h('input', {
          type: 'checkbox',
          checked: fields[key] === true,
          onChange: () => patch({ [key]: fields[key] !== true }),
          style: { flex: 'none', margin: '3px 0 0' },
        }),
        h('span', { style: { minWidth: 0 } },
          h('span', { style: { display: 'block', fontSize: 12.5 } }, t(labelKey)),
          h('span', {
            style: { display: 'block', color: LABEL.tertiary, fontSize: 11, lineHeight: 1.5 },
          }, t(hintKey)),
        ),
      );

      return h('div', null,
        h('div', { style: S.toolbar },
          // ── 入口一：从**运行时名单**载入（部署级预设的标准做法）──
          h('select', {
            style: { ...S.input, flex: '0 1 220px' },
            title: t('loadFromPresetTitle'),
            value: state.personaSource ?? '',
            onChange: (event) => {
              const id = event.target.value;
              if (id !== '') loadPresetPersona(store, id);
            },
          },
            h('option', { value: '' }, t('loadFromPreset')),
            state.personaSource !== undefined && !roster.some((p) => p.id === state.personaSource)
              ? h('option', { value: state.personaSource }, state.personaSource)
              : null,
            roster.map((p) => h('option', { key: p.id, value: p.id },
              `${p.name ?? p.id}`)),
          ),
          // ── 入口二：从**官方或我的预设**载入（连工具勾选一起载入）──
          // 与工具页「从预设载入勾选」同款结构：官方预设 + 我的预设
          // 用 optgroup 分组。选官方预设走 preset 路由（人设 + 勾选一起
          // 回填，不写 source，覆盖导出不适用）；选我的预设走
          // loadExistingPreset（写 source，导出可覆盖）。
          h('select', {
            style: { ...S.input, flex: '0 1 260px' },
            title: t('promptLoadTitle'),
            // 显示值 = 用户手动选过的项优先；没选过则显示当前编辑来源
            // （state.source.presetId），切页往返后保持一致。
            value: presetPick !== '' ? presetPick : (current ?? ''),
            onChange: (event) => {
              const presetId = event.target.value;
              setPresetPick(presetId);
              if (presetId === '') return;
              if (roster.some((p) => p.id === presetId)) {
                loadOfficialPreset(store, presetId);
                return;
              }
              const found = existing.find((p) => p.presetId === presetId);
              if (found !== undefined) loadExistingPreset(store, found);
            },
          },
            h('option', { value: '' }, t('loadExisting')),
            roster.length > 0
              ? h('optgroup', { label: t('loadSelectionOfficial') },
                  roster.map((p) => h('option', { key: p.id, value: p.id },
                    `${p.name ?? p.id}`)))
              : null,
            minePresets.length > 0
              ? h('optgroup', { label: t('loadSelectionMine') },
                  minePresets.map((p) => h('option', { key: p.presetId, value: p.presetId },
                    `${p.name === '' ? p.presetId : p.name}　·　${t('loadExistingMeta', {
                      n: (p.packages ?? []).length,
                    })}`)))
              : null,
          ),
          h('button', {
            style: S.buttonSmall,
            onClick: () => store.set({
              personaFields: {
                prefix: '', suffix: '', complete: false, includeRuntimeContext: true,
              },
              personaSource: undefined, personaError: undefined,
            }),
          }, t('toolClearAll')),
          h('span', { style: S.count },
            `${t('chars', { n: formatNumber(fields.prefix.length) })} · `
            + t('estTokens', { n: formatNumber(tokens) })),
        ),

        // 两个页面的载入互不影响，这里只是把「读我的预设会连工具清单一起载回来」
        // 说清楚 —— 一行灰字，不喧宾夺主。
        h('div', { style: S.note(null) }, t('promptLoadReplacesTools')),

        // 宿主读不到名单 / 读不到 patch —— 两件事都要说出来，各说各的。
        state.rosterError !== undefined
          ? h('div', { style: S.note(null) }, t('rosterUnavailable'), '\n', state.rosterError)
          : null,
        state.existingError !== undefined
          ? h('div', { style: S.note('error') }, t('existingUnavailable'), '\n', state.existingError)
          : null,
        state.draftError !== undefined
          ? h('div', { style: S.note(null) }, t('draftDamaged'), '\n', state.draftError)
          : null,

        state.personaError !== undefined
          ? h('div', { style: S.note('error') }, state.personaError)
          : null,

        // 当前正在编辑某个现有预设 —— 说清楚，否则用户不知道「导出」会发生什么。
        current !== undefined
          ? h('div', { style: S.note(null) },
            t('editingExisting', { id: current }),
            state.source?.groups?.length > 0
              ? `\n${t('hasGroups', { n: state.source.groups.length })}`
              : '')
          : null,

        // ── prefix（主框）─────────────────────────────────────────────
        h('div', { style: S.field },
          h('div', { style: { ...S.subtitle, margin: '0 0 8px' } },
            'prefix', h('span', { style: S.labelHint }, t('prefixHint'))),
          h('textarea', {
            style: { ...S.textarea, minHeight: 320 },
            placeholder: t('promptPlaceholder'),
            value: fields.prefix,
            spellCheck: false,
            onChange: (event) => patch({ prefix: event.target.value }),
          }),
          h('div', {
            style: { ...S.labelHint, marginLeft: 0, marginTop: 5, display: 'block' },
          }, t('estTokensNote')),
        ),

        // ── suffix（第二个文本框）──────────────────────────────────────
        // 大白话：结尾补充说明，选填。写在对话末尾的「收尾叮嘱」，AI 处理每个
        // 问题时都会参考。里面可以写 {{model}} 这类已注册变量自动替换。
        // ⚠️ 别写 {{cwd}}：DSH 0.2.1 起不注册了，会导致提示词组装报错。
        // 留空 = 遮蔽全局后缀：部署级配置里那段全局结尾补充也不会被用进来。
        h('div', { style: S.field },
          h('div', { style: { ...S.subtitle, margin: '0 0 8px' } },
            'suffix', h('span', { style: S.labelHint }, t('suffixHint'))),
          h('textarea', {
            style: { ...S.textarea, minHeight: 92 },
            placeholder: t('suffixPlaceholder'),
            value: fields.suffix,
            spellCheck: false,
            onChange: (event) => patch({ suffix: event.target.value }),
          }),
        ),

        // ── 两个语义开关 ──────────────────────────────────────────────
        // 大白话：complete 开 = 你写的这段 prefix 就是全部系统提示词，系统自带
        // 的身份 / 结尾 / 工具引导 / 监听器追加内容一概不再加进来；关 = 只当
        // 开头，其余照常补齐。includeRuntimeContext 开（默认）= AI 能看到时间、
        // 工作目录等环境上下文；关 = 全部屏蔽，AI 在纯净上下文里工作。
        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('personaSwitches')),
          ),
          h('div', { style: S.sectionBody },
            toggle('complete', 'completeLabel', 'completeHint'),
            toggle('includeRuntimeContext', 'contextLabel', 'contextHint'),
          ),
        ),
      );
    }

    /** ------------------------------------------------------------------ */
    /** export tab                                                          */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】导出页：两种模式，一个开关。
     *
     *   · 另存为新预设（默认）—— 渲染成 bundle 目录，交给 Plugin Manager 安装。
     *     不碰 profile 的 patch 文件。
     *   · 覆盖原预设 —— **文本级**替换 profile patch 里那一块，写前先备份。
     *     只有「从现有预设载入」过才有覆盖的资格；没载入过时开关是灰的，
     *     因为那等于凭空造一个 id 相同的声明（重复 id 会让整条声明加载失败）。
     */
    function ExportTab({ store, state, t }) {
      const [presetId, setPresetId] = useState('');
      const [name, setName] = useState('');
      const [description, setDescription] = useState('');
      const [order, setOrder] = useState('90');
      const [outRoot, setOutRoot] = useState('');
      const seededRoot = useRef(false);
      // 载入现有预设时，把导出表单也填成那个预设的值 ——
      // 否则用户得自己把 id/name/order 一个个数着抄一遍。
      const seededFrom = useRef(undefined);

      useEffect(() => {
        if (!seededRoot.current && state.snapshot?.defaultOutputRoot !== undefined) {
          seededRoot.current = true;
          setOutRoot(state.snapshot.defaultOutputRoot);
        }
      }, [state.snapshot?.defaultOutputRoot]);

      const source = state.source;
      const canOverwrite = source?.presetId !== undefined && source?.topId !== undefined;
      // 换一个载入目标就重新填一次表单。
      useEffect(() => {
        if (source?.presetId === undefined) return;
        if (seededFrom.current === source.presetId) return;
        seededFrom.current = source.presetId;
        setPresetId(source.presetId);
        setName(source.name ?? '');
        setOrder(typeof source.order === 'number' ? String(source.order) : '90');
        // 覆盖是载入现有预设后的自然动作，所以默认就打开。
        // 用户随时可以关掉改成「另存为新 id」。
        store.set({ overwrite: true });
      }, [source?.presetId, source?.name, source?.order, store]);

      const selected = state.selected;
      const fields = state.personaFields ?? { prefix: '' };
      const result = state.exportResult;
      const overwrite = state.overwrite === true;

      const run = async () => {
        if (presetId.trim() === '') {
          store.set({ exportResult: { ok: false, error: t('exportNeedId') } });
          return;
        }
        store.set({ exporting: true, exportResult: undefined });
        try {
          const response = await post('export', {
            ...(overwrite ? { mode: 'overwrite', topId: source.topId } : {}),
            presetId: presetId.trim(),
            name: name.trim(),
            description: description.trim(),
            order: Number(order),
            // ⚠️ 人设**四字段**一起交，不能只交 prefix ——
            // 只交 prefix 会让后两个开关被静默忽略（那正是上一版的 bug）。
            personaFields: fields,
            // 老宿主半不认 personaFields 时还能靠这个字段拿到 prefix。
            persona: fields.prefix ?? '',
            packages: [...selected],
            packagesAreMountedRows: true,
            outputRoot: outRoot.trim(),
          });
          store.set({ exporting: false, exportResult: response });
          // 覆盖成功 → 现有预设列表已过期，重新读一次。
          if (overwrite && response?.ok === true) loadExistingPresets(store);
        } catch (error) {
          store.set({
            exporting: false,
            exportResult: { ok: false, error: error?.message ?? String(error) },
          });
        }
      };

      return h('div', null,
        // ── 模式开关：两种都支持，界面上给明确选择 ──────────────────
        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('exportMode')),
            h('span', { style: S.sectionHint }, t(overwrite ? 'exportModeOverwriteHint' : 'exportModeNewHint')),
          ),
          h('div', { style: S.sectionBody },
            h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
              h('label', {
                style: { display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' },
              },
                h('input', {
                  type: 'radio',
                  name: 'export-mode',
                  checked: !overwrite,
                  onChange: () => store.set({ overwrite: false }),
                  style: { margin: 0 },
                }),
                h('span', null, t('exportModeNew')),
              ),
              h('label', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 7,
                  cursor: canOverwrite ? 'pointer' : 'not-allowed',
                  opacity: canOverwrite ? 1 : 0.5,
                },
                title: canOverwrite ? undefined : t('exportModeOverwriteLocked'),
              },
                h('input', {
                  type: 'radio',
                  name: 'export-mode',
                  checked: overwrite,
                  disabled: !canOverwrite,
                  onChange: () => store.set({ overwrite: true }),
                  style: { margin: 0 },
                }),
                h('span', null, t('exportModeOverwrite')),
              ),
            ),
            // 覆盖模式要把「会改哪个文件、备份在哪」写在脸上 ——
            // 这是唯一直接改用户 profile 的动作，不能让人猜。
            overwrite
              ? h('div', { style: { ...S.note(null), marginTop: 10 } },
                t('exportOverwriteDetail', {
                  id: source?.presetId ?? '',
                  file: state.snapshot?.profileDir === undefined
                    ? 'cordis.patch.yml'
                    : `${state.snapshot.profileDir}\\cordis.patch.yml`,
                }))
              : null,
          ),
        ),

        h('div', { style: S.field },
          h('label', { style: S.label }, t('exportPresetId'),
            h('span', { style: S.labelHint },
              overwrite ? t('exportPresetIdHintOverwrite') : t('exportPresetIdHint'))),
          h('input', {
            style: S.input, value: presetId, spellCheck: false,
            placeholder: 'my-mode',
            onChange: (event) => setPresetId(event.target.value),
          }),
        ),
        h('div', { style: S.field },
          h('label', { style: S.label }, t('exportPresetName'),
            h('span', { style: S.labelHint }, t('exportPresetNameHint'))),
          h('input', {
            style: S.input, value: name,
            onChange: (event) => setName(event.target.value),
          }),
        ),
        h('div', { style: S.field },
          h('label', { style: S.label }, t('exportPresetDesc'),
            h('span', { style: S.labelHint }, t('exportPresetDescHint'))),
          h('input', {
            style: S.input, value: description,
            onChange: (event) => setDescription(event.target.value),
          }),
        ),
        // 覆盖模式下输出目录毫无意义（不生成 bundle 目录），所以收起来。
        overwrite ? null : h('div', { style: { display: 'flex', gap: 10 } },
          h('div', { style: { ...S.field, flex: '0 0 110px' } },
            h('label', { style: S.label }, t('exportPresetOrder'),
              h('span', { style: S.labelHint }, t('exportPresetOrderHint'))),
            h('input', {
              style: S.input, value: order,
              onChange: (event) => setOrder(event.target.value),
            }),
          ),
          h('div', { style: { ...S.field, flex: '1 1 auto', minWidth: 0 } },
            h('label', { style: S.label }, t('exportOutDir')),
            h('input', {
              style: S.input, value: outRoot, spellCheck: false,
              onChange: (event) => setOutRoot(event.target.value),
            }),
          ),
        ),
        overwrite
          ? h('div', { style: { ...S.field, flex: '0 0 110px', maxWidth: 160 } },
            h('label', { style: S.label }, t('exportPresetOrder'),
              h('span', { style: S.labelHint }, t('exportPresetOrderHint'))),
            h('input', {
              style: S.input, value: order,
              onChange: (event) => setOrder(event.target.value),
            }),
          )
          : null,

        h('div', { style: S.toolbar },
          h('button', {
            style: S.button('primary'),
            disabled: state.exporting === true,
            onClick: run,
          }, state.exporting === true
            ? t('exportSaving')
            : (overwrite ? t('exportOverwriteRun') : t('exportSave'))),
          h('span', { style: S.count },
            `${t('selectedCount', { n: formatNumber(selected.size) })} · `
            + t('estTokens', { n: formatNumber(estimateTokens(fields.prefix ?? '')) })),
        ),

        (fields.prefix ?? '').trim() === ''
          ? h('div', { style: S.note(null) }, t('exportNeedPersona'))
          : null,

        result === undefined ? null : h('div', {
          style: S.note(result.ok === true ? null : 'error'),
        },
          result.ok === true
            ? (overwrite ? t('exportOverwriteDone') : t('exportDone'))
            : t('exportFailed'),
          result.dir ? `\n${result.dir}` : '',
          result.patchPath ? `\n${result.patchPath}` : '',
          result.backup ? `\n${t('exportBackup')} ${result.backup}` : '',
          result.presetId ? `\npreset id: ${result.presetId}` : '',
          result.linesBefore !== undefined
            ? `\n${t('exportLines', {
              before: formatNumber(result.linesBefore),
              after: formatNumber(result.linesAfter),
            })}`
            : '',
          result.overwriteRebuilt === false ? `\n${t('exportRebuiltFallback')}` : '',
          result.installed === true ? '\ninstalled via plugin_manager: yes' : '',
          result.hint ? `\n${result.hint}` : '',
          result.warning ? `\n${t('exportWarning')}: ${result.warning}` : '',
          result.error ? `\n${result.error}` : '',
        ),
      );
    }

    /** ------------------------------------------------------------------ */
    /** settings page                                                       */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】把 props.t 兜成一定可调用的函数。
     *
     * 正常路径下 t 由框架提供（注册时声明的 `locale: NS` 让渲染器把
     * ctx.locale.bind(NS) 塞进 kit.t，见 ui-renderer standardKit）。
     * 但如果哪天注册契约变了、或 locale 插件缺席，props.t 会是 undefined，
     * 于是第一次 t('...') 就抛 TypeError —— React 会整棵树不渲染，
     * 表现就是**用户看到一片空白，且没有任何提示**。
     *
     * 这种"静默空白"最难排查，所以这里做两层兜底：
     *   1) t 拿不到就退回 NS 自己的字典（插件内置，永远在）；
     *      key 也查不到时返回 key 本身，绝不抛错。
     *   2) 调不到字典就用 bind 出来的 t。
     */
    const boundT = (props) => {
      const provided = props?.t;
      if (typeof provided === 'function') return provided;
      const local = (key) => {
        const dict = zh ?? {};
        const value = dict[key];
        return typeof value === 'string' ? value : String(key);
      };
      return local;
    };

    function StudioPage(props) {
      const t = boundT(props);
      const store = useMemo(() => createStudioStore(), []);
      const state = useStudio(store);
      const [tab, setTab] = useState('tools');
      // ⚠️ 两个下拉的选中值**提在根组件**，不能各自放在自己的 tab 里。
      //    放在 tab 内部时，切走这个 tab 组件就被卸载，useState 跟着消失 ——
      //    再切回来下拉会跳回「未选」，看起来就像「选择被影响了」。
      //    这两个值纯粹是「下拉当前显示哪一项」，不影响任何数据：
      //    工具页那个只管 selected，系统提示词页那个只管人设四字段。
      const [selectionPreset, setSelectionPreset] = useState('');
      const [promptPick, setPromptPick] = useState('');
      const loaded = useRef(false);
      // 草稿保存器：每次 store 变化都合并成一次写入（见 createDraftSaver）。
      const saveDraft = useMemo(() => createDraftSaver(store), [store]);

      useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        // ⚠️ 顺序要紧：**先**恢复草稿，**再**读快照。
        // 反过来的话，快照会用「当前已挂的工具」初始化勾选集，
        // 把草稿里用户的真实选择覆盖掉 —— 那就等于白存了。
        (async () => {
          await restoreDraft(store);
          await loadSnapshot(store);
          await loadExistingPresets(store);
        })();
      }, [store]);

      // 勾选 / 人设 / 编辑来源任一变化 → 存草稿。
      useEffect(() => {
        if (loaded.current === false) return;
        saveDraft();
      }, [state.selected, state.personaFields, state.source, saveDraft]);

      const tabs = [
        ['tools', t('tabTools')],
        ['prompt', t('tabPrompt')],
        ['export', t('tabExport')],
      ];

      return h('div', { style: S.root },
        h('div', { style: S.header },
          h('h2', { style: S.title }, t('title')),
          h('p', { style: S.subtitle }, t('subtitle')),
        ),
        h('div', { style: S.tabBar },
          tabs.map(([id, label]) => h('button', {
            key: id, style: S.tab(tab === id), onClick: () => setTab(id),
          }, label)),
          h('button', {
            style: { ...S.buttonSmall, marginLeft: 'auto', marginBottom: 6 },
            onClick: () => loadSnapshot(store),
          }, state.loading === true ? t('scanning') : t('refresh')),
        ),
        h('div', { style: S.body },
          state.error !== undefined
            ? h('div', { style: S.note('error') }, state.error)
            : null,
          state.snapshot === undefined
            ? h('div', { style: S.empty },
                state.loading === true ? t('loading') : t('errNoHost'))
            : tab === 'tools'
              ? h(ToolsTab, { store, state, t, selectionPreset, setSelectionPreset })
              : tab === 'prompt'
                ? h(PromptTab, { store, state, t, presetPick: promptPick, setPresetPick: setPromptPick })
                : h(ExportTab, { store, state, t }),
        ),
      );
    }

    /** ------------------------------------------------------------------ */
    /** 右侧栏面板                                                          */
    /** ------------------------------------------------------------------ */

    /**
     * 右栏里的那份读数。`tab` 是框架 `useTabInfo()` 的结果，
     * 带着 `{ sidebar, panel, tab }`；`tab.actions` 用来导航当前会话。
     */
    function StudioPanel(props) {
      const t = boundT(props);
      const store = useMemo(() => createStudioStore(), []);
      const state = useStudio(store);
      const loaded = useRef(false);

      useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        loadSnapshot(store);
      }, [store]);

      const mounted = state.snapshot?.mounted ?? [];
      const presets = state.snapshot?.presets ?? [];
      const tokens = state.snapshot?.mountedTokens;

      const openStudio = () => {
        // 编辑器归设置页所有；这个面板只负责「读出来 + 给个入口」。
        try {
          if (typeof props.tab?.actions?.bindCommands === 'function') return;
          globalThis.dispatchEvent(new CustomEvent('dsh:open-settings', {
            detail: { section: TAB_ID },
          }));
        } catch { /* 跳转失败也没关系，面板自己的读数照常显示 */ }
      };

      const kpi = (label, value) => h('div', { style: S.kpi },
        h('span', { style: S.kpiValue }, value),
        h('span', { style: S.kpiLabel }, label),
      );

      return h('div', { style: { ...S.root, padding: '12px 14px' } },
        state.error !== undefined
          ? h('div', { style: S.note('error') }, state.error)
          : null,
        state.snapshot === undefined
          ? h('div', { style: S.empty },
              state.loading === true ? t('loading') : t('errNoHost'))
          : h(React.Fragment, null,
            h('div', { style: { ...S.section, marginBottom: 10 } },
              h('div', { style: S.sectionHead },
                h('span', { style: S.sectionTitle }, t('sidebarTools'))),
              h('div', { style: S.sectionBody },
                kpi(t('sidebarTools'), formatNumber(mounted.length)),
                kpi(t('sidebarPromptTokens'),
                  typeof tokens === 'number' ? formatNumber(tokens) : t('tokensUnknown')),
                kpi(t('sidebarCurrent'), formatNumber(presets.length)),
              ),
            ),
            h('button', {
              style: { ...S.button('primary'), alignSelf: 'flex-start' },
              onClick: openStudio,
            }, t('sidebarOpen')),
          ),
      );
    }

    /** ------------------------------------------------------------------ */
    /** plugin                                                              */
    /** ------------------------------------------------------------------ */

    /**
     * 【中文】渲染错误兜底（React error boundary）。
     *
     * 为什么必须有：React 里**子组件渲染时抛错会让整棵子树不挂载**。
     * 如果这就是 settings.section 的根，用户看到的就是一片空白，
     * 没有任何文字、没有任何线索 —— 这正是本次踩到的现象。
     *
     * 包一层之后，任何未预料的抛错都会被接住，并把错误原文 + 堆栈的
     * 前几行直接画在页面上，同时打到 console。排查成本从"猜"降到"读"。
     *
     * 用 class 是因为 React 只有 class 组件能实现 componentDidCatch /
     * getDerivedStateFromError（函数组件没有等价的 hook）。
     */
    class StudioBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        // 打到宿主 console，方便在 DevTools 里直接看到完整堆栈。
        // eslint-disable-next-line no-console
        console.error('[agent-preset-studio] render failed', error, info);
      }

      render() {
        const { error } = this.state;
        if (error === undefined) return this.props.children;
        return h('div', { style: S.root },
          h('div', { style: S.header },
            h('h2', { style: S.title }, 'Agent 预设工作室 — 渲染失败'),
            h('p', { style: S.subtitle }, '这是插件自身的错误，不是你的操作问题。把下面的文字反馈即可定位。'),
          ),
          h('div', { style: S.body },
            h('div', { style: S.note('error') },
              String(error?.stack ?? error?.message ?? error)),
          ),
        );
      }
    }

    /** 把任意组件包进兜底壳。 */
    const guard = (Component) => function Guarded(props) {
      return h(StudioBoundary, null, h(Component, props));
    };

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }),
        'agent-preset-studio: dictionaries');
      const t = ctx.locale.bind(NS);

      // 【中文】设置页分区：工作室主界面。
      //
      // 两个字段各有分工，缺一不可（这是从 dsh-client-ui-renderer 的
      // standardKit() 里读出来的真实契约）：
      //   · locale: NS —— 渲染器据此把 ctx.locale.bind(NS) 的结果作为 t
      //     塞进组件的 props（见 ui-renderer 第 721-724 行）。所以组件里的
      //     props.t 是**框架给的**，不是我们自己 inject 的。
      //   · inject —— 供「业务 share」，即我们自己要额外传的 props。
      //     这里不需要额外东西，但保留函数形态以便以后扩展。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: TAB_ID,
        order: 21,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({}),
      }, guard(StudioPage)));

      // 【中文】右栏：注册一个 tab 类型 + 它的主体渲染器。
      //
      // ⚠️ 这里有个必须记住的坑：`sidebarRightTabs` 是宿主提供的**服务**，
      // 只能通过注入上下文的 .get('sidebarRightTabs') 拿，不能写成
      // scope.sidebarRightTabs。后者会得到 undefined，然后在
      // `.register(...)` 上抛 TypeError；而这个抛错发生在 Cordis 的
      // inject 回调里，会被框架吞掉，表现为「侧栏 tab 静默不出现」。
      // 正确写法对照官方 dsh-client-ui-sidebar-right 与第三方
      // dsh-better-sidebar：都是 injected.get('sidebarRightTabs')。
      //
      // 主体的 slot `key` 必须等于 tab 类型的 `id` —— 列分发就是按它查的。
      ctx.inject(['slots', 'sidebarRightTabs'], (injected) => {
        const tabs = injected.get('sidebarRightTabs');
        if (tabs === undefined) return undefined;

        injected.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_ID,
          title: () => t('sidebarTitle'),
          keepMounted: true,
          guide: [{
            id: TAB_ID,
            kind: TAB_ID,
            // ⚠️ guide 条目的 title / description 必须是**函数**，不能是字符串。
            // 宿主 GuideBody 渲染右栏空态列表时直接调用 entry.title()
            // （description 走 entry.description?.()，同样需要可调用），
            // 写成字符串会在渲染期抛 TypeError: entry.title is not a function，
            // 整个右侧栏 tab 列表随之白屏。
            title: () => t('sidebarTitle'),
            description: () => t('sidebarHint'),
          }],
        }), 'agent-preset-studio: sidebar tab type');

        injected.effect(() => injected.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, guard(StudioPanel)), 'agent-preset-studio: sidebar tab body');

        return undefined;
      });
    }

    return { name: PKG, inject, apply };
  },
});
