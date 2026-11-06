/**
 * 客户端半边的可执行自检：用最小 React 替身真的把 lib/client.js 跑一遍。
 *
 * 目的不是测样式，而是守住三件会「只在浏览器里才炸」的事：
 *  1. factory 能执行完并交出 apply/inject/组件；
 *  2. `conversation.view` 与 `plugins.row.config` 都注册上了；
 *  3. 加载分支能渲染、当前状态面板直接渲染交接段原文、工作线分区按进行中/已完成分。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const stateOverride = { value: null }

const ReactStub = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useState(initial) {
    // WaystonePage 的 state 以 null 起手，再用 setState 灌数据；测试里直接替换初值，
    // 这样不依赖真实网络也能渲染「有数据」分支。
    if (initial === null && stateOverride.value) return [stateOverride.value, () => {}]
    // 分区默认 'overview'：测试要直接看某个分区时替换初值（点不到左侧导航）。
    if (initial === 'overview' && stateOverride.panel) return [stateOverride.panel, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  useCallback(fn) {
    return fn
  },
}

/** 加载 client.js，返回它交出的模块对象。每次用不同的 query 拿一份新实例（ESM 会缓存）。 */
let loaderCase = 0
async function loadClient() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  globalThis.document = { baseURI: 'http://127.0.0.1/' }
  loaderCase += 1
  await import('../lib/client.js?case=' + loaderCase)
  assert.ok(spec, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(spec.id, 'dsh-waystone')
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error('意外的 require：' + name)
  })
}

test('客户端工厂可执行，并交出 apply / inject / 组件', async () => {
  const mod = await loadClient()
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.WaystonePage, 'function')
  assert.equal(typeof mod.RowConfigView, 'function')
  assert.equal(mod.ROW_KEY, 'dsh-waystone#waystone')
})

test('装配：两个插槽都注册（会话视图 + 行配置）', async () => {
  const mod = await loadClient()
  const registered = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    slots: {
      inject(name, run) { registered.push(name); return run() },
      register(options) { registered.push(options.name + ':' + (options.id || options.key)); return () => {} },
    },
  }
  mod.apply(ctx)
  assert.ok(registered.includes('plugins.row.config'), registered.join(','))
  assert.ok(registered.includes('conversation.view'), registered.join(','))
  assert.ok(registered.includes('conversation.view:waystone'), registered.join(','))
})

test('加载分支可渲染（state=null 时出骨架，不抛）', async () => {
  const mod = await loadClient()
  const tree = mod.WaystonePage({ sessionId: 's-1' })
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('路标'), '页面标题缺失')
  assert.ok(flat.length > 0)
})

test('当前状态面板直接渲染注入原文（不再有第二套 目标/在做 派生）', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    dataDir: 'C:/data',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: { max: 30 },
    sessions: 1,
    rulesText: '',
    tailText: '[交接]\n- t-main：在做 B；下一步：跑测试\n- t-ui：改概览页；下一步：等设计稿',
    groups: {
      state: [{ id: 'as_3', body: '在做 B', next: '跑测试', ts: '2026-11-04T12:00:00.000Z', status: 'active' }],
      stateAll: [
        { id: 'as_3', body: '在做 B', next: '跑测试', ts: '2026-11-04T12:00:00.000Z', status: 'active', topic: 't-main' },
        { id: 'as_2', body: '先做 A', next: '跑测试', ts: '2026-11-04T11:00:00.000Z', status: 'superseded', topic: 't-main' },
      ],
    },
  }
  try {
    const flat = JSON.stringify(mod.WaystonePage({ sessionId: 's-1' }))
    assert.ok(flat.includes('- t-ui：改概览页'), '当前状态没直接渲染交接段原文')
    assert.ok(!mod.handoffOf, 'handoffOf 应该已经删掉')
    assert.ok(stateOverride.value.groups.stateAll.length === 2)
  } finally {
    stateOverride.value = null
  }
})

