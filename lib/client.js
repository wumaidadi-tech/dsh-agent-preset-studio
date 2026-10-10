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
  id: '@local/dsh-agent-preset-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PKG = '@local/dsh-agent-preset-studio';
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

      toolsMounted: '当前已挂工具',
      toolsMountedHint: '这个部署此刻真的注册到 agent 上的工具行。勾选后写进导出的预设。',
      toolsAvailable: '可挂未挂工具',
      toolsAvailableHint: '安装包里存在、但当前预设没挂上的工具包。勾选后会写进导出的预设。',
      toolsNoMounted: '没有匹配的已挂工具。',
      toolsNoAvailable: '没有匹配的可挂工具包。',
      toolOwnerUnknown: '归属包未识别',
      toolSearch: '过滤工具名 / 包名 / 说明…',
      toolSelectAll: '全选',
      toolSelectNone: '全不选',
      toolClearAll: '清空',

      // 表头：把三列各是什么讲清楚，否则用户只看到一串标识符和数字。
      colName: '工具 / 包',
      colDesc: '说明',
      colShips: '带的工具',
      colOwner: '归属包',
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
      // 折叠/展开
      shipsCount: '{n} 个',
      shipsExpand: '展开',
      shipsCollapse: '收起',
      shipsShow: '查看这 {n} 个工具',
      shipsHide: '收起工具清单',
      shipsNone: '未标注',
      shipsNoneTitle: '这个包的自述信息里没有列出它提供哪些工具。'
        + '这不影响勾选 —— 勾上后整包都会挂载。',
      // 每行末尾的柱状条标题。
      relativeCost: '相对占用（最大的那一项作为满格）',
      selectedCount: '已选 {n}',
      estimatedTools: '估算 {n} token',

      // 两张表为什么键不一样 —— 这是最容易让人困惑的地方，直接写在界面上。
      keyingNote: '说明：「已挂」按工具名列、以工具名为准；「可挂」按安装包列、以包名为准。'
        + '两者不是同一把尺子，所以行数对不上是正常的。',

      promptHint: '对应 persona 行的 prefix 字段。complete: true 时它就是全部系统提示词。',
      promptPlaceholder: '在这里写这个预设的系统提示词…',
      loadFromPreset: '从已有预设载入…',
      loadFromPresetTitle: '把某个现有预设的人设读进来当底稿',
      rosterUnavailable: '读不到预设名单，「从已有预设载入」暂时不可用 —— 但编辑器照常能用：',
      chars: '{n} 字符',
      estTokens: '≈{n} token',
      estTokensNote: '估算规则与宿主一致：4 字符 ≈ 1 token。中文实际约为此值的 1.5 倍。',

      exportPresetId: '预设 id',
      exportPresetIdHint: '新会话里选择用的标识符，只能用小写字母、数字和连字符',
      exportPresetName: '显示名',
      exportPresetNameHint: '留空则用 id',
      exportPresetDesc: '描述',
      exportPresetDescHint: '在选择卡片里显示的一行说明',
      exportPresetOrder: '排序',
      exportPresetOrderHint: '数字，越小越靠前',
      exportOutDir: '输出目录',
      exportSave: '生成并安装',
      exportSaving: '正在生成…',
      exportDone: '预设包已生成。',
      exportFailed: '生成失败。',
      exportWarning: '警告',
      exportPreview: '生成的 cordis.patch.yml',
      exportNeedId: '请先填写预设 id。',
      exportNeedPersona: '还没写系统提示词 —— 导出的预设会沿用部署级人设。',

      sidebarTitle: 'Agent 预设',
      sidebarHint: '查看当前已挂工具与预设构成',
      sidebarCurrent: '当前会话预设',
      sidebarTools: '已挂工具行',
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

      toolsMounted: 'Mounted tools',
      toolsMountedHint: 'Tool rows this deployment has actually registered on the agent right now. Ticking one writes it into the exported preset.',
      toolsAvailable: 'Available, not mounted',
      toolsAvailableHint: 'Tool packages present in the install but absent from the current preset. Ticking one writes it into the exported preset.',
      toolsNoMounted: 'No mounted tool matches.',
      toolsNoAvailable: 'No available package matches.',
      toolOwnerUnknown: 'Owner package unknown',
      toolSearch: 'Filter by tool, package or description…',
      toolSelectAll: 'Select all',
      toolSelectNone: 'Select none',
      toolClearAll: 'Clear',

      colName: 'Tool / package',
      colDesc: 'Description',
      colShips: 'Tools',
      colOwner: 'Package',
      colTokens: 'Tokens',
      toolNoOwner: 'Registered third-party; no owning install package found',
      tokensUnknown: 'n/a',
      tokensUnknownTitle: 'The host supplied no tool definition for this row, so its token cost cannot be estimated.',
      descMissing: 'No description provided',
      descMissingTitle: 'The install package documents no purpose for this entry. Ticking it is unaffected.',
      shipsCount: '{n}',
      shipsExpand: 'Expand',
      shipsCollapse: 'Collapse',
      shipsShow: 'Show the {n} tools',
      shipsHide: 'Hide the tool list',
      shipsNone: 'not listed',
      shipsNoneTitle: 'The install package\u2019s own description does not say which tools it provides. '
        + 'Ticking it still mounts the whole package.',
      relativeCost: 'Relative cost (the largest row is full width)',
      selectedCount: '{n} selected',
      estimatedTools: '≈{n} tokens',

      keyingNote: 'Note: "mounted" is listed by tool name and keyed by tool name; '
        + '"available" is listed by install package and keyed by package name. '
        + 'They are different yardsticks, so the row counts will not agree.',

      promptHint: 'Maps to the persona row\u2019s `prefix`. With complete: true it is the whole system prompt.',
      promptPlaceholder: 'Write this preset\u2019s system prompt here…',
      loadFromPreset: 'Load from a preset…',
      loadFromPresetTitle: 'Read an existing preset\u2019s persona in as a starting point',
      rosterUnavailable: 'The preset roster could not be read, so "load from a preset" is unavailable \u2014 the editor still works:',
      chars: '{n} chars',
      estTokens: '≈{n} tokens',
      estTokensNote: 'Same rule the host uses: 4 characters \u2248 1 token. CJK runs nearer 1.5\u00d7 that.',

      exportPresetId: 'Preset id',
      exportPresetIdHint: 'The identifier you pick a new session with; lower-case letters, digits and dashes',
      exportPresetName: 'Display name',
      exportPresetNameHint: 'Falls back to the id',
      exportPresetDesc: 'Description',
      exportPresetDescHint: 'The one-line blurb on the preset card',
      exportPresetOrder: 'Order',
      exportPresetOrderHint: 'Lower sorts first',
      exportOutDir: 'Output directory',
      exportSave: 'Generate and install',
      exportSaving: 'Generating…',
      exportDone: 'Preset bundle generated.',
      exportFailed: 'Generation failed.',
      exportWarning: 'Warning',
      exportPreview: 'Generated cordis.patch.yml',
      exportNeedId: 'Fill in a preset id first.',
      exportNeedPersona: 'No system prompt yet — the exported preset will inherit the deployment persona.',

      sidebarTitle: 'Agent preset',
      sidebarHint: 'Inspect mounted tools and preset composition',
      sidebarCurrent: 'This session\u2019s preset',
      sidebarTools: 'Mounted tool rows',
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

    /** One store per surface, so two instances never fight over the draft. */
    function createStudioStore() {
      let state = {
        loading: true,
        error: undefined,
        snapshot: undefined,
        selected: new Set(),
        selectionSeeded: false,
        persona: '',
        personaSource: undefined,
        personaError: undefined,
        exporting: false,
        exportResult: undefined,
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
        // ⚠️ 已挂行是按【工具名】键的，勾选处理器也用的这个键。
        const selected = before.selectionSeeded === true
          ? before.selected
          : new Set((snapshot.mounted ?? [])
              .map((row) => row.name)
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

    /** Read one preset's persona body into the editor. */
    const loadPresetPersona = async (store, id) => {
      store.set({ personaError: undefined });
      try {
        const detail = await post('preset', { id });
        if (detail?.ok !== true) {
          store.set({ personaError: detail?.error ?? 'unknown host error' });
          return;
        }
        store.set({
          persona: typeof detail.persona === 'string' ? detail.persona : '',
          personaSource: id,
          personaError: detail.persona === undefined || detail.persona === ''
            ? undefined
            : undefined,
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
     *   · 可挂未挂（available）—— 来自安装目录扫描，**按包名做键**
     * 两表键不同，所以：
     *   1) 勾选状态里可能同时存在工具名和包名；
     *   2) token 合计只对「已挂」表算（宿主只给了已挂行的 token 估算）；
     *   3) 导出时宿主要把工具名反查回包名（见 host 端 resolvePluginName）。
     * 过滤框对两张表的「名字 + 该行 ship 的工具名列表」一起做子串匹配。
     */
    function ToolsTab({ store, state, t }) {
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
      const snapshot = state.snapshot;
      // 已挂工具表：按工具名键。
      const mounted = useMemo(() => snapshot?.mounted ?? [], [snapshot]);
      // 可挂表只展示「当前一个工具都没挂上」的包，已挂的包不在这里重复出现。
      const available = useMemo(
        () => (snapshot?.availablePackages ?? []).filter(
          (row) => row.anyMounted !== true,
        ),
        [snapshot],
      );
      const selected = state.selected;

      // 过滤：空串 = 不过滤；否则不区分大小写做子串匹配。
      const needle = filter.trim().toLowerCase();
      const matches = useCallback(
        (text) => needle === '' || String(text ?? '').toLowerCase().includes(needle),
        [needle],
      );

      // 已挂表：按工具名 + 描述匹配。
      const filteredMounted = useMemo(
        () => mounted.filter((row) => matches(row.name) || matches(row.toolNames?.join(' '))),
        [mounted, matches],
      );
      // 可挂表：按包名 + 该包 ship 的工具名列表匹配。
      const filteredAvailable = useMemo(
        () => available.filter((row) => matches(row.package)
          || matches(row.toolNames?.join(' '))),
        [available, matches],
      );

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
        if (prefix === undefined) {
          return h('span', { style: S.rowDesc, title: text }, text);
        }
        return h('span', { style: S.rowDesc, title: `${prefix}\n${text}` },
          h('span', { style: S.descTag }, prefix),
          h('span', { style: S.descText }, text));
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

      // 对给定的一批行整体勾选 / 取消。
      // ⚠️ 取键必须和逐行 toggle 完全一致：用 `package ?? name`。
      // 这里曾经只写 `row.package` —— 而已挂行按**工具名**键，
      // 于是「已挂」表的全选/全不选会往勾选集里塞一堆 undefined，
      // 点了没反应（又是「两表键不同」这个坑的第 N 次现形）。
      const setAll = useCallback((rows, on) => {
        const next = new Set(store.get().selected);
        for (const row of rows) {
          const key = row.package ?? row.name;
          if (typeof key !== 'string' || key === '') continue;
          if (on) next.add(key); else next.delete(key);
        }
        store.set({ selected: next });
      }, [store]);

      if (snapshot === undefined) {
        return h('div', { style: S.empty },
          state.loading === true ? t('loading') : t('errNoHost'));
      }

      // token 柱状条的满格基准：取所有已挂行里最贵的那个。
      // 这样用户不用去比较两位数，一眼就能看出谁最占上下文。
      const maxTokens = mounted.reduce(
        (peak, row) => (typeof row.tokens === 'number' && row.tokens > peak ? row.tokens : peak),
        0,
      );

      // 合计只统计宿主**真的知道代价**的那些行。
      // ⚠️ 已挂表的行是【按工具名】做键的（和上面的播种逻辑一致），
      // 所以这里必须用 row.name 去查 —— 用 row.package 会永远查不中、合计恒为 0。
      const selectedTokens = mounted
        .filter((row) => selected.has(row.name))
        .reduce((sum, row) => sum + (typeof row.tokens === 'number' ? row.tokens : 0), 0);

      return h('div', null,
        h('div', { style: S.toolbar },
          h('input', {
            style: { ...S.input, flex: '0 1 280px' },
            placeholder: t('toolSearch'),
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          h('button', {
            style: S.buttonSmall,
            onClick: () => setAll(filteredMounted, true),
          }, t('toolSelectAll')),
          h('button', {
            style: S.buttonSmall,
            onClick: () => setAll(filteredMounted, false),
          }, t('toolSelectNone')),
          h('span', { style: S.count },
            `${t('selectedCount', { n: formatNumber(selected.size) })} · `
            + t('estimatedTools', { n: formatNumber(selectedTokens) })),
        ),

        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('toolsMounted')),
            h('span', { style: S.sectionHint }, t('toolsMountedHint')),
            h('span', { style: S.count }, formatNumber(filteredMounted.length)),
          ),
          // 列头：把三列各是什么写出来，否则用户只看到标识符 + 数字 + 破折号。
          // 已挂表是**一行一个工具**，所以列是：
          //   工具名 / 归属包 / 说明 / 占用 token
          // ⚠️ 这里**没有**「带的工具」列。
          // 曾经照搬可挂表的四列，结果每一行的「带的工具」都显示「未标注」——
          // 因为已挂行的数据里根本没有 `toolNames` 字段（那是包才有的）。
          // 而且语义上也讲不通：「这一个工具带哪些工具」本就没有意义。
          // 用户截图反馈过这条「未标注」。
          h('div', { style: S.colHead },
            h('span', { style: { ...S.rowName, flex: '0 1 auto' } }, t('colName')),
            h('span', { style: S.rowShipsHead }, t('colOwner')),
            h('span', { style: S.rowDesc }, t('colDesc')),
            h('span', { style: S.rowMeta }, t('colTokens')),
          ),
          h('div', { style: S.sectionBody },
            filteredMounted.length === 0
              ? h('div', { style: S.empty }, t('toolsNoMounted'))
              : filteredMounted.map((row) => {
                  // ⚠️ 已挂行按**工具名**键，可挂行按**包名**键 —— 两表键不同。
                  // 宿主半现在会给已挂行补 `package`（反查归属包），但第三方插件
                  // 自己注册的工具可能查不到归属包 → 这里必须能容忍它缺席。
                  // 曾经这里直接写 `row.package.replace(...)`，于是每个已挂行
                  // 都拿到 undefined 并抛 TypeError，把整个 ToolsTab 打崩。
                  const key = row.package ?? row.name ?? '';
                  // 名称列显示**工具名**。第一列是「工具 / 包」，这一行是工具，
                  // 所以显示工具名；归属包挪到它自己那一列去（见下）。
                  const shown = row.name ?? key;
                  const ownerMissing = row.package === undefined;
                  const ownerLabel = ownerMissing
                    ? t('toolOwnerUnknown')
                    : row.package.replace(/^@deepseek-ai\//, '');
                  return h('label', { key, style: S.row },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(key),
                      onChange: () => toggle(key),
                      style: { flex: 'none', margin: 0 },
                    }),
                    h('span', {
                      style: { ...S.rowName, flex: '0 1 auto' },
                      title: ownerMissing ? `${row.name}　（${t('toolNoOwner')}）` : row.package,
                    }, shown),
                    // 第二列：归属包 —— 这个工具是从哪个安装包挂上来的。
                    h('span', {
                      style: S.rowShipsHead,
                      title: ownerMissing ? t('toolNoOwner') : row.package,
                    }, ownerLabel),
                    // 第三列：说明 —— 这个工具是干嘛的（人话，见 renderDesc）。
                    renderDesc(row),
                    // 第四列：token 占用。
                    // 数值后面跟一条**相对柱**，以最贵的已挂行为满格 ——
                    // 用户不必比较两位数，一眼就能看出谁最占上下文。
                    // 算不出来时写「未知」并给出原因，不再甩一个让人猜的破折号。
                    h('span', {
                      style: S.rowMeta,
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
                  );
                }),
          ),
        ),

        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('toolsAvailable')),
            h('span', { style: S.sectionHint }, t('toolsAvailableHint')),
            h('span', { style: S.count }, formatNumber(filteredAvailable.length)),
          ),
          // 表头三列：名称 / 说明 / 带的工具。
          // 这张表**没有 token 列** —— token 是「已挂」才有的数据，
          // 包还没挂上时没有它的工具定义，算不出来。
          h('div', { style: S.colHead },
            h('span', { style: { ...S.rowName, flex: '0 1 auto' } }, t('colName')),
            h('span', { style: S.rowDesc }, t('colDesc')),
            h('span', { style: S.rowShipsHead }, t('colShips')),
          ),
          h('div', { style: S.sectionBody },
            snapshot.catalogueError
              ? h('div', { style: S.note('error') }, snapshot.catalogueError)
              : null,
            filteredAvailable.length === 0
              ? h('div', { style: S.empty }, t('toolsNoAvailable'))
              : filteredAvailable.map((row) => {
                  // 可挂行按**包名**键；同样不假设字段一定存在（见上面已挂表的说明）。
                  const key = row.package ?? row.name ?? '';
                  const shown = key === '' ? t('tokensUnknown') : key.replace(/^@deepseek-ai\//, '');
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
                  );
                }),
          ),
        ),

        // 老实说明一下：两张表的键不一样，所以这里直接写出来给用户看。
        // 用户看到「60 行」对「22 个包」肯定会疑惑，与其让他猜，不如写明。
        h('div', { style: { ...S.note(null), marginTop: 4 } },
          t('keyingNote'), '\n',
          `已挂 ${mounted.length} 行 · 可挂 ${available.length} 个包 · `
          + `已勾选 ${selected.size} 项`),
      );
    }

    /** ------------------------------------------------------------------ */
    /** prompt tab                                                          */
    /** ------------------------------------------------------------------ */

    function PromptTab({ store, state, t }) {
      const persona = state.persona ?? '';
      const tokens = estimateTokens(persona);
      const presets = (state.snapshot?.presets ?? []).filter((p) => p.broken === undefined);

      return h('div', null,
        h('div', { style: S.toolbar },
          h('select', {
            style: { ...S.input, flex: '0 1 260px' },
            title: t('loadFromPresetTitle'),
            value: state.personaSource ?? '',
            onChange: (event) => {
              const id = event.target.value;
              if (id !== '') loadPresetPersona(store, id);
            },
          },
            h('option', { value: '' }, t('loadFromPreset')),
            state.personaSource !== undefined && !presets.some((p) => p.id === state.personaSource)
              ? h('option', { value: state.personaSource }, state.personaSource)
              : null,
            presets.map((p) => h('option', { key: p.id, value: p.id },
              `${p.name ?? p.id}`)),
          ),
          h('button', {
            style: S.buttonSmall,
            onClick: () => store.set({
              persona: '', personaSource: undefined, personaError: undefined,
            }),
          }, t('toolClearAll')),
          h('span', { style: S.count },
            `${t('chars', { n: formatNumber(persona.length) })} · `
            + t('estTokens', { n: formatNumber(tokens) })),
        ),

        // 宿主读不到名单这件事要**说出来**，不能藏起来：
        // 编辑器本身照常能用，只是「从已有预设载入」这一项不可用。
        state.rosterError !== undefined
          ? h('div', { style: S.note(null) }, t('rosterUnavailable'), '\n', state.rosterError)
          : null,

        state.personaError !== undefined
          ? h('div', { style: S.note('error') }, state.personaError)
          : null,

        h('div', { style: S.field },
          h('div', { style: { ...S.subtitle, margin: '0 0 8px' } }, t('promptHint')),
          h('textarea', {
            style: { ...S.textarea, minHeight: 380 },
            placeholder: t('promptPlaceholder'),
            value: persona,
            spellCheck: false,
            onChange: (event) => store.set({
              persona: event.target.value, personaSource: undefined,
            }),
          }),
          h('div', {
            style: { ...S.labelHint, marginLeft: 0, marginTop: 5, display: 'block' },
          }, t('estTokensNote')),
        ),
      );
    }

    /** ------------------------------------------------------------------ */
    /** export tab                                                          */
    /** ------------------------------------------------------------------ */

    function ExportTab({ store, state, t }) {
      const [presetId, setPresetId] = useState('');
      const [name, setName] = useState('');
      const [description, setDescription] = useState('');
      const [order, setOrder] = useState('90');
      const [outRoot, setOutRoot] = useState('');
      const seededRoot = useRef(false);

      useEffect(() => {
        if (!seededRoot.current && state.snapshot?.defaultOutputRoot !== undefined) {
          seededRoot.current = true;
          setOutRoot(state.snapshot.defaultOutputRoot);
        }
      }, [state.snapshot?.defaultOutputRoot]);

      const selected = state.selected;
      const persona = state.persona ?? '';
      const result = state.exportResult;

      const run = async () => {
        if (presetId.trim() === '') {
          store.set({ exportResult: { ok: false, error: t('exportNeedId') } });
          return;
        }
        store.set({ exporting: true, exportResult: undefined });
        try {
          const response = await post('export', {
            presetId: presetId.trim(),
            name: name.trim(),
            description: description.trim(),
            order: Number(order),
            persona,
            packages: [...selected],
            packagesAreMountedRows: true,
            outputRoot: outRoot.trim(),
          });
          store.set({ exporting: false, exportResult: response });
        } catch (error) {
          store.set({
            exporting: false,
            exportResult: { ok: false, error: error?.message ?? String(error) },
          });
        }
      };

      return h('div', null,
        h('div', { style: S.field },
          h('label', { style: S.label }, t('exportPresetId'),
            h('span', { style: S.labelHint }, t('exportPresetIdHint'))),
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
        h('div', { style: { display: 'flex', gap: 10 } },
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

        h('div', { style: S.toolbar },
          h('button', {
            style: S.button('primary'),
            disabled: state.exporting === true,
            onClick: run,
          }, state.exporting === true ? t('exportSaving') : t('exportSave')),
          h('span', { style: S.count },
            `${t('selectedCount', { n: formatNumber(selected.size) })} · `
            + t('estTokens', { n: formatNumber(estimateTokens(persona)) })),
        ),

        persona.trim() === ''
          ? h('div', { style: S.note(null) }, t('exportNeedPersona'))
          : null,

        result === undefined ? null : h('div', {
          style: S.note(result.ok === true ? null : 'error'),
        },
          result.ok === true ? t('exportDone') : t('exportFailed'),
          result.dir ? `\n${result.dir}` : '',
          result.presetId ? `\npreset id: ${result.presetId}` : '',
          result.installed === true ? '\ninstalled via plugin_manager: yes' : '',
          result.warning ? `\n${t('exportWarning')}: ${result.warning}` : '',
          result.error ? `\n${result.error}` : '',
        ),

        result?.patch ? h('div', null,
          h('div', { style: { ...S.label, marginTop: 14 } }, t('exportPreview')),
          h('pre', { style: S.pre }, result.patch),
        ) : null,
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
      const loaded = useRef(false);

      useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        loadSnapshot(store);
      }, [store]);

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
            : tab === 'tools' ? h(ToolsTab, { store, state, t })
              : tab === 'prompt' ? h(PromptTab, { store, state, t })
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
            title: t('sidebarTitle'),
            description: t('sidebarHint'),
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
