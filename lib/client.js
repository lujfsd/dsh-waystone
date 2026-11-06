/**
 * dsh-waystone 浏览器半边。
 *
 * 两个表面：
 *  1. `plugins.row.config`（key = `dsh-waystone#waystone`）—— 插件页里 **只有配置项**：
 *     `view === 'summary'` 给一行摘要，否则给 `form` 驱动的表单，
 *     保存走 `form.mutate([{ op:'set', path:[key], value }], state.revision)`。
 *  2. `conversation.view`（id `waystone`）—— 会话顶部的**只读**记忆视图，数据来自宿主
 *     `GET /api/waystone/state?session=<id>`。
 *
 * 设计基准取自 ui-ux-pro-max 的通用规则：4/8 间距节奏、正文 14px 且对比度达标、
 * 语义化令牌（一律走 CSS 变量，不逐屏硬编码 hex）、状态完备（加载/空/错误/禁用）、
 * 不用 emoji 当结构图标、长文控制在 45–75 字符行长。
 *
 * 模块形态遵循 dsh-client-modules 的加载契约：整文件是一个 factory，只 require('react')。
 */
window.__ModuleLoader__.load({
  id: 'dsh-waystone',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 宿主只读路由（相对 document.baseURI，挂在前缀下也不会断）。 */
    const API = 'api/waystone/state'
    /**
     * 唯一写路由：把旧数据根搬过来。POST，且后端只接受「源是本插件列出的旧根 + 当前根为空库」。
     * 前端这里只负责「点两次才发请求」，不猜路径、不许用户输路径。
     */
    const API_MIGRATE = 'api/waystone/migrate'
    /** 行配置插槽的 key：`<包名>#<cordis.patch.yml 里声明的 row id>`。 */
    const ROW_KEY = 'dsh-waystone#waystone'

    /**
     * 设计令牌。颜色全部走宿主主题变量（深/浅两套都由宿主给值），
     * 只在这里兜底一次，页面里不再出现裸 hex。
     */
    const T = {
      ink: 'var(--dsh-text, inherit)',
      sub: 'var(--dsh-text-muted, rgba(128,128,128,.95))',
      faint: 'var(--dsh-text-muted, rgba(128,128,128,.72))',
      line: 'var(--dsh-border, rgba(128,128,128,.26))',
      lineStrong: 'var(--dsh-border-strong, rgba(128,128,128,.44))',
      surface: 'var(--dsh-surface, rgba(128,128,128,.055))',
      surface2: 'var(--dsh-surface-2, rgba(128,128,128,.10))',
      accent: 'var(--dsh-accent, #4f7cff)',
      danger: 'var(--dsh-danger, #d9534f)',
      ok: 'var(--dsh-success, #2f9e63)',
      warn: 'var(--dsh-warning, #c98a16)',
      mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      radius: 12,
      gap: 8,
      pad: 16,
    }

    /**
     * 配置字段表（与 lib/index.js 的 Config schema、lib/store.js 的 CONFIG_FIELDS 一一对应，V5 §8）。
     * 字段表手写是刻意的：行配置插槽只给 `form.state.value` 与 `form.mutate`，
     * 没有「按 schema 自动渲染」的入口。min/max/fallback 必须与 store 的 CONFIG_FIELDS 一致。
     */
    const FIELDS = [
      {
        key: 'rulesMax',
        kind: 'number',
        min: 1,
        max: 200,
        fallback: 30,
        label: '规则上限（条）',
        hint: '只算「规则」这一类（用户的硬要求），全局规则与本工作区规则各自封顶；结论、事实、指南、死路的条数'
          + '都不受它影响，也不会被它淘汰。超出时淘汰「最久没被召回、强度最低」的那条，新写的照样能进来。',
      },
      {
        key: 'injectBudgetTokens',
        kind: 'number',
        min: 200,
        max: 8000,
        fallback: 1500,
        label: '每轮注入预算（词元）',
        hint: '按 2 个字符 ≈ 1 个词元估算。规约段用掉全额；交接段只用其中的 55%（最少 300 词元），'
          + '超预算时先丢死路、再丢否决子行、最后才丢线。',
      },
      {
        key: 'compactConclusionMax',
        kind: 'number',
        min: 1,
        max: 500,
        fallback: 60,
        label: '结论整理阈值（条）',
        hint: '本工作区里还「有效」的结论（没被新结论取代、也没过期）达到这个条数就触发一次合并整理'
          + '（目标砍掉 40%，最少也得砍掉 20%）；没有冷却，整理完仍超阈值就下一轮继续。',
      },
      {
        key: 'compactFactMax',
        kind: 'number',
        min: 1,
        max: 500,
        fallback: 40,
        label: '事实整理阈值（条）',
        hint: '同上，作用于「事实」；自动生成的「项目档案」那一条不参与合并，也不计入这个数。',
      },
      {
        key: 'compactBatch',
        kind: 'number',
        min: 10,
        max: 200,
        fallback: 60,
        label: '单次整理送入条数',
        hint: '一次最多把最新的这么多条送进模型：调小每次便宜但收敛慢，调大一次到位但输入变长；'
          + '积压远超这个数时，最旧的那批永远轮不到整理。',
      },
      {
        key: 'dataDir',
        kind: 'text',
        fallback: '',
        label: '存储根',
        hint: '这里填什么，存储根就是什么 —— 插件**不会**在你填的目录下再自动补一层 waystone/data。'
          + '只有留空时才用默认根：<宿主数据目录>/waystone/data（宿主没给数据目录时退回 ~/.dsh/waystone/data）。'
          + '根下面只有 global/（全局规则）和 ws/（各工作区）两个子目录。'
          + '相对路径按会话工作目录解析；环境变量 WAYSTONE_DATA_DIR 优先于这里。改这里不搬数据，旧库原样留在原处。',
      },
    ]

    /** 按 key 取字段：不要再用 FIELDS[0]/[1] 这类下标，加字段时会静默错位。 */
    const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]))
    /** 存储根的展示兜底：真实默认随宿主数据目录变，不能写死用户目录。 */
    const DIR_FALLBACK = '默认（宿主数据目录下的 waystone/data）'

    // ───────────────────────── 样式表（inline，无外部依赖） ─────────────────────────

    const style = {
      // 页面
      page: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 24,
        padding: '16px 24px 40px 20px',
        color: T.ink,
        fontSize: 14,
        lineHeight: 1.62,
        fontFamily: 'var(--dsh-font-sans, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif)',
      },
      head: { display: 'flex', flexDirection: 'column', gap: 8 },
      headRow: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 650, letterSpacing: '.01em' },
      subtitle: { margin: 0, fontSize: 13, color: T.sub, maxWidth: '72ch' },
      scope: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 12, color: T.faint, fontFamily: T.mono },
      controls: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' },
      inlineLabel: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.sub },

      // 通用控件
      input: {
        padding: '6px 10px',
        minHeight: 32,
        borderRadius: 8,
        border: '1px solid ' + T.lineStrong,
        background: T.surface,
        color: T.ink,
        fontSize: 13,
        maxWidth: 340,
      },
      button: {
        padding: '7px 14px',
        minHeight: 36,
        borderRadius: 8,
        border: '1px solid ' + T.lineStrong,
        background: T.surface,
        color: T.ink,
        cursor: 'pointer',
        fontSize: 13,
        whiteSpace: 'nowrap',
      },
      skeleton: { display: 'flex', flexDirection: 'column', gap: 8 },
      skeletonBar: { height: 12, borderRadius: 6, background: T.surface2, opacity: 0.8 },

      // 指标条
      stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 8 },
      stat: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '12px 14px',
        borderRadius: T.radius,
        border: '1px solid ' + T.line,
        background: T.surface,
      },
      statValue: { fontSize: 20, fontWeight: 650, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
      statLabel: { fontSize: 12, color: T.sub },
      statHint: { fontSize: 11, color: T.faint },

      // 外壳：导航贴最左整列满高，内容紧挨着吃掉剩余宽度（窄屏导航转横排置顶）
      content: { display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, flex: 1 },
      rail: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        flex: '0 0 184px',
        alignSelf: 'stretch',
        position: 'sticky',
        top: 0,
        maxHeight: '100vh',
        overflowY: 'auto',
        padding: '4px 12px 24px 0',
        borderRight: '1px solid ' + T.line,
        minWidth: 0,
      },
      railGroup: {
        padding: '14px 10px 4px',
        fontSize: 11,
        letterSpacing: '.04em',
        color: T.faint,
        textTransform: 'uppercase',
      },
      railRow: {
        flex: '0 0 auto',
        flexDirection: 'row',
        position: 'static',
        maxHeight: 'none',
        overflowX: 'auto',
        overflowY: 'hidden',
        borderRight: 'none',
        borderBottom: '1px solid ' + T.line,
        padding: '0 0 8px',
        gap: 4,
      },
      railItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px 7px 12px',
        minHeight: 34,
        borderRadius: 8,
        border: 'none',
        background: 'transparent',
        boxShadow: 'inset 0 0 0 0 transparent',
        color: T.sub,
        fontSize: 13,
        lineHeight: 1.4,
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      railItemActive: {
        background: T.surface2,
        color: T.ink,
        fontWeight: 600,
        boxShadow: 'inset 3px 0 0 0 ' + T.accent,
      },
      railLabel: { flex: 1 },
      railCount: { fontSize: 11, color: T.faint, fontVariantNumeric: 'tabular-nums' },
      panel: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      statButton: { textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' },
      itemDetails: { marginTop: 2 },
      detailSummary: { cursor: 'pointer', fontSize: 12, color: T.sub, outline: 'none' },

      // 区块
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: T.pad,
        borderRadius: T.radius,
        border: '1px solid ' + T.line,
        background: T.surface,
        minWidth: 0,
      },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      sectionTitle: { margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: '.02em' },
      sectionNote: { fontSize: 12, color: T.faint },
      sectionBody: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      // 「结论与事实」的筛选：右侧一排小胶囊按钮
      filterBar: { display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' },
      filterBtn: {
        padding: '3px 10px', borderRadius: 999, border: '1px solid ' + T.lineStrong,
        background: T.surface, color: T.faint, cursor: 'pointer', fontSize: 12, lineHeight: 1.7,
      },
      filterBtnOn: {
        padding: '3px 10px', borderRadius: 999, border: '1px solid ' + T.accent,
        background: T.surface2, color: T.accent, cursor: 'pointer', fontSize: 12, lineHeight: 1.7, fontWeight: 600,
      },

      // 记录
      item: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid ' + T.line,
        background: T.surface2,
        minWidth: 0,
      },
      itemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      itemBody: { margin: 0, fontSize: 14, lineHeight: 1.62, color: T.ink, overflowWrap: 'anywhere' },
      quote: {
        margin: 0,
        padding: '6px 12px',
        borderLeft: '2px solid ' + T.lineStrong,
        color: T.sub,
        fontSize: 13,
        lineHeight: 1.55,
        overflowWrap: 'anywhere',
      },
      kv: { display: 'grid', gridTemplateColumns: '60px minmax(0, 1fr)', gap: '6px 12px', alignItems: 'baseline' },
      kvKey: { fontSize: 12, color: T.faint, whiteSpace: 'nowrap' },
      kvVal: { fontSize: 14, lineHeight: 1.6, color: T.ink, overflowWrap: 'anywhere' },

      // 徽标
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: 999,
        border: '1px solid ' + T.lineStrong,
        fontSize: 11,
        lineHeight: 1.7,
        color: T.sub,
        whiteSpace: 'nowrap',
      },
      chipAccent: { display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: 1.7, border: '1px solid ' + T.accent, color: T.accent, whiteSpace: 'nowrap' },
      chipWarn: { display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: 1.7, border: '1px solid ' + T.warn, color: T.warn, whiteSpace: 'nowrap' },
      mono: { fontFamily: T.mono, fontSize: 11, color: T.faint, overflowWrap: 'anywhere' },
      // 旧数据根迁移块：一条旧根一行（路径 / 条数 / 按钮），按钮宽窄随文案变
      migrate: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 12,
        padding: 12,
        borderRadius: T.radius,
        border: '1px solid ' + T.line,
        background: T.surface,
      },
      migrateRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      // topic_id：点一下全选，用户可以直接复制 `tp_xxxxxx` 去告诉模型「继续处理这一条」。
      // 只靠 CSS（user-select: all）实现，不引剪贴板 API 也不加按钮。
      topicId: {
        fontFamily: T.mono,
        fontSize: 12,
        color: T.sub,
        padding: '1px 7px',
        borderRadius: 6,
        border: '1px solid ' + T.line,
        background: T.surface,
        userSelect: 'all',
        cursor: 'text',
      },

      // 状态时间线（同一 topic 的变更历史，最新在右）
      timeline: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        border: '1px solid ' + T.line,
        borderRadius: 8,
        background: T.surface,
        minWidth: 0,
      },
      timelineLine: { position: 'absolute', left: 12, right: 12, top: 18, height: 1, background: T.line },
      timelineNode: {
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        padding: '2px 5px',
        border: '1px solid transparent',
        borderRadius: 6,
        background: T.surface,
        color: T.sub,
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      timelineNodePicked: { borderColor: T.accent, background: T.surface2 },
      timelineDot: { width: 7, height: 7, borderRadius: '50%', background: T.lineStrong },
      timelineDotNow: { width: 7, height: 7, borderRadius: '50%', background: T.accent, boxShadow: '0 0 0 3px ' + T.surface2 },
      timelineLabel: { fontSize: 10.5, color: T.faint, fontVariantNumeric: 'tabular-nums' },
      timelineLabelNow: { fontSize: 10.5, color: T.ink, fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
      timelineDotOther: { width: 7, height: 7, borderRadius: '50%', background: T.warn },
      timelineLabelOther: { fontSize: 10.5, color: T.warn, fontVariantNumeric: 'tabular-nums' },
      timelineMore: {
        position: 'relative',
        zIndex: 1,
        padding: '1px 8px',
        borderRadius: 999,
        border: '1px dashed ' + T.lineStrong,
        background: T.surface,
        color: T.sub,
        fontSize: 11,
        lineHeight: 1.7,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      // 时间线节点点开后的内容块（原「详情」位置）
      nodeDetail: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid ' + T.line,
        background: T.surface,
      },
      nodeDetailHead: { fontSize: 12, color: T.faint },

      // 状态
      empty: { margin: 0, fontSize: 13, color: T.faint, lineHeight: 1.7 },
      error: { margin: 0, fontSize: 13, color: T.danger, lineHeight: 1.6 },
      okText: { margin: 0, fontSize: 13, color: T.ok, lineHeight: 1.6 },
      banner: { padding: '10px 14px', borderRadius: 10, border: '1px solid ' + T.danger, color: T.danger, fontSize: 13 },

      // 折叠
      details: { borderTop: '1px solid ' + T.line, paddingTop: 12, marginTop: 4 },
      summary: { cursor: 'pointer', fontSize: 13, color: T.sub, outline: 'none' },
      pre: {
        margin: '8px 0 0',
        padding: 12,
        borderRadius: 8,
        background: T.surface2,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: T.mono,
        fontSize: 12,
        lineHeight: 1.6,
        maxHeight: 320,
        overflow: 'auto',
      },

      // 表单（行配置）
      form: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, maxWidth: 520 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 13, fontWeight: 600 },
      hint: { margin: 0, fontSize: 12, color: T.faint, lineHeight: 1.6 },
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      meta: { fontSize: 12, color: T.faint },
    }

    /**
     * 键盘焦点环、hover 与按压反馈只能写在样式表里（inline style 没有 `:focus-visible`）。
     * 作用域用 `data-ws-*` 属性；颜色仍走宿主语义令牌，深浅主题各自生效；
     * `prefers-reduced-motion` 下关掉过渡。
     */
    const CSS = [
      '[data-ws-btn],[data-ws-input],[data-ws-summary]{transition:background .12s ease,border-color .12s ease,color .12s ease}',
      '[data-ws-btn]:hover:not(:disabled){background:var(--dsh-surface-2,rgba(128,128,128,.16))!important}',
      '[data-ws-btn]:active:not(:disabled){transform:translateY(1px)}',
      '[data-ws-btn]:focus-visible,[data-ws-input]:focus-visible,[data-ws-summary]:focus-visible{outline:2px solid var(--dsh-accent,#4f7cff);outline-offset:2px}',
      '[data-ws-input]:hover{border-color:var(--dsh-accent,#4f7cff)}',
      '[data-ws-tab]:hover{background:var(--dsh-surface-2,rgba(128,128,128,.14))}',
      '[data-ws-tab]:focus-visible,[data-ws-summary]:focus-visible{outline:2px solid var(--dsh-accent,#4f7cff);outline-offset:-2px}',
      '[data-ws-summary]:hover{color:var(--dsh-text,inherit)}',
      '@media (prefers-reduced-motion: reduce){[data-ws-btn],[data-ws-input],[data-ws-summary]{transition:none}[data-ws-btn]:active:not(:disabled){transform:none}}',
    ].join('')

    function BaseStyles() {
      return h('style', { 'data-waystone': 'styles' }, CSS)
    }

    // ───────────────────────── 行配置（不改行为，只换视觉） ─────────────────────────

    /** volatile 字段在宿主侧是「活格子」（`{ get() }`），读之前先解包。 */
    const cell = (v) => (v && typeof v.get === 'function' ? v.get() : v)

    const effective = (field, value) => {
      const raw = cell(value)
      return raw === undefined || raw === null || raw === '' ? field.fallback : raw
    }

    function invalidOf(field, draft) {
      if (field.kind !== 'number') return false
      const n = Number(draft[field.key])
      if (!Number.isFinite(n)) return true
      if (field.min !== undefined && n < field.min) return true
      if (field.max !== undefined && n > field.max) return true
      return false
    }

    function submittedOf(field, draft) {
      const raw = draft[field.key]
      if (field.kind === 'number') return Number(raw)
      return String(raw === undefined || raw === null ? '' : raw).trim()
    }

    function draftOf(value) {
      const source = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const field of FIELDS) draft[field.key] = String(effective(field, source[field.key]))
      return draft
    }

    function summaryOf(value) {
      const source = value && typeof value === 'object' ? value : {}
      const budget = effective(FIELD.injectBudgetTokens, source.injectBudgetTokens)
      const rules = effective(FIELD.rulesMax, source.rulesMax)
      const cc = effective(FIELD.compactConclusionMax, source.compactConclusionMax)
      const cf = effective(FIELD.compactFactMax, source.compactFactMax)
      const dir = String(cell(source.dataDir) || '').trim()
      return '规则上限 ' + rules + ' 条 · 注入预算 ' + budget + ' 词元 · 整理阈值 结论 ' + cc + ' / 事实 ' + cf + ' 条 · 存储 ' + (dir || DIR_FALLBACK)
    }

    /** 行配置视图：summary 一行摘要 / 其余情况给表单。 */
    function RowConfigView(props) {
      const { view, form } = props || {}
      if (view === 'summary') return h('span', { style: style.meta }, summaryOf(form && form.state ? form.state.value : undefined))
      if (!form || typeof form.mutate !== 'function') return h(ConfigReadOnly, {})
      return h(ConfigForm, { form })
    }

    /**
     * 兜底：宿主没给 `form` 时（settings 未把本 entry 投影成可编辑项 / 页面还没刷新），
     * 至少把**生效中的值**摆出来，而不是只留一句报错。
     */
    function ConfigReadOnly() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let live = true
        fetchState('')
          .then((data) => { if (live) setState(data) })
          .catch((e) => { if (live) setError(String((e && e.message) || e)) })
        return () => { live = false }
      }, [])
      const config = (state && state.config) || {}
      const rows = []
      for (const field of FIELDS) {
        if (field.kind === 'text') continue
        const value = config[field.key] === undefined || config[field.key] === null ? field.fallback : config[field.key]
        rows.push(h('span', { style: style.kvKey }, field.label))
        rows.push(h('span', { style: style.kvVal }, String(value) + (field.key === 'injectBudgetTokens' ? ' tok' : '')))
      }
      rows.push(h('span', { style: style.kvKey }, FIELD.dataDir.label))
      rows.push(h('span', { style: style.kvVal }, String(config.effectiveDataDir || config.dataDir || DIR_FALLBACK)))
      return h('div', { style: style.form },
        h('p', { style: style.hint }, '当前为只读展示：宿主没有为这一行提供可编辑的 form。先按 Ctrl+F5 刷新页面重试；仍不行说明本 entry 没有被设置服务投影出可编辑字段。'),
        h('div', { style: style.kv }, rows),
        error ? h('p', { style: style.error }, '读取生效值失败：' + error) : null,
        h('p', { style: style.hint }, '要改这些项：在设置页（或 profile 的 cordis.patch.yml 同名行）里改，改动下一轮生效。'),
      )
    }

    function ConfigForm(props) {
      const { form } = props
      const state = form.state && typeof form.state === 'object' ? form.state : {}
      const [draft, setDraft] = React.useState(() => draftOf(state.value))
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => { setDraft(draftOf(state.value)) }, [state.revision])

      const readOnly = state.writable === false
      const busy = saving || readOnly
      const invalid = FIELDS.filter((field) => invalidOf(field, draft))
      const base = draftOf(state.value)
      const changed = FIELDS.filter((field) => String(base[field.key]) !== String(draft[field.key]))

      const setField = (key, next) => setDraft((current) => ({ ...current, [key]: next }))

      function save() {
        if (invalid.length > 0 || busy) return
        const operations = changed.map((field) => ({ op: 'set', path: [field.key], value: submittedOf(field, draft) }))
        if (operations.length === 0) return
        setSaving(true)
        setMessage('')
        setFailed(false)
        Promise.resolve(form.mutate(operations, state.revision)).then(
          (accepted) => {
            setSaving(false)
            if (accepted === false) {
              setFailed(true)
              setMessage('保存被拒绝（宿主没有接受这次改动）')
              return
            }
            setMessage('已保存')
          },
          (error) => {
            setSaving(false)
            setFailed(true)
            setMessage('保存失败：' + String((error && error.message) || error))
          },
        )
      }

      function reset() {
        setDraft(draftOf(state.value))
        setMessage('')
        setFailed(false)
      }

      return h('div', { style: style.form, 'data-waystone-config': 'form' },
        FIELDS.map((field) => h('div', { key: field.key, style: style.field },
          h('label', { style: style.label, htmlFor: 'waystone-' + field.key }, field.label),
          h('input', {
            id: 'waystone-' + field.key,
            'data-ws-input': '',
            type: field.kind === 'number' ? 'number' : 'text',
            min: field.min,
            max: field.max,
            style: style.input,
            disabled: busy,
            value: draft[field.key],
            onChange: (event) => setField(field.key, event.target.value),
          }),
          h('p', { style: style.hint }, field.hint),
          invalidOf(field, draft)
            ? h('p', { style: style.error }, '取值超出范围：' + field.min + ' ~ ' + field.max)
            : null,
        )),
        h('div', { style: style.bar },
          h('button', {
            type: 'button',
            style: Object.assign({}, style.button, busy || changed.length === 0 || invalid.length > 0 ? { opacity: 0.55, cursor: 'not-allowed' } : null),
            disabled: busy || changed.length === 0 || invalid.length > 0,
            'data-ws-btn': '',
            onClick: save,
          }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            style: Object.assign({}, style.button, busy || changed.length === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : null),
            disabled: busy || changed.length === 0,
            'data-ws-btn': '',
            onClick: reset,
          }, '撤销'),
          h('span', { style: style.meta }, '配置每轮读一次，改动下一轮生效；改存储根不迁移已有记录'),
        ),
        message
          ? h('p', { style: failed ? style.error : style.okText }, message)
          : readOnly ? h('p', { style: style.hint }, '本次部署的配置是只读的。') : null,
      )
    }

    // ───────────────────────── 只读记忆视图：数据 ─────────────────────────

    function readJson(response) {
      if (response.ok !== true) {
        return response.text().then((text) => Promise.reject(new Error('HTTP ' + response.status + (text ? ' · ' + text.slice(0, 200) : ''))))
      }
      return response.json()
    }

    function fetchState(ws, sessionId) {
      const base = typeof document === 'undefined' || typeof document.baseURI !== 'string' ? '/' : document.baseURI
      const query = []
      if (ws) query.push('ws=' + encodeURIComponent(ws))
      if (sessionId) query.push('session=' + encodeURIComponent(sessionId))
      const target = new URL(API + (query.length ? '?' + query.join('&') : ''), base).href
      return fetch(target, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(readJson)
    }

    /** 宽屏两列（纯 CSS 媒体查询在 inline style 里做不到，这里用 matchMedia）。 */
    function useWide(breakpoint) {
      const [wide, setWide] = React.useState(() => {
        try {
          return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(min-width: ' + breakpoint + 'px)').matches
            : true
        } catch {
          return true
        }
      })
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        const mql = window.matchMedia('(min-width: ' + breakpoint + 'px)')
        const onChange = (event) => setWide(event.matches)
        try {
          mql.addEventListener('change', onChange)
          return () => mql.removeEventListener('change', onChange)
        } catch {
          mql.addListener(onChange)
          return () => mql.removeListener(onChange)
        }
      }, [breakpoint])
      return wide
    }

    // ───────────────────────── 只读记忆视图：小组件 ─────────────────────────

    function Chip(props) {
      return h('span', { style: props.warn ? style.chipWarn : props.accent ? style.chipAccent : style.chip }, props.children)
    }

    /** 指标格：给了 onClick 就是可点按钮（跳到对应分区），否则纯展示。 */
    function Stat(props) {
      const content = [
        h('div', { key: 'v', style: style.statValue }, String(props.value)),
        h('div', { key: 'l', style: style.statLabel }, props.label),
        props.hint ? h('div', { key: 'h', style: style.statHint }, props.hint) : null,
      ]
      if (!props.onClick) return h('div', { style: style.stat }, content)
      return h('button', {
        type: 'button',
        style: Object.assign({}, style.stat, style.statButton),
        'data-ws-btn': '',
        'aria-label': props.label + ' ' + props.value + ' 条，查看',
        onClick: props.onClick,
      }, content)
    }

    function Section(props) {
      const count = props.count
      return h('section', { style: style.section },
        h('div', { style: style.sectionHead },
          h('h2', { style: style.sectionTitle }, props.title),
          typeof count === 'number' ? h(Chip, null, count + ' 条') : null,
          props.note ? h('span', { style: style.sectionNote }, props.note) : null,
          // 右侧动作区（目前只有「结论与事实」的筛选按钮用）
          props.right || null,
        ),
        h('div', { style: style.sectionBody }, props.children),
      )
    }

    function Empty(props) {
      return h('p', { style: style.empty }, props.children)
    }

    function KV(props) {
      return h(React.Fragment, null,
        h('span', { style: Object.assign({}, style.kvKey, props.strong ? { color: T.ink, fontWeight: 600 } : null) }, props.k),
        h('span', { style: style.kvVal }, props.v),
      )
    }

    /** 本地时间 `YYYY-MM-DD HH:mm`：未知/非法值原样回显，不显示 Invalid Date。 */
    const formatLocal = (ts) => {
      if (ts === undefined || ts === null || ts === '') return ''
      const d = new Date(ts)
      if (Number.isNaN(d.getTime())) return String(ts)
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    const daysAgo = (ts) => {
      const t = Date.parse(ts)
      if (Number.isNaN(t)) return ''
      const days = Math.floor((Date.now() - t) / 86400000)
      return days <= 0 ? '今天' : days === 1 ? '昨天' : days + ' 天前'
    }

    /** 默认收起的详情：原生 details，键盘操作与 aria-expanded 交给浏览器。 */
    function Detail(props) {
      const r = props.record || {}
      const rows = [
        ['id', r.id],
        ['作用域', r.scope ? (r.scope === 'global' ? '全局' : '本工作区') : ''],
        ['强度', r.strength || ''],
        ['状态', r.status || 'current'],
        ['时间', formatLocal(r.ts)],
        ['议题', r.topic || ''],
        ['判据', r.criteria || ''],
        ['下一步', r.next || ''],
      ].filter(([, v]) => v)
      if (rows.length === 0) return null
      return h('details', { style: style.itemDetails },
        h('summary', { style: style.detailSummary, 'data-ws-summary': '' }, '详情'),
        h('div', { style: style.kv }, rows.map(([k, v]) => h(KV, { key: k, k, v }))),
      )
    }

    /** 一条规则：正文 + 出处原话 + 元信息。全局/本工作区由调用方分组。 */
    function RuleItem(props) {
      const r = props.rule
      const weak = (r.suspect || []).includes('criteria_weak')
      const dup = (r.suspect || []).includes('maybe_dup')
      return h('article', { style: style.item },
        h('div', { style: style.itemHead },
          weak ? h(Chip, { warn: true }, '未复核') : null,
          dup ? h(Chip, { warn: true }, '可能重复') : null,
          h('span', { style: style.mono }, r.id),
          r.topic ? h('span', { style: style.mono }, r.topic) : null,
          h('span', { style: { flex: 1 } }),
          r.ts ? h('span', { style: style.mono, title: formatLocal(r.ts) }, formatLocal(r.ts) + ' · ' + daysAgo(r.ts)) : null,
        ),
        h('p', { style: style.itemBody }, r.body),
        r.criteria ? h('div', { style: style.kv }, h(KV, { k: '判据', v: r.criteria })) : null,
        r.evidence ? h('blockquote', { style: style.quote }, '“' + r.evidence + '”') : null,
        h(Detail, { record: r }),
      )
    }

    /**
     * 同一 topic 的状态变更时间线（横轴 = 时间，最新在右）。
     *
     * 右端固定块给「下一步 + 最新时间」；放不下时左侧旧节点折成「‹ 更早 N 条」，点开换行展开、再点收起。
     * ponytail: 容量按「容器宽 - 右端块」÷ 固定槽宽估算，不逐节点量宽；同 topic 上千条再换虚拟滚动。
     */
    const TIMELINE_SLOT = 84
    const RELATED_KIND = { conclusion: '判断', fact: '事实', guide: '指南', deadend: '死路' }
    function TopicTimeline(props) {
      const record = props.record || {}
      const topicKey = record.topicId || record.topic || ''
      // 时间轴 = 该 topic 的 state + 挂在它上面的 conclusion/fact/guide/deadend，
      // 全部按 ts 排：被否决的方案也是这条线上的一环，不能只放在卡片下的折叠区里。
      const flow = (props.states || [])
        .filter((s) => topicKey && (s.topicId || s.topic) === topicKey)
        .map((s) => Object.assign({}, s, { kind: 'state' }))
        .concat((props.related || []).map((r) => Object.assign({}, r)))
        .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
      const [expanded, setExpanded] = React.useState(false)
      const [fit, setFit] = React.useState(4)
      const boxRef = React.useRef(null)

      React.useEffect(() => {
        const el = boxRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return undefined
        const measure = () => {
          const w = el.getBoundingClientRect().width || 0
          if (w > 0) setFit(Math.max(1, Math.floor((w - 16) / TIMELINE_SLOT)))
        }
        measure()
        if (typeof ResizeObserver === 'undefined') {
          if (typeof window === 'undefined' || !window.addEventListener) return undefined
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])

      if (flow.length < 2) return null
      const latest = flow[flow.length - 1]
      const hidden = expanded ? 0 : Math.max(0, flow.length - fit)
      const shown = hidden ? flow.slice(hidden) : flow
      const clock = (s) => {
        const t = formatLocal(s.ts)
        return t ? t.slice(5, 16) : ''
      }
      return h('div', { ref: boxRef, style: Object.assign({}, style.timeline, expanded ? { flexWrap: 'wrap' } : null) },
        h('span', { style: style.timelineLine, 'aria-hidden': 'true' }),
        hidden
          ? h('button', {
            type: 'button',
            style: style.timelineMore,
            title: '展开更早 ' + hidden + ' 条',
            onClick: () => setExpanded(true),
          }, '‹ 更早 ' + hidden + ' 条')
          : null,
        shown.map((s) => {
          const isState = !s.kind || s.kind === 'state'
          const vetoed = (s.suspect || []).includes('vetoed')
          const dotStyle = isState ? (s.id === latest.id ? style.timelineDotNow : style.timelineDot) : style.timelineDotOther
          const labelStyle = isState ? (s.id === latest.id ? style.timelineLabelNow : style.timelineLabel) : style.timelineLabelOther
          const kindNote = isState ? '' : (RELATED_KIND[s.kind] || s.kind) + (vetoed ? '（已否决）' : '') + ' · '
          return h('button', {
            key: s.id,
            type: 'button',
            style: Object.assign({}, style.timelineNode, props.picked && props.picked.id === s.id ? style.timelineNodePicked : null),
            title: (formatLocal(s.ts) || '') + ' · ' + kindNote + (s.body || ''),
            onClick: () => props.onPick && props.onPick(s),
          },
            h('span', { style: dotStyle }),
            h('span', { style: labelStyle }, (vetoed ? '✗ ' : '') + clock(s)),
          )
        }),
        expanded && flow.length > fit
          ? h('button', { type: 'button', style: style.timelineMore, title: '收起', onClick: () => setExpanded(false) }, '收起')
          : null,
      )
    }

    const STRENGTH_LABEL = { user_said: '用户原话', measured: '实测', inferred: '推断' }
    const STATUS_LABEL = { active: '进行中', closed: '已完成', superseded: '已取代', expired: '已过期' }

    /** 时间线节点点开后的内容块（占原来「详情」的位置）。 */
    function NodeDetail(props) {
      const r = props.record || {}
      const rows = [
        ['时间', formatLocal(r.ts)],
        ['类型', !r.kind || r.kind === 'state' ? '状态' : (RELATED_KIND[r.kind] || r.kind) + ((r.suspect || []).includes('vetoed') ? '（已否决）' : '')],
        ['状态', STATUS_LABEL[r.status] || ''],
        ['强度', STRENGTH_LABEL[r.strength] || r.strength || ''],
        ['下一步', r.next || '（已闭环）'],
        ['正文', r.body || ''],
        ['topic', (r.topicName || r.topic || '') + (r.topicId ? ' (' + r.topicId + ')' : '')],
        ['id', r.id || ''],
      ].filter(([, v]) => v)
      return h('div', { style: style.nodeDetail },
        h('div', { style: style.nodeDetailHead }, '节点内容'),
        h('div', { style: style.kv }, rows.map(([k, v]) => h(KV, { key: k, k, v }))),
      )
    }

    /** 状态 / 死路 / 指南 / 结论：正文 + 可选下一步。`showState` 时额外标 topic 与状态。 */

    function RecordItem(props) {
      const r = props.record
      // 状态卡：点时间线上的节点，在原来「详情」的位置展示该节点内容
      const [picked, setPicked] = React.useState(undefined)
      const statusWarn = r.status === 'superseded' || r.status === 'expired'
      // 被否决的方案：注入里缩进挂在所属线下面显示「✗ 已否决」，页面也必须认得出来。
      // 它是最容易被重复提出的一类，看不出是「否过的」就等于白记。
      const vetoed = (r.suspect || []).includes('vetoed')
      // 项目档案（suspect:['profile']）是 fact 的汇总产物，类型徽标显示「档案」而不是「事实」
      const profile = (r.suspect || []).includes('profile')
      return h('article', { style: style.item },
        h('div', { style: style.itemHead },
          props.showScope ? h(Chip, null, r.scope === 'global' ? '全局' : '本工作区') : null,
          // 「结论与事实」这一栏混装 conclusion 与 fact，不标类型就分不清是哪类
          props.showKind ? h(Chip, null, profile ? '档案' : (r.kind === 'fact' ? '事实' : '结论')) : null,
          vetoed ? h(Chip, { warn: true }, '✗ 已否决') : null,
          vetoed && (r.topicName || r.topic) ? h(Chip, { warn: true }, '挂在 ' + (r.topicName || r.topic)) : null,
          props.showState ? h(Chip, null, r.topicName || r.topic) : null,
          // 状态卡要能看到 topic_id：用户拿它就能直接跟模型说「继续处理 tp_xxxxxx」，
          // 不用再描述是哪条线。点一下即全选（CSS），选区可直接复制。
          props.showState && r.topicId
            ? h('code', { style: style.topicId, title: '点一下即全选，复制后可直接让模型「继续处理 ' + r.topicId + '」' }, r.topicId)
            : null,
          props.showState ? h(Chip, { warn: statusWarn }, STATUS_LABEL[r.status] || '进行中') : null,
          props.showState && r.strength ? h(Chip, null, STRENGTH_LABEL[r.strength] || r.strength) : null,
          !props.showState && r.strength && r.strength !== 'inferred' ? h(Chip, null, r.strength === 'user_said' ? '用户原话' : '实测') : null,
          h('span', { style: { flex: 1 } }),
          r.ts ? h('span', { style: style.mono, title: formatLocal(r.ts) }, formatLocal(r.ts) + ' · ' + daysAgo(r.ts)) : null,
        ),
        // 档案是按主题分行的多行文本；普通记录的 body 仍按单行渲染
        h('p', { style: profile ? Object.assign({}, style.itemBody, { whiteSpace: 'pre-wrap' }) : style.itemBody }, r.body),
        r.next ? h('div', { style: style.kv }, h(KV, { k: '下一步', v: r.next })) : null,
        props.showState && props.timelineStates
          ? h(TopicTimeline, { record: r, states: props.timelineStates, related: props.related || [], picked, onPick: setPicked })
          : null,
        r.evidence ? h('blockquote', { style: style.quote }, '“' + r.evidence + '”') : null,
        props.showState
          ? (picked ? h(NodeDetail, { record: picked }) : null)
          : h(Detail, { record: r }),
      )
    }

    /**
     * 旧数据根的显式迁移（页面唯一的写操作）。
     * 只有「旧根有记录 + 当前根是空库」时按钮才可用；点第一次变确认态，点第二次才发请求。
     * 只复制、不删源 —— 删源留给 scripts/migrate-data-root.mjs --prune，由人决定。
     */
    function LegacyMigrator(props) {
      const legacy = props.legacy || []
      const rootRecords = props.rootRecords || 0
      const [armed, setArmed] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      if (!legacy.length) return null
      const blocked = rootRecords > 0
      const start = (from) => {
        if (blocked || busy) return
        // 两段式确认：第一次点只「上膛」，避免误点把库搬走
        if (armed !== from) {
          setArmed(from)
          setResult(null)
          return
        }
        setBusy(from)
        const base = typeof document === 'undefined' || typeof document.baseURI !== 'string' ? '/' : document.baseURI
        const target = new URL(API_MIGRATE + '?from=' + encodeURIComponent(from), base).href
        fetch(target, { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(readJson)
          .then((data) => {
            setBusy(String(''))
            setArmed(String(''))
            setResult({ ok: true, msg: '已迁移 ' + data.lines + ' 条（源保留原样）' })
            if (props.onDone) props.onDone()
          })
          .catch((e) => {
            setBusy(String(''))
            setArmed(String(''))
            setResult({ ok: false, msg: String((e && e.message) || e) })
          })
      }
      return h('div', { style: style.migrate, 'data-waystone-migrate': 'panel' },
        h('p', { style: style.hint }, blocked
          ? '旧数据根还有记录，但当前根已有 ' + rootRecords + ' 条 —— 不能一键合并，要合并请跑 scripts/migrate-data-root.mjs --merge。'
          : '发现旧数据根里的记录。迁移会把它们复制到当前根，源保留原样，确认无误后自己删旧目录。'),
        legacy.map((item) => h('div', { key: item.path, style: style.migrateRow },
          h('span', { style: style.mono, title: item.path }, item.path),
          h('span', { style: style.meta }, item.records + ' 条'),
          // 当前根非空时不给按钮：这里没有能干的事，合并是脚本 --merge 的活
          blocked
            ? null
            : h('button', {
              type: 'button',
              'data-ws-btn': '',
              style: Object.assign({}, style.button, busy ? { opacity: 0.55, cursor: 'not-allowed' } : null),
              disabled: !!busy,
              onClick: () => start(item.path),
            }, busy === item.path ? '迁移中…' : (armed === item.path ? '确认迁移 ' + item.records + ' 条？' : '迁移到当前根')),
        )),
        result ? h('p', { style: result.ok ? style.okText : style.error, role: result.ok ? 'status' : 'alert' }, result.msg) : null,
      )
    }

    // ───────────────────────── 只读记忆视图：页面 ─────────────────────────

    /**
     * 会话顶部的只读视图（`conversation.view`，和「记忆」「白板看板」并列）。
     * 宿主把当前 `sessionId` 作为标准 props 交进来，页面据此落到**本会话所属**的工作区，
     * 也可以手动切到本机其它工作区的库。
     */
    function WaystonePage(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [ws, setWs] = React.useState('')
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      /** 点选的分区：默认概览。只存组件内存，刷新回到概览。 */
      const [panel, setPanel] = React.useState('overview')
      /** 「结论与事实」的筛选：all|profile|fact|conclusion，只存组件内存 */
      const [factFilter, setFactFilter] = React.useState('all')
      const wide = useWide(980)

      const load = React.useCallback((target) => {
        setBusy(true)
        setError('')
        return fetchState(target === undefined ? ws : target, sessionId)
          .then((data) => { setState(data); if (data && data.workspaceKey) setWs(data.workspaceKey) })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }, [ws, sessionId])

      React.useEffect(() => { load('') }, [sessionId])

      if (error) {
        return h('div', { style: style.page },
          h(BaseStyles, null),
          h('div', { style: style.banner, role: 'alert', 'aria-live': 'polite' }, '取不到记忆数据：' + error),
          h('p', { style: style.empty }, '宿主路由 /api/waystone/state 不可达，或插件行未启用。确认后重试。'),
          h('div', { style: style.bar },
            h('button', { type: 'button', style: style.button, 'data-ws-btn': '', onClick: () => load('') }, '重试'),
          ),
        )
      }
      if (state === null) {
        return h('div', { style: style.page },
          h(BaseStyles, null),
          h('h1', { style: style.title }, '路标 · 工作记忆'),
          h('p', { style: style.empty, role: 'status' }, busy ? '读取中…' : '暂无数据'),
          h('div', { style: style.skeleton, 'aria-hidden': 'true' },
            h('div', { style: Object.assign({}, style.skeletonBar, { width: '38%' }) }),
            h('div', { style: Object.assign({}, style.skeletonBar, { width: '72%' }) }),
            h('div', { style: Object.assign({}, style.skeletonBar, { width: '56%' }) }),
          ),
        )
      }

      const workspaces = state.workspaces || []
      const groups = state.groups || {}
      const rules = groups.rule || []
      const globalRules = rules.filter((r) => r.scope === 'global')
      const localRules = rules.filter((r) => r.scope !== 'global')
      const config = state.config || {}
      const diagnostics = [
        ['存储根', state.dataDir],
        ['根来源', state.dataDirSource],
        ['配置来源', '设置页（cordis.patch.yml 的 waystone 行）'],
        ['工作区键', state.workspaceKey],
        ['规则上限', String(config.rulesMax ?? '') + ' 条（全局/本工作区各算）'],
        ['注入预算', String(config.injectBudgetTokens ?? '') + ' 词元（交接段占 55%）'],
        ['整理阈值', '结论 ' + String(config.compactConclusionMax ?? '') + ' 条 / 事实 ' + String(config.compactFactMax ?? '') + ' 条'],
        ['单次整理', String(config.compactBatch ?? '') + ' 条'],
        ['契约字节', String(state.contractBytes || 0) + ' B'],
        ['最后写入', formatLocal(state.lastWriteAt) || '—'],
      ]

      const header = h('header', { style: style.head },
        h('div', { style: style.headRow },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
            h('h1', { style: style.title }, '路标 · 工作记忆'),
            h('p', { style: style.subtitle }, '只读视图：这一份工作区当下往模型里注入了什么 —— 全局规则对所有项目生效，本工作区规则只对本项目生效。'),
          ),
          h('div', { style: style.controls },
            // 可见标签 + aria-label 成对出现（UX 规范：表单控件必须有可见标签）
            workspaces.length > 0
              ? h('label', { style: style.inlineLabel, htmlFor: 'waystone-workspace' },
                '工作区',
                h('select', {
                  id: 'waystone-workspace',
                  style: style.input,
                  'data-ws-input': '',
                  value: ws,
                  'aria-label': '选择工作区',
                  onChange: (event) => { const next = event.target.value; setWs(next); load(next) },
                }, workspaces.map((w) => h('option', { key: w.key, value: w.key }, w.key + ' · ' + w.records + ' 条'))),
              )
              : null,
            h('button', {
              type: 'button',
              style: Object.assign({}, style.button, busy ? { opacity: 0.6, cursor: 'progress' } : null),
              'data-ws-btn': '',
              'aria-label': busy ? '正在刷新记忆数据' : '刷新记忆数据',
              disabled: busy,
              onClick: () => load(ws),
            }, busy ? '刷新中…' : '刷新'),
          ),
        ),
        h('div', { style: style.scope, 'aria-live': 'polite' },
          h('span', null, state.workspaceKey || '（未定位工作区）'),
          h('span', null, state.dataDir || ''),
          state.judgeDisabled ? h('span', { style: { color: T.warn } }, '判官已降级为手动写入') : null,
          state.configError ? h('span', { style: { color: T.danger } }, '配置错误：' + state.configError) : null,
          state.dataDirError ? h('span', { style: { color: T.danger } }, '数据根错误：' + state.dataDirError) : null,
        ),
      )

      const stats = h('div', { style: style.stats },
        h(Stat, { value: globalRules.length, label: '全局规则', hint: '对所有项目生效', onClick: () => setPanel('global') }),
        h(Stat, { value: localRules.length, label: '本工作区规则', hint: '上限 ' + (state.rules ? state.rules.max : '—'), onClick: () => setPanel('local') }),
        h(Stat, { value: state.sessions || 0, label: '会话分片', onClick: () => setPanel('diag') }),
        h(Stat, { value: (groups.state || []).length, label: '工作线', onClick: () => setPanel('state') }),
        h(Stat, { value: state.staleAnchors || 0, label: '陈旧锚点', hint: state.staleAnchors ? '原文已变' : '全部可指回原文', onClick: () => setPanel('diag') }),
      )

      const globalSection = h(Section, { title: '全局规则', count: globalRules.length, note: '跨工作区共享 · 只有 rule 能进全局库' },
        globalRules.length === 0
          ? h(Empty, null, '本机还没有全局规则。只有用户说出「所有项目 / 以后都 / 每台机器都」这类要求时才会写进全局库。')
          : globalRules.map((r) => h(RuleItem, { key: r.id, rule: r })),
      )

      const localSection = h(Section, { title: '本工作区规则', count: localRules.length, note: '只对当前项目生效' },
        localRules.length === 0
          ? h(Empty, null, '本工作区还没有规则。用户明确纠正、或说出「必须 / 禁止 / 不准」时才会写。')
          : localRules.map((r) => h(RuleItem, { key: r.id, rule: r })),
      )

      // 当前状态 = 注入面里的那段交接原文（同一个渲染函数，不再各写一套派生）
      const currentStateSection = h(Section, { title: '当前状态', note: '交接段原文 · 压缩或换窗口后模型靠这一段接手' },
        state.tailText
          ? h('pre', { style: style.pre, 'data-waystone': 'handoff' }, state.tailText)
          : h(Empty, null, '还没有交接内容。'),
      )

      const deadendSection = h(Section, { title: '死路', count: (groups.deadend || []).length, note: '同一方案别重试，除非有新证据' },
        (groups.deadend || []).length === 0
          ? h(Empty, null, '没有记录死路。')
          : (groups.deadend || []).map((r) => h(RecordItem, { key: r.id, record: r, showScope: true })),
      )

      const guideSection = h(Section, { title: '指南', count: (groups.guide || []).length, note: '命中才注入索引' },
        (groups.guide || []).length === 0
          ? h(Empty, null, '没有指南。用户确认「以后都这么做」的步骤才会沉淀成指南。')
          : (groups.guide || []).map((r) => h(RecordItem, { key: r.id, record: r, showScope: true })),
      )

      // 工作线 = 进行中 + 已完成（已取代/已过期不再单开折叠区：同 topic 的历史看卡片里的时间线）
      const allStates = (groups.stateAll || groups.state || [])
        .slice()
        .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
      const liveStates = allStates.filter((r) => r.status === 'active')
      const doneStates = allStates.filter((r) => r.status === 'closed')
      // 工作线只以 state 立卡，但 conclusion/fact/guide/deadend 也可能挂在同一个 topic_id 上
      // （被否决的方案必须挂线）。按 topic 归一次组，卡片里摊开，页面才看得到「这条线的全部内容」。
      const relatedByTopic = {}
      for (const kind of ['conclusion', 'fact', 'guide', 'deadend']) {
        for (const r of groups[kind] || []) {
          const key = r.topicId || ''
          if (!key) continue
          if (!relatedByTopic[key]) relatedByTopic[key] = []
          relatedByTopic[key].push(Object.assign({}, r, { kind }))
        }
      }
      for (const key of Object.keys(relatedByTopic)) {
        relatedByTopic[key].sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
      }
      const stateSection = h(Section, { title: '工作线', count: liveStates.length + doneStates.length, note: '进行中在前 · 已完成的收在下面 · 点卡片头部的 tp_ 编号即全选，可直接让模型「继续处理这条」' },
        allStates.length === 0
          ? h(Empty, null, '还没有工作线。')
          : h(React.Fragment, null,
            liveStates.map((r) => h(RecordItem, { key: r.id, record: r, showState: true, timelineStates: allStates, related: relatedByTopic[r.topicId || ''] || [] })),
            doneStates.length
              ? h('details', { style: style.details },
                h('summary', { style: style.summary, 'data-ws-summary': '' }, '已完成（' + doneStates.length + '）'),
                doneStates.map((r) => h(RecordItem, { key: r.id, record: r, showState: true, timelineStates: allStates, related: relatedByTopic[r.topicId || ''] || [] })),
              )
              : null,
          ),
      )

      // 「结论与事实」= conclusion + fact（含项目档案 fact）。分类只服务于筛选，不改数据。
      const otherAll = (groups.conclusion || []).map((r) => Object.assign({}, r, { kind: 'conclusion' }))
        .concat((groups.fact || []).map((r) => Object.assign({}, r, { kind: 'fact' })))
      const otherKind = (r) => ((r.suspect || []).includes('profile') ? 'profile' : (r.kind === 'fact' ? 'fact' : 'conclusion'))
      const otherShown = otherAll.filter((r) => factFilter === 'all' || otherKind(r) === factFilter)
      const filterBtn = (key, label) => h('button', {
        key,
        type: 'button',
        'data-ws-btn': '',
        'aria-pressed': factFilter === key ? 'true' : 'false',
        style: factFilter === key ? style.filterBtnOn : style.filterBtn,
        onClick: () => setFactFilter(key),
      }, label)
      const otherSection = h(Section, {
        title: '结论与事实',
        count: otherShown.length,
        note: '事实只留指针',
        right: h('div', { style: style.filterBar, role: 'group', 'aria-label': '筛选结论与事实' },
          filterBtn('all', '全部'), filterBtn('profile', '项目档案'), filterBtn('fact', '事实'), filterBtn('conclusion', '结论')),
      },
        otherAll.length === 0
          ? h(Empty, null, '没有结论或事实记录。')
          : otherShown.length === 0
            ? h(Empty, null, '该筛选下没有记录。')
            // 被否决的方案排在最前：它防的是「重提同一个被否过的方案」，比普通结论更需要被看见
            // 记录本身不带 kind（分组来自数据），这里补上让卡片能标「结论 / 事实」
            : otherShown.slice()
              .sort((x, y) => (((y.suspect || []).includes('vetoed') ? 1 : 0) - ((x.suspect || []).includes('vetoed') ? 1 : 0))
                || (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
              .map((r) => h(RecordItem, { key: r.id, record: r, showScope: true, showKind: true })),
      )

      const injectSection = h(Section, { title: '注入预览', note: '逐字节真实注入，用于核对' },
        h('details', { style: style.details, open: true },
          h('summary', { style: style.summary, 'data-ws-summary': '' }, '系统提示 · 规约段'),
          state.rulesText ? h('pre', { style: style.pre }, state.rulesText) : h(Empty, null, '（无规约，注入为空）'),
        ),
        h('details', { style: style.details },
          h('summary', { style: style.summary, 'data-ws-summary': '' }, '对话尾部 · 交接段'),
          state.tailText ? h('pre', { style: style.pre }, state.tailText) : h(Empty, null, '（空）'),
        ),
        h('details', { style: style.details },
          h('summary', { style: style.summary, 'data-ws-summary': '' }, '本会话最近一次真实注入'),
          state.injectedText ? h('pre', { style: style.pre }, state.injectedText) : h(Empty, null, '本进程还没有渲染过该工作区的注入。'),
          (state.lastInjections || []).length
            ? h('p', { style: style.meta }, '最近 ' + state.lastInjections.length + ' 次：' + state.lastInjections.map((x) => x.bytes + 'B / ' + x.sha256).join(' · '))
            : null,
        ),
      )

      const diagSection = h(Section, { title: '诊断', note: '只读 · 除「旧数据根」迁移外不改盘' },
        h('details', { style: style.details },
          h('summary', { style: style.summary, 'data-ws-summary': '' }, '存储位置与计数'),
          h('div', { style: style.kv }, diagnostics.map(([k, v]) => h(KV, { key: k, k, v: v || '—' }))),
        ),
        h(LegacyMigrator, {
          legacy: state.legacyDirs || [],
          rootRecords: state.rootRecords || 0,
          dataDir: state.dataDir,
          onDone: () => load(ws),
        }),
      )

      const overviewSection = h(Section, { title: '这一份工作区的状态', note: '点左侧分区看细节' },
        h('div', { style: style.kv },
          h(KV, { k: '规则', v: globalRules.length + ' 条全局 · ' + localRules.length + ' 条本工作区' }),
          h(KV, { k: '记录', v: '状态 ' + (groups.state || []).length + ' · 死路 ' + (groups.deadend || []).length + ' · 指南 ' + (groups.guide || []).length + ' · 结论 ' + ((groups.conclusion || []).length + (groups.fact || []).length) }),
          h(KV, { k: '体积', v: String(state.sizeBytes || 0) + ' B' }),
          h(KV, { k: '契约字节', v: String(state.contractBytes || 0) + ' B' }),
          h(KV, { k: '最后写入', v: formatLocal(state.lastWriteAt) || '—' }),
        ),
      )

      const navItems = [
        { id: 'overview', label: '概览' },
        { group: '记忆' },
        { id: 'global', label: '全局规则', count: globalRules.length },
        { id: 'local', label: '本工作区规则', count: localRules.length },
        { id: 'deadend', label: '死路', count: (groups.deadend || []).length },
        { id: 'guide', label: '指南', count: (groups.guide || []).length },
        { id: 'state', label: '工作线', count: (groups.state || []).length },
        { id: 'other', label: '结论与事实', count: (groups.conclusion || []).length + (groups.fact || []).length },
        { group: '调试' },
        { id: 'inject', label: '注入预览' },
        { id: 'diag', label: '诊断' },
      ]
      const tabItems = navItems.filter((item) => item.id)
      const currentIndex = Math.max(0, tabItems.findIndex((item) => item.id === panel))
      const selectPanel = (id, moveFocus) => {
        setPanel(id)
        // 只有键盘切换才移焦点：鼠标点击后抢焦点会和选中态叠出第二个视觉标记
        if (!moveFocus) return
        try {
          const node = typeof document !== 'undefined' ? document.getElementById('waystone-tab-' + id) : null
          if (node && typeof node.focus === 'function') node.focus()
        } catch {
          /* 拿不到 DOM 就算了 */
        }
      }
      const step = (delta) => selectPanel(tabItems[(currentIndex + delta + tabItems.length) % tabItems.length].id, true)

      const rail = h('nav', {
        style: Object.assign({}, style.rail, wide ? null : style.railRow),
        role: 'tablist',
        'aria-label': '路标分区',
        'aria-orientation': wide ? 'vertical' : 'horizontal',
      }, navItems.map((item, index) => {
        if (item.group) {
          return h('div', { key: 'group-' + index, style: style.railGroup, 'aria-hidden': 'true' }, item.group)
        }
        const active = item.id === panel
        const base = Object.assign({}, style.railItem, wide ? null : { padding: '6px 10px 8px', boxShadow: 'inset 0 0 0 0 transparent' })
        const look = active
          ? (wide ? style.railItemActive : { background: T.surface2, color: T.ink, fontWeight: 600, boxShadow: 'inset 0 -3px 0 0 ' + T.accent })
          : null
        return h('button', {
          key: item.id,
          type: 'button',
          role: 'tab',
          id: 'waystone-tab-' + item.id,
          'aria-selected': active ? 'true' : 'false',
          'aria-controls': 'waystone-panel',
          tabIndex: active ? 0 : -1,
          'data-ws-tab': '',
          style: Object.assign(base, look),
          onClick: () => selectPanel(item.id, false),
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); step(1) }
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
            else if (event.key === 'Home') { event.preventDefault(); selectPanel(tabItems[0].id) }
            else if (event.key === 'End') { event.preventDefault(); selectPanel(tabItems[tabItems.length - 1].id) }
          },
        },
          h('span', { style: style.railLabel }, item.label),
          typeof item.count === 'number' ? h('span', { style: style.railCount }, String(item.count)) : null,
        )
      }))

      const body = panel === 'global' ? globalSection
        : panel === 'local' ? localSection
          : panel === 'deadend' ? deadendSection
            : panel === 'guide' ? guideSection
              : panel === 'state' ? stateSection
                : panel === 'other' ? otherSection
                  : panel === 'inject' ? injectSection
                    : panel === 'diag' ? diagSection
                      : h(React.Fragment, null, stats, currentStateSection, overviewSection)

      return h('div', {
        style: Object.assign({}, style.page, wide ? null : { flexDirection: 'column', gap: 12, padding: '12px 16px 32px' }),
      },
        h(BaseStyles, null),
        rail,
        h('div', { style: style.content },
          header,
          h('div', { style: style.panel, role: 'tabpanel', id: 'waystone-panel', 'aria-labelledby': 'waystone-tab-' + panel }, body),
        ),
      )
    }

    /** 浏览器半边要求的服务。 */
    const inject = ['slots']

    function apply(ctx) {
      // ① 插件页里那一行 → 只放配置项
      ctx.effect(
        () => ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_KEY, order: 10 },
            RowConfigView,
          )),
        'waystone: row config',
      )
      // ② 会话顶部标签页（和「记忆」「白板看板」并列）→ 只读记忆查看页
      ctx.effect(
        () => ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'waystone', order: 85, label: '路标' },
            WaystonePage,
          )),
        'waystone: conversation view',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.ROW_KEY = ROW_KEY
    exports.FIELDS = FIELDS
    exports.RowConfigView = RowConfigView
    exports.ConfigForm = ConfigForm
    exports.WaystonePage = WaystonePage
    exports.fetchState = fetchState
    exports.summaryOf = summaryOf
    exports.draftOf = draftOf
    exports.submittedOf = submittedOf
    return module.exports
  },
})