test('数据分支可渲染：左侧导航 + 概览面板 + 全局规则分区', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    dataDir: 'C:/data',
    dataDirSource: 'default',
    workspaces: [{ key: 'ws-1', records: 2 }],
    config: { rulesMax: 30, injectBudgetTokens: 1500 },
    rules: { max: 30 },
    sessions: 1,
    sizeBytes: 123,
    lastWriteAt: '2026-11-04T10:00:00.000Z',
    staleAnchors: 0,
    judgeDisabled: false,
    contractBytes: 900,
    rulesText: '',
    tailText: '',
    injectedText: '',
    lastInjections: [],
    groups: {
      rule: [{ id: 'as_rule1', scope: 'global', body: '所有项目都别用全局锁', strength: 'user_said', ts: '2026-11-04T09:00:00.000Z' }],
      state: [{ id: 'as_state1', body: '在做 B', next: '跑测试', ts: '2026-11-04T10:00:00.000Z' }],
      deadend: [],
      guide: [],
      conclusion: [],
      fact: [],
    },
  }
  try {
    const tree = JSON.stringify(mod.WaystonePage({ sessionId: 's-1' }))
    assert.ok(tree.includes('"role":"tablist"'), '缺少 tablist 导航')
    assert.ok(tree.includes('全局规则'), '左侧导航缺少全局规则入口')
    assert.ok(tree.includes('本工作区规则'), '左侧导航缺少本工作区规则入口')
    assert.ok(tree.includes('概览'), '缺少概览入口')
    assert.ok(tree.includes('"aria-selected":"true"'), '缺少选中态')
    assert.ok(tree.includes('这一份工作区的状态'), '概览面板没渲染')
  } finally {
    stateOverride.value = null
  }
})

/** 最小深渲染：把函数组件按 props 调一遍，只为断言文本（不追求真实 React 行为）。 */
function renderDeep(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.flatMap(renderDeep)
  if (typeof node.type === 'function') return renderDeep(node.type({ ...node.props, children: node.children }))
  return Object.assign({}, node, { children: (node.children || []).flatMap(renderDeep) })
}

test('工作线：列进行中 + 已完成，已取代/已过期不列、折叠区已删除、空数组不炸', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    dataDir: 'C:/data',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: { max: 30 },
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: {
      state: [],
      stateAll: [
        { id: 'as_2', body: '旧状态', next: 'x', ts: '2026-11-04T11:00:00.000Z', status: 'superseded', topic: 't-a' },
        { id: 'as_3', body: '在做 B', next: '', ts: '2026-11-04T12:00:00.000Z', status: 'active', topic: 't-b', topicId: 'tp_bbbbbb', strength: 'measured' },
        { id: 'as_4', body: '这条做完了', next: '', ts: '2026-11-04T13:00:00.000Z', status: 'closed', topic: 't-c' },
        { id: 'as_5', body: '被取代的旧卡', next: 'x', ts: '2026-11-04T10:00:00.000Z', status: 'superseded', topic: 't-c' },
      ],
    },
  }
  stateOverride.panel = 'state'
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(!flat.includes('已取代 / 已过期'), '折叠区应该已经删掉（历史看时间线）')
    assert.ok(flat.includes('t-b'), '没标 topic')
    // 状态卡必须带 topic_id：用户拿它就能直接跟模型说「继续处理 tp_xxxxxx」
    assert.ok(flat.includes('tp_bbbbbb'), '状态卡没显示 topic_id')
    // 第四态：已完成的线收进「已完成（N）」折叠区，已取代/已过期的旧卡不列
    assert.ok(flat.includes('已完成（1）'), '已完成的线没收进折叠区')
    assert.ok(flat.includes('"已完成"'), '已完成状态没标')
    assert.ok(flat.includes('这条做完了'), '已完成的线应该还能在折叠区里找到')
    assert.ok(!flat.includes('旧状态'), '已取代的旧卡不该列成卡片')
    // 头部带上状态与强度；详情折叠块删掉，位置留给时间线节点
    assert.ok(flat.includes('"进行中"'), '头部没标状态（active 显示为「进行中」）')
    assert.ok(flat.includes('"实测"'), '头部没标强度')
    assert.ok(!flat.includes('详情'), '状态卡的详情应该删掉')
    assert.ok(!flat.includes('节点内容'), '没点节点不该出现节点内容')
  } finally {
    stateOverride.panel = null
  }
  stateOverride.value = { workspaceKey: 'ws-1', workspaces: [{ key: 'ws-1' }], config: {}, rules: {}, groups: { state: [], stateAll: [] }, tailText: '', rulesText: '' }
  try {
    assert.ok(JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' }))).includes('还没有交接内容'))
  } finally {
    stateOverride.value = null
  }
})

test('状态时间线：同 topic 多条才画，右端给下一步与最新时间，超容量折成「更早 N 条」', async () => {
  const mod = await loadClient()
  const at = (h) => '2026-11-05T0' + h + ':00:00.000Z'
  const rec = (id, body, next, ts, status) => ({ id, body, next, ts, status, topic: 't-x' })
  stateOverride.value = {
    workspaceKey: 'ws-1',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: {},
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: {
      state: [],
      stateAll: [
        rec('as_1', '第一步', 'x', at('1'), 'superseded'),
        rec('as_2', '第二步', 'y', at('2'), 'superseded'),
        rec('as_3', '第三步', 'z', at('3'), 'superseded'),
        rec('as_4', '第四步', 'w', at('4'), 'superseded'),
        rec('as_5', '第五步', 'v', at('5'), 'superseded'),
        rec('as_6', '当前', '跑测试', at('6'), 'active'),
        { id: 'as_7', body: '另一条线', next: '别的', ts: at('7'), status: 'active', topic: 't-y' },
      ],
    },
  }
  stateOverride.panel = 'state'
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(!flat.includes('下一步：'), '下一步已经在卡片里，时间线不该重复')
    assert.ok(flat.includes('跑测试'), '卡片没给下一步')
    assert.ok(!flat.includes('最新 · '), '时间线右端不该再显示「最新 · 时间」')
    assert.ok(flat.includes('‹ 更早 2 条'), '超出容量没折叠（6 条 > 默认 4 格）')
    assert.ok(!flat.includes('第一步'), '折叠掉的旧节点不该渲染')
  } finally {
    stateOverride.panel = null
    stateOverride.value = null
  }
})

test('被否决的方案：页面标「✗ 已否决」+ 所属线名，且排在同组最前', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: { max: 30 },
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: {
      state: [],
      stateAll: [],
      conclusion: [
        { id: 'as_c1', body: '普通结论', ts: '2026-11-04T12:00:00.000Z', status: 'active', suspect: [] },
        { id: 'as_c2', body: '被否的方案', ts: '2026-11-04T10:00:00.000Z', status: 'active', suspect: ['vetoed'], topicId: 'tp_aaaaaa', topicName: '死路窗口轮转' },
      ],
      fact: [],
    },
  }
  stateOverride.panel = 'other'
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(flat.includes('✗ 已否决'), '页面没标出被否决：' + flat.slice(0, 300))
    assert.ok(flat.includes('挂在 死路窗口轮转'), '没显示挂在哪条线：' + flat.slice(0, 300))
    assert.ok(flat.includes('"结论"'), '结论与事实栏没标类型（结论/事实）：' + flat.slice(0, 300))
    assert.ok(flat.indexOf('被否的方案') < flat.indexOf('普通结论'), '被否决的应排在同组最前')
  } finally {
    stateOverride.panel = null
    stateOverride.value = null
  }
})

test('工作线：被否决的方案按时间顺序进同 topic 的时间轴', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: { max: 30 },
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: {
      state: [],
      stateAll: [{ id: 'as_s1', body: '在做轮转', next: '核对注入', ts: '2026-11-05T08:00:00.000Z', status: 'active', topic: 't-a', topicId: 'tp_aaaaaa', topicName: 't-a' }],
      conclusion: [{ id: 'as_c1', body: '被否的方案甲', ts: '2026-11-05T07:00:00.000Z', status: 'active', suspect: ['vetoed'], topicId: 'tp_aaaaaa', topicName: 't-a' }],
      fact: [],
      guide: [],
    },
  }
  stateOverride.panel = 'state'
  try {
    const tree = renderDeep(mod.WaystonePage({ sessionId: 's-1' }))
    const flat = JSON.stringify(tree)
    assert.ok(flat.includes('✗ '), '时间轴上的否决节点没打 ✗：' + flat.slice(0, 400))
    assert.ok(flat.includes('判断（已否决）'), '否决节点没标类型：' + flat.slice(0, 400))
    // 按 ts 排序：否决(07:00) 应在 state(08:00) 左边
    const titles = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && typeof n.props.title === 'string' && n.props.title.includes(' · ')) titles.push(n.props.title)
      ;(n.children || []).forEach(walk)
    }
    walk(tree)
    assert.ok(titles.length >= 2, '时间轴节点数不对：' + JSON.stringify(titles))
    assert.ok(titles[0].includes('判断（已否决）'), '否决节点应排最左（时间最早）：' + JSON.stringify(titles))
  } finally {
    stateOverride.panel = null
    stateOverride.value = null
  }
})

test('结论与事实：筛选按钮 全部/项目档案/事实/结论，默认全部', async () => {
  const mod = await loadClient()
  stateOverride.value = {
    workspaceKey: 'ws-1',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: { max: 30 },
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: {
      state: [],
      stateAll: [],
      conclusion: [{ id: 'as_c1', body: '普通结论', ts: '2026-11-05T01:00:00.000Z', status: 'active', suspect: [] }],
      fact: [
        { id: 'as_f1', body: '普通事实', ts: '2026-11-05T02:00:00.000Z', status: 'active', suspect: [] },
        { id: 'as_p1', body: '项目档案正文', ts: '2026-11-05T03:00:00.000Z', status: 'active', suspect: ['profile'], topic: '项目档案' },
      ],
    },
  }
  stateOverride.panel = 'other'
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(flat.includes('"aria-label":"筛选结论与事实"'), '缺筛选按钮组')
    for (const label of ['全部', '项目档案', '事实', '结论']) {
      assert.ok(flat.includes('"' + label + '"'), '缺筛选按钮：' + label)
    }
    assert.ok(flat.includes('"aria-pressed":"true"'), '默认选中「全部」的 aria-pressed 缺失')
    assert.ok(flat.includes('"aria-pressed":"false"'), '未选中的 aria-pressed 缺失')
    assert.ok(flat.includes('普通结论') && flat.includes('普通事实') && flat.includes('项目档案正文'), '全部筛选下应显示全部记录')
  } finally {
    stateOverride.panel = null
    stateOverride.value = null
  }
})

test('诊断：发现旧数据根时给迁移入口，当前根非空只提示用脚本合并', async () => {
  const mod = await loadClient()
  const base = {
    workspaceKey: 'ws-1',
    dataDir: 'C:/new/waystone/data',
    workspaces: [{ key: 'ws-1' }],
    config: {},
    rules: {},
    sessions: 1,
    rulesText: '',
    tailText: '',
    groups: { state: [], stateAll: [] },
    legacyDirs: [{ path: 'C:/old/waystone/data', records: 12 }],
  }
  stateOverride.panel = 'diag'
  stateOverride.value = Object.assign({}, base, { rootRecords: 0 })
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(flat.includes('迁移到当前根'), '空库时缺迁移按钮')
    assert.ok(flat.includes('12 条'), '缺旧库条数')
    assert.ok(flat.includes('C:/old/waystone/data'), '缺旧根路径')
  } finally {
    stateOverride.value = Object.assign({}, base, { rootRecords: 5 })
  }
  try {
    const flat = JSON.stringify(renderDeep(mod.WaystonePage({ sessionId: 's-1' })))
    assert.ok(flat.includes('不能一键合并') && flat.includes('--merge'), '当前根非空时应指向脚本合并')
    assert.ok(!flat.includes('迁移到当前根'), '当前根非空时不该给迁移按钮')
  } finally {
    stateOverride.panel = null
    stateOverride.value = null
  }
})

test('行配置：6 个旋钮都渲染、默认值来自 fallback、文案全中文且不含过时口径', async () => {
  const mod = await loadClient()
  const form = { state: { value: {}, revision: 1, writable: true }, mutate() {} }
  const flat = JSON.stringify(renderDeep(mod.RowConfigView({ view: 'form', form })))
  for (const key of ['rulesMax', 'injectBudgetTokens', 'compactConclusionMax', 'compactFactMax', 'compactBatch', 'dataDir']) {
    assert.ok(flat.includes('waystone-' + key), '配置表单缺少字段 ' + key)
  }
  // 空配置下用 FIELDS.fallback：三个整理旋钮要显示真实默认值
  assert.ok(flat.includes('"value":"60"') && flat.includes('"value":"40"'), '整理阈值默认值没渲染出来')
  // 规则上限必须说清只算「规则」这一类、且全局与本工作区各自算
  assert.ok(flat.includes('只算「规则」这一类') && flat.includes('各自封顶'), '规则上限的说明没写清作用域')
  // 文案里不该再出现记录类型/预算单位的英文（面板用的是 规则/结论/事实/词元）
  for (const word of ['kind=rule', 'conclusion', 'fact', 'token', 'baseDir']) {
    assert.ok(!flat.includes(word), '配置文案里还留着英文：' + word)
  }
  // 存储根的默认根是宿主数据目录，不能再说成用户目录下的 .dsh
  assert.ok(!flat.includes('留空 = ~/.dsh'), '存储根说明还是过时的兜底口径')
  // 摘要行带上新增旋钮
  const summary = JSON.stringify(renderDeep(mod.RowConfigView({ view: 'summary', form: { state: { value: {} } } })))
  assert.ok(summary.includes('整理阈值 结论 60 / 事实 40 条'), summary)
  assert.ok(summary.includes('宿主数据目录下的 waystone/data'), summary)
})