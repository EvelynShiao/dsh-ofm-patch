/**
 * dsh-ofm-patch v3.1 — 浏览器半身：OFM 界面「智能折叠大项 / 砍动画 / 拆广告 / tab 收纳」。
 *
 * 设计铁律（用户 2026-11-17 口述：「智能适配……不要弄来什么变了就不行」）：
 * - 不写死上游类名为唯一依据——锚点用上游自用的功能属性 data-ofm-effects（特效
 *   开关的 DOM 落点，上游自己读写它）与语义特征（联署链接、tab 文本、标题文本），
 *   探测到什么就用什么，探测不到就静默不动作（fail-open，绝不炸页面）。
 * - 不碰 React 树内部状态：我们只插入自带标记的兄弟节点（折叠条）与 display 隐藏，
 *   React 重渲染冲掉后由 MutationObserver 防抖重扫重放；所有插入/隐藏都带
 *   data-ofmp-* 标记，重扫时先识别自己的痕迹避免自触发风暴。
 * - 全部功能各自开关（localStorage dsh-ofm-patch.prefs），右下角小圆钮控制。
 *
 * 四件套（9999.11.1 修订）：
 * 1. motion  砍动画：transition **和 animation** 全归零（v3.0 只砍 transition，
 *    用户实测「动画没砍掉」——残留 15 个 keyframes 全是鱼缸系）。鱼缸 ofm_tank
 *    直接 display:none（上游 effects 开关刻意保留鱼缸，用户明确要砍）；loading
 *    spinner（ofm-btn-spin/ofm_engine_spin，均为伪元素且特异性更高）后置恢复
 *    规则保住转圈，避免停格假死。宿主全局动画（鲸鱼壁纸等）不在本插件范围。
 * 2. ads     拆广告：a) 联署/推广链接（href 含 beichenapi.com 或 aff= 参数）
 *    上溯卡片容器隐藏；b) 「推荐项目/Picks」nav tab 隐藏，当前停在该 tab 则
 *    自动点回第一个可见 tab。MutationObserver 回调里**同步即时隐藏**（v3.0
 *    走防抖导致「打开闪现一下处理前的画面」）。
 * 3. fold    智能折叠大项：在 OFM 根内扫描「tab 页直接子元素 + 大卡片」，
 *    渲染高度 ≥ FOLD_THRESHOLD 的视为大项，在其前插入折叠条（标题取目标内
 *    第一个 heading / 面板标题，截断 48 字），点击切换显隐；折叠状态按内容
 *    指纹（标题文本 hash）存 localStorage。真机 13 tab 审计全覆盖（零漏）。
 * 4. tidy    nav 收纳：OFM 一排 13 个 tab（工作台/许愿/router/聚合渠道等）
 *    默认只保留 keepTabs 名单（免费模型/EAC 模型），其余隐藏；保留名单在
 *    控制面板勾选自选；当前激活 tab 被藏时自动点回第一个可见。
 *    v3.4：「更多 ▾」浮层升级为 tab 管理器——列出全部 tab（不只被藏的），
 *    保留中的行带 ✕ 收起（跳转过的 tab 不再从浮层消失、随时可收，用户实测
 *    「折叠的东西展开了就没法关闭」），底部「收起全部」一键恢复默认保留。
 *
 * FOUC（闪现）修复：motion 兜底 CSS 在 apply() 时立即注入（不等探测）；广告
 * 类隐藏在 observer 回调同步执行；折叠/tabs 防抖 500→80ms。
 *
 * 装载：package.json dsh.client{platform:"web",immediately:true} +
 * exports["./client"]；宿主 client-modules 扫 Loader rows 组合 boot graph，
 * 手写 ModuleLoader bundle（无构建步骤，除宿主自带模块零依赖）。
 *
 * @module client.js
 */
window.__ModuleLoader__.load({
  id: 'dsh-ofm-patch',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'dsh-ofm-patch'
    const inject = ['locale']
    const STYLE_ID = 'dsh-ofm-patch-motion'
    const PREFS_KEY = 'dsh-ofm-patch.prefs'
    const FOLDS_KEY = 'dsh-ofm-patch.folds'
    /* 大项判定阈值(px)：panel（嵌套卡片）仍按高度；page 一级块结构优先全挂
       （v3.1 用户实测：高度阈值依赖视口宽度；v3.2 的 120px 下限仍漏掉公告
       中心 105px——9999.11.3 起一级块只排除 0 高（不可见/已藏），全挂）。 */
    const FOLD_THRESHOLD = 380
    const FOLD_PAGE_MIN = 1
    /* 上游 tab 页/卡片/面板的类名特征（ofm_ 是上游自有命名空间，作为辅助
       信号与 data-ofm-effects 属性双通道；失配时折叠退化到通用容器扫描）。 */
    const OFM_PAGE_SEL = '.ofm_page'
    const OFM_PANEL_SEL = '.ofm_panel'

    /* ── 偏好读写 ─────────────────────────────────────────────────────── */
    const DEFAULT_PREFS = { motion: true, ads: true, fold: true, tidy: true, collapseNew: true, keepTabs: ['free', 'eac'] }
    let prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS))
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
      for (const k of ['motion', 'ads', 'fold', 'tidy', 'collapseNew']) if (typeof saved[k] === 'boolean') prefs[k] = saved[k]
      if (Array.isArray(saved.keepTabs)) prefs.keepTabs = saved.keepTabs.filter(x => typeof x === 'string')
    } catch { /* 坏数据用默认 */ }
    function savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 隐私模式丢就丢 */ }
    }

    /* 折叠状态表：{ 指纹: true(收起) } */
    let folds = {}
    try { folds = JSON.parse(localStorage.getItem(FOLDS_KEY) || '{}') || {} } catch { folds = {} }
    let foldsDirty = false
    function saveFolds() {
      if (!foldsDirty) return
      foldsDirty = false
      try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)) } catch { /* 同上 */ }
    }

    /* ── i18n（9999.11.6，用户要求「弄的东西英文别忘了」）────────────────── */
    /* ZH/EN 双字典。apply(ctx) 里注册宿主 browser 侧 locale（同 adapter-compat
       先例：register 字典 + bind 现取）并替换 t；宿主 locale 缺席时按
       document.documentElement.lang / navigator.language 探测回落。命令式 DOM
       （折叠条/更多按钮/浮层）每次构建现取 t()——宿主切语言重渲染冲掉 DOM 后
       重扫重建自动跟随；控制面板每次打开刷新文案。 */
    const ZH = {
      dot: '补',
      dotTitle: 'ofm-patch：折叠/动画/广告/tab 开关',
      panelTitle: 'OFM 补丁 · 界面开关',
      fold: '智能折叠大项',
      motion: '砍动画（含鱼缸）',
      ads: '拆广告/推广',
      tidy: 'tab 收纳（只留勾选项）',
      collapseNew: '新大项默认收起',
      keepSub: '保留哪些 tab（勾选 = 显示）：',
      tabListHint: '打开 OFM 设置页后此处列出全部 tab',
      more: '更多 ▾',
      moreTitle: 'ofm-patch tab 管理器：点名称跳转 · ✕ 收起 · 底部可收起全部',
      popHead: '点名称跳转 · ✕ 收起',
      hideTitle: '收起该 tab（从保留名单移除，可再从浮层跳回）',
      hideAria: '收起 {name}',
      collapseAll: '收起全部（恢复默认保留）',
      collapseAllTitle: '从保留名单移除 {n} 个跳转过的 tab，恢复默认收纳',
      foldbarTitle: 'ofm-patch：点击展开/收起这个大项',
      bigItem: '大项（{h}px）',
      zenTitle: 'OpenCode 账号车道（ofm-patch 代管）',
      zenEnable: '启用（opencode_zen 渠道，借 CLI 登录账号）',
      zenOff: '已关闭',
      zenBusy: '切换中…',
      cleanupTitle: 'OpenCode 桥接会话清理',
      cleanupPreview: '可清理 {n} / 共 {total} 个桥接会话（只删 opencode 侧的，DSH 历史不动）',
      cleanupButton: '清理 {n} 个会话',
      cleanupConfirm: '确认删除 {n} 个 OpenCode 桥接会话？DSH 侧对话历史不会被删除。',
      cleanupBusy: '清理中…',
      cleanupDone: '已删除 {deleted} 个，失败 {failed} 个',
      cleanupFail: '清理失败',
    }
    const EN = {
      dot: 'P',
      dotTitle: 'ofm-patch: fold / motion / ads / tab toggles',
      panelTitle: 'OFM Patch · UI toggles',
      fold: 'Smart-fold big blocks',
      motion: 'Kill animations (incl. fish tank)',
      ads: 'Hide ads / promos',
      tidy: 'Tab tidy (keep checked only)',
      collapseNew: 'Collapse new blocks by default',
      keepSub: 'Tabs to keep (checked = visible):',
      tabListHint: 'Open the OFM settings page to list all tabs',
      more: 'More ▾',
      moreTitle: 'ofm-patch tab manager: click name to jump · ✕ to collapse · collapse-all at bottom',
      popHead: 'Click name to jump · ✕ to collapse',
      hideTitle: 'Collapse this tab (remove from keep list; jump back anytime)',
      hideAria: 'Collapse {name}',
      collapseAll: 'Collapse all (restore defaults)',
      collapseAllTitle: 'Remove {n} jumped-to tabs from the keep list and restore default tidy',
      foldbarTitle: 'ofm-patch: click to expand/collapse this block',
      zenTitle: 'OpenCode account lane (managed by ofm-patch)',
      zenEnable: 'Enable (opencode_zen channel, borrows CLI login)',
      zenOff: 'Off',
      zenBusy: 'Switching…',
      cleanupTitle: 'OpenCode bridge session cleanup',
      cleanupPreview: '{n} of {total} bridge sessions cleanable (opencode side only; DSH history untouched)',
      cleanupButton: 'Clean {n} sessions',
      cleanupConfirm: 'Delete {n} OpenCode bridge sessions? DSH history is not deleted.',
      cleanupBusy: 'Cleaning…',
      cleanupDone: 'Deleted {deleted}, failed {failed}',
      cleanupFail: 'Cleanup failed',
      bigItem: 'Big block ({h}px)',
    }
    function detectDict() {
      try {
        const lang = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
        return lang.startsWith('zh') ? ZH : EN
      } catch { return ZH }
    }
    let t = (key, vars) => {
      let out = detectDict()[key] || ZH[key] || key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }

    /* ── 工具 ─────────────────────────────────────────────────────────── */
    /** djb2 短哈希：指纹用，够散列、无依赖。 */
    function hash(str) {
      let hh = 5381
      for (let i = 0; i < str.length; i++) hh = ((hh << 5) + hh + str.charCodeAt(i)) >>> 0
      return hh.toString(36)
    }
    /** 目标元素的稳定标题：优先 heading/面板标题类，再 aria-label，再首段文本。 */
    function titleOf(el) {
      try {
        const heading = el.querySelector('h1,h2,h3,h4,[class*="paneltitle"],[class*="pagetitle"],summary')
        if (heading) {
          const text = (heading.textContent || '').replace(/\s+/g, ' ').trim()
          if (text) return text.slice(0, 48)
        }
        const label = el.getAttribute('aria-label')
        if (label) return label.replace(/\s+/g, ' ').trim().slice(0, 48)
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
        return text ? text.slice(0, 24) : ''
      } catch { return '' }
    }
    /** 元素是否可见（不看 getBoundingClientRect，省强制布局）。 */
    function visible(el) {
      try { return !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.style.display !== 'none' } catch { return false }
    }

    /* ── OFM 根探测（抗变版核心）───────────────────────────────────────── */
    /** 探测 OFM 根元素集合：锚点 = 上游特效开关的 data-ofm-effects 属性；
        失配时退回 ofm_root 类；再失配返回空——全部功能静默。 */
    function ofmRoots() {
      try {
        let roots = [...document.querySelectorAll('[data-ofm-effects]')]
        if (roots.length === 0) roots = [...document.querySelectorAll('.ofm_root')]
        return roots
      } catch { return [] }
    }
    function escapeClass(c) { return /^[A-Za-z_][\w-]*$/.test(c) ? c : `[class~="${c.replace(/"/g, '\\"')}"]` }

    /* ── 1. motion：砍过渡与装饰动画 ───────────────────────────────────── */
    /* spinner 恢复规则：两个 loading 圈都是伪元素且特异性 (0,3,0) 高于通配
       归零规则 (0,2,0)，后置恢复即赢——动画归零不能把转圈打成停格假死。 */
    const SPINNER_REVIVE = [
      '.ofm_btn[aria-busy="true"]::after{animation-duration:.7s !important;animation-iteration-count:infinite !important}',
      '.ofm_enginestarting::before{animation-duration:.9s !important;animation-iteration-count:infinite !important}',
    ].join('')
    function motionCss(scopes) {
      const scope = scopes.join(',')
      return [
        `${scope}, ${scope} * {`,
        '  transition-duration: 0s !important;',
        '  transition-delay: 0s !important;',
        '  animation-duration: 0s !important;',
        '  animation-delay: 0s !important;',
        '  animation-iteration-count: 1 !important;',
        '  scroll-behavior: auto !important;',
        '}',
        /* 鱼缸 = 纯装饰（气泡/鱼/波浪/光线/漂移 6 组 keyframes），直接拆。 */
        `${scope} .ofm_tank, ${scope} .ofm_tank * { display: none !important; }`,
        SPINNER_REVIVE,
      ].join('\n')
    }
    /** 注入/更新 motion CSS。root 未渲染时用 .ofm_root 兜底（防首帧闪现）。 */
    function applyMotion() {
      try {
        let el = document.getElementById(STYLE_ID)
        if (!prefs.motion) { if (el) el.remove(); return }
        const classes = new Set(ofmRoots().map(r => r.className).filter(c => typeof c === 'string' && c.trim()))
        const scopes = [...classes].map(c => `.${c.trim().split(/\s+/).map(escapeClass).join('.')}`)
        if (scopes.length === 0) scopes.push('.ofm_root')
        const css = motionCss(scopes)
        if (!el) {
          el = document.createElement('style')
          el.id = STYLE_ID
          el.dataset.plugin = NS
          document.head.appendChild(el)
        }
        if (el.textContent !== css) el.textContent = css
      } catch { /* fail-open */ }
    }

    /* ── 2. ads：拆广告（联署横幅 + picks tab）─────────────────────────── */
    /** 判定推广链接：联署域名或 aff= 返现参数（上游 2.8.5 = beichenapi.com）。 */
    function isAdLink(a) {
      try {
        const href = a.getAttribute('href') || ''
        if (!href || href.startsWith('#')) return false
        return /beichenapi\.com/i.test(href) || /[?&]aff=/i.test(href)
      } catch { return false }
    }
    /** 链接 → 所属卡片容器：从父级起 closest(aside/[class*=sponsor]/[class*=banner])——
        必须跳过 a 自身（CTA 类名常含 sponsor 字样，真机实锤踩坑）。 */
    function adContainer(a) {
      try {
        return a.parentElement?.closest('aside,[class*="sponsor"],[class*="banner"]') || a.parentElement
      } catch { return null }
    }
    /** 对一个节点（observer 即时）或整个根（重扫）隐藏广告容器。幂等。 */
    function hideAdIn(node) {
      try {
        const boxes = new Set()
        if (node.matches?.('[class*="sponsor"],aside') && [...node.querySelectorAll?.('a[href]') || []].some(isAdLink)) boxes.add(node)
        for (const a of node.querySelectorAll?.('a[href]') || []) {
          if (isAdLink(a)) { const box = adContainer(a); if (box && box.isConnected) boxes.add(box) }
        }
        for (const box of boxes) {
          box.style.display = 'none'
          box.dataset.ofmpHidden = 'ad'
        }
      } catch { /* fail-open */ }
    }
    /** 「推荐项目/Picks」tab 判定：文本含匹配（tab 文本带数字徽标，真机实锤
        「免费模型25」形态）+ id 形态双通道。 */
    function isPicksTab(btn) {
      try {
        const label = (btn.textContent || '').replace(/\s+/g, '')
        if (label.includes('推荐项目') || /picks/i.test(label)) return true
        if (/ofm-tab-picks/i.test(btn.id || '')) return true
        return false
      } catch { return false }
    }
    /** 当前激活 tab 被藏时 → 点回第一个可见 tab（React 合成事件响应原生 click）。 */
    function ensureVisibleTab(root) {
      try {
        const tabs = [...root.querySelectorAll('[role="tab"]')]
        const active = tabs.find(b => b.getAttribute('aria-selected') === 'true')
        if (active && active.style.display === 'none') {
          const next = tabs.find(b => b !== active && b.style.display !== 'none' && b.offsetHeight > 0)
          if (next) { next.click(); return true }
        }
      } catch { /* fail-open */ }
      return false
    }
    function applyAds(root) {
      try {
        if (!prefs.ads) return
        hideAdIn(root)
        for (const btn of root.querySelectorAll('[role="tab"]')) {
          if (!isPicksTab(btn)) continue
          btn.style.display = 'none'
          btn.dataset.ofmpHidden = 'ad'
        }
        ensureVisibleTab(root)
      } catch { /* fail-open */ }
    }

    /* ── 3. fold：智能折叠大项 ─────────────────────────────────────────── */
    /** 折叠条 DOM：与目标同级的独立节点，不进 React 组件树内部。 */
    function buildFoldBar(target, fingerprint) {
      const bar = document.createElement('div')
      bar.className = 'ofmp-foldbar'
      bar.dataset.ofmpBar = '1'
      bar.setAttribute('role', 'button')
      bar.setAttribute('aria-expanded', 'false')
      const title = titleOf(target) || t('bigItem', { h: Math.round(target.offsetHeight) })
      bar.textContent = `▸ ${title}`
      bar.title = t('foldbarTitle')
      bar.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        const collapsed = target.style.display !== 'none'
        target.style.display = collapsed ? 'none' : ''
        bar.setAttribute('aria-expanded', String(collapsed))
        bar.textContent = `${collapsed ? '▸' : '▾'} ${title}`
        folds[fingerprint] = collapsed
        foldsDirty = true
        saveFolds()
      })
      return bar
    }
    /** 折叠条/「更多」按钮的公共样式（主题变量带回落）。 */
    let foldStyled = false
    function ensureFoldStyle() {
      if (foldStyled) return
      foldStyled = true
      try {
        const style = document.createElement('style')
        style.dataset.plugin = NS
        style.textContent = [
          '.ofmp-foldbar{display:flex;align-items:center;gap:6px;padding:4px 10px;margin:0 0 6px;',
          '  border-radius:8px;border:1px dashed var(--dsw-alias-border-l2,rgb(120 140 170/40%));',
          '  background:var(--dsw-alias-bg-layer-1,rgb(127 127 127/6%));',
          '  color:var(--dsw-alias-label-secondary,#9fb3d1);font-size:12px;line-height:1.4;',
          '  cursor:pointer;user-select:none;position:relative;z-index:31}', /* z 高于上游吸顶 nav(z-30)：防展开长内容后折叠条被盖住点不到 */
          '.ofmp-foldbar:hover{color:var(--dsw-alias-label-primary,#dfe9f8);',
          '  border-color:var(--dsw-alias-state-business-primary,rgb(90 140 220/60%))}',
          '.ofmp-more{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgb(120 140 170/45%));',
          '  background:transparent;color:var(--dsw-alias-label-secondary,#9fb3d1);border-radius:99px;',
          '  padding:3px 10px;font-size:12px;cursor:pointer}',
          '.ofmp-more:hover{color:var(--dsw-alias-label-primary,#dfe9f8)}',
          '.ofmp-morepop{position:fixed;z-index:99998;min-width:150px;max-width:240px;max-height:62vh;overflow:auto;',
          '  padding:6px;border-radius:12px;',
          '  border:1px solid var(--dsw-alias-border-l2,rgb(120 140 170/45%));',
          '  background:var(--dsw-alias-bg-layer-2,rgb(20 28 44/96%));box-shadow:0 8px 24px rgb(0 0 0/30%)}',
          '.ofmp-morepop button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:8px;',
          '  background:transparent;color:var(--dsw-alias-label-primary,#dfe9f8);font-size:12px;cursor:pointer}',
          '.ofmp-morepop button:hover{background:var(--dsw-alias-bg-layer-3,rgb(127 127 127/15%))}',
          '.ofmp-morepop button:disabled{opacity:.35;cursor:not-allowed}',
          '.ofmp-morepop .ofmp-pop-head{padding:2px 8px 4px;color:var(--dsw-alias-label-tertiary,#7d90ad);',
          '  font-size:11px;user-select:none}',
          '.ofmp-morepop .ofmp-row{display:flex;gap:4px;align-items:stretch}',
          '.ofmp-morepop .ofmp-row>button:first-child{flex:1;min-width:0}',
          '.ofmp-morepop .ofmp-row>[data-ofmp-hide]{flex:0 0 24px;width:24px;padding:6px 0;text-align:center;',
          '  color:var(--dsw-alias-label-tertiary,#7d90ad)}',
          '.ofmp-morepop .ofmp-row>[data-ofmp-hide]:hover{color:var(--dsw-alias-state-danger,rgb(224 112 112))}',
          '.ofmp-morepop .ofmp-collapse-all{margin-top:4px;padding-top:8px;',
          '  border-top:1px dashed var(--dsw-alias-border-l2,rgb(120 140 170/40%));',
          '  color:var(--dsw-alias-label-secondary,#9fb3d1)}',
          '.ofmp-morepop .ofmp-collapse-all:hover{color:var(--dsw-alias-label-primary,#dfe9f8)}',
        ].join('')
        document.head.appendChild(style)
      } catch { /* 样式失败折叠条仍可用（裸样式） */ }
    }
    /** 对单个根应用折叠：收集候选 → 深度优先防嵌套 → 挂条/恢复状态（幂等）。 */
    function applyFold(root) {
      if (!prefs.fold) return
      ensureFoldStyle()
      try {
        /* 候选 = tab 页一级子块（结构优先，≥120px 滤碎块；不依赖视口高度）
           + 大卡片面板（嵌套块仍按 380px 高度）。 */
        const candidates = new Set()
        for (const page of root.querySelectorAll(OFM_PAGE_SEL)) {
          for (const child of page.children) {
            /* 排除自身节点：折叠条（ofmp-bar）也是 page 子块，不排除会递归
               给上一轮的条再挂条（9999.11.3 真机实锤「▸ ▸ ▸」嵌套爆炸）。 */
            if (child.dataset.ofmpBar || child.dataset.ofmpMore || child.id === 'ofmp-panel') continue
            if (child.matches('div,section,aside,main,header') && !child.dataset.ofmpHidden
              && child.offsetHeight >= FOLD_PAGE_MIN) candidates.add(child)
          }
        }
        for (const panel of root.querySelectorAll(OFM_PANEL_SEL)) {
          if (!panel.dataset.ofmpHidden && !candidates.has(panel)
            && panel.offsetHeight >= FOLD_THRESHOLD) candidates.add(panel)
        }
        /* 祖先已在候选集 → 只折最外层（嵌套折叠是噪音）。 */
        for (const el of [...candidates]) {
          for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
            if (candidates.has(p)) { candidates.delete(el); break }
          }
        }
        for (const target of candidates) {
          if (target.dataset.ofmpTarget) continue // 已处理（React 重建后标记消失 → 重挂）
          /* 指纹：标题为主；同根内撞指纹加序号。 */
          let fp = hash(titleOf(target) || target.tagName)
          if (folds[`${fp}#1`] !== undefined || root.querySelector(`[data-ofmp-fp="${fp}#1"]`)) {
            let n = 1
            while (root.querySelector(`[data-ofmp-fp="${fp}#${n}"]`)) n++
            fp = `${fp}#${n}`
          }
          const bar = buildFoldBar(target, fp)
          bar.dataset.ofmpFp = fp
          target.dataset.ofmpTarget = fp
          target.before(bar)
          /* 折叠态决策：历史记忆优先；无记忆的新大块默认收起（9999.11.3，
             用户定案「先渲染折叠态才是正确的」——之前先全展开再收的跳变
             不符合预期）。用户展开过（folds[fp]=false）保持展开。 */
          const collapsedNow = folds[fp] === true || (prefs.collapseNew === true && !(fp in folds))
          if (collapsedNow) {
            target.style.display = 'none'
            folds[fp] = true
            foldsDirty = true
            bar.textContent = bar.textContent.replace('▾', '▸')
            bar.setAttribute('aria-expanded', 'true')
          }
        }
        /* 清孤儿：目标被 React 卸载而折叠条残留 → 移除。 */
        for (const bar of root.querySelectorAll('[data-ofmp-bar]')) {
          const tgt = bar.nextElementSibling
          if (!tgt || tgt.dataset.ofmpTarget !== bar.dataset.ofmpFp) bar.remove()
        }
      } catch { /* fail-open */ }
    }

    /* ── 4. tidy：nav 收纳（低频 tab 隐藏，保留名单可配）───────────────── */
    /** tab id 从按钮 id 提取（上游稳定形态 ofm-tab-<id>）。 */
    function tabIdOf(btn) {
      const m = /ofm-tab-([a-z0-9_-]+)$/i.exec(btn.id || '')
      return m ? m[1] : null
    }
    function applyTidy(root) {
      try {
        if (!prefs.tidy) { removeMoreButton(root); return }
        const keep = Array.isArray(prefs.keepTabs) ? prefs.keepTabs : []
        const hidden = []
        for (const btn of root.querySelectorAll('[role="tab"]')) {
          const id = tabIdOf(btn)
          if (!id || id === 'picks') continue // picks 归 ads 通道管
          if (btn.dataset.ofmpHidden === 'ad') continue
          if (!keep.includes(id)) {
            btn.style.display = 'none'
            btn.dataset.ofmpHidden = 'tidy'
            hidden.push(btn)
          } else if (btn.dataset.ofmpHidden === 'tidy') {
            btn.style.display = ''
            delete btn.dataset.ofmpHidden
          }
        }
        ensureVisibleTab(root)
        syncMoreButton(root, hidden)
      } catch { /* fail-open */ }
    }
    /** 「更多 ▾」入口：被收 tab 的唯一界面出口（用户实测「藏的哪里打开根本
        找不到」——右下角圆钮不够直观）。插在 tablist 末尾，React 冲掉由重扫
        重挂（data-ofmp-more 标记，与折叠条同机制）。 */
    function syncMoreButton(root, hiddenTabs) {
      try {
        const list = root.querySelector('[role="tablist"]')
        if (!list) return
        let more = list.querySelector('[data-ofmp-more]')
        /* v3.5：按钮常驻（tidy 开着就显示）。旧版「没有被藏 tab 就删按钮」是
           死锁：三轮实测里每次「更多」跳转都把该 tab 写进 keepTabs 落盘，13 个
           全跳完 → 全部保留 → 零隐藏 → 入口自动消失 → 想收起反而找不到任何
           入口（用户 9999.11.4 重启实测「收起根本找不到」真凶）。 */
        if (!more) {
          more = document.createElement('button')
          more.type = 'button'
          more.className = 'ofmp-more'
          more.dataset.ofmpMore = '1'
          more.setAttribute('aria-haspopup', 'menu')
          more.textContent = t('more')
          more.title = t('moreTitle')
          more.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            toggleMorePop(more, root)
          })
          list.appendChild(more)
        }
      } catch { /* fail-open */ }
    }
    function removeMoreButton(root) {
      try {
        closeMorePop()
        for (const m of root.querySelectorAll('[data-ofmp-more]')) m.remove()
      } catch { /* fail-open */ }
    }
    let morePop = null
    let popCloser = null
    function closeMorePop() {
      try { morePop?.remove() } catch { /* already gone */ }
      morePop = null
      if (popCloser) {
        try { document.removeEventListener('click', popCloser) } catch { /* already gone */ }
        popCloser = null
      }
    }
    function toggleMorePop(anchor, root) {
      try {
        if (morePop) { closeMorePop(); return }
        /* v3.4：列全部 tab（不只被藏的）——跳转过的 tab 已进保留名单并显示，
           旧版浮层只列 hidden 的，跳过就「从浮层消失、再也收不回」（用户实测
           「折叠的东西展开了就没法关闭，上面的目录」）。 */
        const tabs = [...root.querySelectorAll('[role="tab"]')].filter(b => {
          const id = tabIdOf(b)
          return b.isConnected && id && id !== 'picks' && b.dataset.ofmpHidden !== 'ad'
        })
        if (tabs.length === 0) return
        const keep = Array.isArray(prefs.keepTabs) ? prefs.keepTabs : []
        morePop = document.createElement('div')
        morePop.className = 'ofmp-morepop'
        morePop.dataset.plugin = NS
        const head = document.createElement('div')
        head.className = 'ofmp-pop-head'
        head.textContent = t('popHead')
        morePop.appendChild(head)
        for (const tab of tabs) {
          const id = tabIdOf(tab)
          const row = document.createElement('div')
          row.className = 'ofmp-row'
          const item = document.createElement('button')
          item.type = 'button'
          item.textContent = (tab.textContent || '').replace(/\s+/g, ' ').trim().replace(/\d+$/, '') || tab.id
          item.addEventListener('click', event => {
            event.stopPropagation()
            /* 跳转即加入保留名单：否则下一轮 tidy 重扫把它再次藏掉 → 激活 tab
               被藏 → ensureVisibleTab 又点回原 tab，永远进不去（真机推演实锤）。
               keepTabs 实时读 prefs 不用快照：同浮层会话内多次操作不互相回滚。 */
            const cur = Array.isArray(prefs.keepTabs) ? prefs.keepTabs : []
            if (id && !cur.includes(id)) { prefs.keepTabs = [...cur, id]; savePrefs() }
            tab.style.display = '' // 隐藏按钮的部分浏览器场景 click 可能被忽略，先亮出来
            tab.click()
            closeMorePop()
            scheduleScan('more-jump')
          })
          row.appendChild(item)
          if (keep.includes(id)) {
            const hide = document.createElement('button')
            hide.type = 'button'
            hide.dataset.ofmpHide = '1'
            hide.textContent = '✕'
            hide.title = t('hideTitle')
            hide.setAttribute('aria-label', t('hideAria', { name: item.textContent }))
            /* 最后一根保留 tab 不可收：全藏 = tab 栏无路可点，ensureVisibleTab
               无处可回，页面失去导航。 */
            if (keep.length <= 1) hide.disabled = true
            hide.addEventListener('click', event => {
              event.stopPropagation()
              const cur = Array.isArray(prefs.keepTabs) ? prefs.keepTabs : []
              if (cur.length <= 1) return
              prefs.keepTabs = cur.filter(x => x !== id)
              savePrefs()
              applyTidy(root)   // 立即生效：藏 tab / 激活被收时点回可见 / 刷新更多按钮
              hide.remove()     // 就地反馈，浮层保持打开可连续收多个
              scheduleScan('tab-collapse')
            })
            row.appendChild(hide)
          }
          morePop.appendChild(row)
        }
        const defKeep = DEFAULT_PREFS.keepTabs
        const extra = keep.filter(x => !defKeep.includes(x))
        if (extra.length > 0) {
          const all = document.createElement('button')
          all.type = 'button'
          all.className = 'ofmp-collapse-all'
          all.textContent = t('collapseAll')
          all.title = t('collapseAllTitle', { n: extra.length })
          all.addEventListener('click', event => {
            event.stopPropagation()
            prefs.keepTabs = [...defKeep]
            savePrefs()
            closeMorePop()
            applyTidy(root)
            scheduleScan('collapse-all')
          })
          morePop.appendChild(all)
        }
        document.body.appendChild(morePop)
        const r = anchor.getBoundingClientRect()
        morePop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 250))}px`
        morePop.style.top = `${r.bottom + 6}px`
        /* 浮层外点击关闭：命名监听，closeMorePop 统一摘除。旧版 once 监听有
           残留雷——浮层内按钮 stopPropagation 让 once 漏消耗，下次点「更多」
           开浮层时事件冒泡到 document 反被它关掉（浮层第二次点不开）。 */
        setTimeout(() => {
          popCloser = event => {
            if (morePop && event.target instanceof Node && morePop.contains(event.target)) return
            closeMorePop()
          }
          document.addEventListener('click', popCloser)
        })
      } catch { /* fail-open */ }
    }

    /* ── 控制面板（fixed 定位，不碰 React 树）──────────────────────────── */
    function buildControlPanel() {
      const existing = document.getElementById('ofmp-panel')
      if (existing) {
        if (existing.querySelector('#ofmp-cleanup-btn')) return
        existing.remove()
      }
      try {
        const wrap = document.createElement('div')
        wrap.id = 'ofmp-panel'
        wrap.dataset.plugin = NS
        wrap.innerHTML = [
          `<button id="ofmp-dot" type="button" title="${t('dotTitle')}" aria-label="ofm-patch">${t('dot')}</button>`,
          '<div id="ofmp-pop" hidden>',
          `  <div class="ofmp-pop-title" data-ofmp-i18n="panelTitle">${t('panelTitle')}</div>`,
          `  <label><input type="checkbox" data-ofmp-pref="fold"> <span data-ofmp-i18n="fold">${t('fold')}</span></label>`,
          `  <label><input type="checkbox" data-ofmp-pref="motion"> <span data-ofmp-i18n="motion">${t('motion')}</span></label>`,
          `  <label><input type="checkbox" data-ofmp-pref="ads"> <span data-ofmp-i18n="ads">${t('ads')}</span></label>`,
          `  <label><input type="checkbox" data-ofmp-pref="tidy"> <span data-ofmp-i18n="tidy">${t('tidy')}</span></label>`,
          `  <label><input type="checkbox" data-ofmp-pref="collapseNew"> <span data-ofmp-i18n="collapseNew">${t('collapseNew')}</span></label>`,
          `  <div class="ofmp-pop-sub" data-ofmp-i18n="keepSub">${t('keepSub')}</div>`,
          '  <div id="ofmp-tablist"></div>',
          '  <div class="ofmp-pop-sub" data-ofmp-i18n="zenTitle"></div>',
          '  <label><input type="checkbox" data-ofmp-zen> <span data-ofmp-i18n="zenEnable"></span></label>',
          '  <div id="ofmp-zen-status" class="ofmp-hint"></div>',
          '  <div class="ofmp-pop-sub" data-ofmp-i18n="cleanupTitle"></div>',
          '  <div id="ofmp-cleanup-status" class="ofmp-hint"></div>',
          '  <button id="ofmp-cleanup-btn" type="button" hidden></button>',
          '</div>',
        ].join('')
        const dot = wrap.querySelector('#ofmp-dot')
        const pop = wrap.querySelector('#ofmp-pop')
        dot.addEventListener('click', event => {
          event.stopPropagation()
          pop.hidden = !pop.hidden
          if (!pop.hidden) { refreshPanelTexts(); renderTabList(); renderZenStatus(); refreshCleanupPreview() }
        })
        document.addEventListener('click', event => {
          if (!pop.hidden && !pop.contains(event.target)) pop.hidden = true
        })
        for (const input of wrap.querySelectorAll('[data-ofmp-pref]')) {
          const key = input.dataset.ofmpPref
          input.checked = prefs[key] === true
          input.addEventListener('change', () => {
            prefs[key] = input.checked
            savePrefs()
            if (!input.checked && key === 'motion') applyMotion() // 关掉即移除 CSS
            scheduleScan('pref-changed')
          })
        }
        /* v4 · zen 账号车道开关：状态存宿主侧 zen-lane.json（非 localStorage），
           面板打开时拉取实况；切换 POST 给宿主路由，宿主完成 save/remove+discover。 */
        const zenBox = wrap.querySelector('[data-ofmp-zen]')
        if (zenBox) {
          zenBox.addEventListener('change', async () => {
            const want = zenBox.checked
            zenBox.disabled = true
            renderZenStatus(t('zenBusy'))
            try {
              const res = await fetch('/api/our-free-model-patch/zen-lane', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: want }),
                signal: AbortSignal.timeout(30_000),
              })
              const body = await res.json().catch(() => null)
              renderZenStatus(null, body)
            } catch (e) {
              renderZenStatus(String(e?.message ?? e))
            } finally {
              zenBox.disabled = false
            }
          })
        }
        /* v5 · zen-cleanup 清理按钮：GET 先预览 matched/total（绝不删），POST
           {dryRun:false} 才真删——只删 opencode 侧 ofm-patch 建的 ses_（agent
           名单过滤），DSH 对话历史原封不动。删除可能逐个排队（批量 4 并发），
           会话多时要等，超时放宽到 180s。 */
        const cleanupBtn = wrap.querySelector('#ofmp-cleanup-btn')
        cleanupBtn.addEventListener('click', async () => {
          const n = cleanupMatched ?? 0
          if (n <= 0 || !confirm(t('cleanupConfirm', { n }))) return
          cleanupBtn.disabled = true
          renderCleanupStatus(t('cleanupBusy'))
          try {
            const res = await fetch('/api/our-free-model-patch/zen-gateway/zen-cleanup', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dryRun: false }),
              signal: AbortSignal.timeout(180_000),
            })
            const body = await res.json().catch(() => null)
            if (!body || body.ok !== true) { renderCleanupStatus(`⚠ ${body?.reason ?? t('cleanupFail')}`); return }
            renderCleanupStatus(t('cleanupDone', { deleted: body.deleted ?? 0, failed: Array.isArray(body.failed) ? body.failed.length : (body.failed ?? 0) }))
          } catch (e) {
            renderCleanupStatus(`⚠ ${String(e?.message ?? e)}`)
          } finally {
            refreshCleanupPreview({ updateBox: false }) // 保留结果文案，只刷新按钮与计数
          }
        })
        const style = document.createElement('style')
        style.dataset.plugin = NS
        style.textContent = [
          '#ofmp-panel{position:fixed;right:18px;bottom:18px;z-index:99999;font:12px/1.4 system-ui,sans-serif}',
          '#ofmp-dot{width:30px;height:30px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgb(120 140 170/45%));',
          '  background:var(--dsw-alias-bg-layer-2,rgb(24 32 48/85%));color:var(--dsw-alias-label-secondary,#9fb3d1);',
          '  cursor:pointer;opacity:.55;transition:opacity .15s}',
          '#ofmp-dot:hover{opacity:1}',
          '#ofmp-pop{position:absolute;right:0;bottom:38px;min-width:200px;max-height:70vh;overflow:auto;padding:10px 12px;border-radius:12px;',
          '  border:1px solid var(--dsw-alias-border-l2,rgb(120 140 170/45%));',
          '  background:var(--dsw-alias-bg-layer-2,rgb(20 28 44/96%));color:var(--dsw-alias-label-primary,#dfe9f8);',
          '  box-shadow:0 8px 24px rgb(0 0 0/30%)}',
          '#ofmp-pop .ofmp-pop-title{font-weight:700;margin-bottom:6px}',
          '#ofmp-pop .ofmp-pop-sub{margin:8px 0 2px;color:var(--dsw-alias-label-secondary,#9fb3d1)}',
          '#ofmp-pop label{display:flex;gap:6px;align-items:center;padding:2px 0;cursor:pointer;user-select:none}',
          '#ofmp-tablist{max-height:180px;overflow:auto}',
          '#ofmp-tablist .ofmp-hint{color:var(--dsw-alias-label-tertiary,#7d90ad);padding:2px 0}',
          '#ofmp-cleanup-btn{margin-top:4px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgb(120 140 170/45%));',
          '  background:transparent;color:var(--dsw-alias-label-primary,#dfe9f8);cursor:pointer}',
          '#ofmp-cleanup-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-danger,rgb(224 112 112));color:var(--dsw-alias-state-danger,rgb(224 112 112))}',
          '#ofmp-cleanup-btn:disabled{opacity:.4;cursor:not-allowed}',
        ].join('')
        document.head.appendChild(style)
        document.body.appendChild(wrap)
      } catch { /* 面板挂不上不影响四件套 */ }
    }
    /** v4 · zen 车道状态行：面板打开/切换后刷新（GET 宿主路由拿实况）。 */
    function renderZenStatus(busyText, resultBody) {
      try {
        const box = document.getElementById('ofmp-zen-status')
        if (!box) return
        if (busyText) { box.textContent = busyText; return }
        fetch('/api/our-free-model-patch/zen-lane', { signal: AbortSignal.timeout(10_000) })
          .then(r => r.json())
          .then(body => {
            const st = body?.state ?? {}
            const zenBox = document.querySelector('[data-ofmp-zen]')
            if (zenBox) zenBox.checked = st.enabled === true
            if (st.enabled !== true) {
              box.textContent = body?.ok === false && st.lastError ? `${t('zenOff')} · ${st.lastError}` : t('zenOff')
              return
            }
            if (body?.live && body.live.enabled !== true) { box.textContent = `${t('zenBusy')}` ; return }
            const days = st.tokenExpires ? Math.max(0, Math.round((st.tokenExpires - Date.now()) / 86_400_000)) : null
            const until = st.tokenExpires ? new Date(st.tokenExpires).toISOString().slice(0, 10) : '?'
            const parts = [`${st.modelCount ?? '?'} models`]
            if (days !== null) parts.push(`token→${until} (${days}d)`)
            if (st.lastSyncAt) parts.push(`sync ${new Date(st.lastSyncAt).toLocaleTimeString()}`)
            box.textContent = (st.lastError ? `⚠ ${st.lastError}` : '✓') + ' ' + parts.join(' · ')
          })
          .catch(e => { box.textContent = String(e?.message ?? e) })
        if (resultBody?.state) { /* POST 返回已带状态：先呈现，GET 随后校准 */ }
      } catch { /* fail-open */ }
    }

    /* ── zen-cleanup 清理（2026-11-24）：预览走 GET（dry-run 零副作用），删除走 POST ── */
    let cleanupMatched = null
    function renderCleanupStatus(text) {
      try { const box = document.getElementById('ofmp-cleanup-status'); if (box) box.textContent = text } catch { /* fail-open */ }
    }
    /** 预览可清理数：GET 网关 zen-cleanup（服务端 dry-run，绝不删）。
        updateBox=false 时只刷新按钮与计数（删除完成后保留结果文案用）。 */
    async function refreshCleanupPreview({ updateBox = true } = {}) {
      const btn = document.getElementById('ofmp-cleanup-btn')
      try {
        const res = await fetch('/api/our-free-model-patch/zen-gateway/zen-cleanup', { signal: AbortSignal.timeout(20_000) })
        const body = await res.json().catch(() => null)
        if (!body || body.ok !== true) {
          if (updateBox) renderCleanupStatus(`⚠ ${body?.reason ?? t('cleanupFail')}`)
          if (btn) btn.hidden = true
          return
        }
        cleanupMatched = body.matched ?? 0
        if (btn) {
          btn.hidden = false
          btn.textContent = t('cleanupButton', { n: cleanupMatched })
          btn.disabled = cleanupMatched === 0
        }
        if (updateBox) renderCleanupStatus(t('cleanupPreview', { n: cleanupMatched, total: body.total ?? '?' }))
      } catch (e) {
        if (updateBox) renderCleanupStatus(`⚠ ${String(e?.message ?? e)}`)
        if (btn) btn.hidden = true
      }
    }

    /** 面板文案随宿主语言刷新：每次打开面板时重写带 data-ofmp-i18n 标记的
        文本节点与圆钮（宿主 locale.bind 现取；语言切换无需重建 checkbox）。 */
    function refreshPanelTexts() {
      try {
        const panel = document.getElementById('ofmp-panel')
        if (!panel) return
        for (const el of panel.querySelectorAll('[data-ofmp-i18n]')) {
          const txt = t(el.dataset.ofmpI18n)
          if (el.textContent !== txt) el.textContent = txt
        }
        const dot = panel.querySelector('#ofmp-dot')
        if (dot) { dot.textContent = t('dot'); dot.title = t('dotTitle') }
      } catch { /* fail-open */ }
    }
    /** tab 勾选列表：打开面板时从 DOM 采集（OFM 未渲染则提示）。 */
    function renderTabList() {
      try {
        const list = document.getElementById('ofmp-tablist')
        if (!list) return
        const roots = ofmRoots()
        const tabs = roots.length ? [...roots[0].querySelectorAll('[role="tab"]')] : []
        const seen = new Set()
        const entries = []
        for (const b of tabs) {
          const id = tabIdOf(b)
          if (!id || id === 'picks' || seen.has(id)) continue
          seen.add(id)
          entries.push({ id, label: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14) })
        }
        list.textContent = ''
        if (entries.length === 0) {
          const hint = document.createElement('div')
          hint.className = 'ofmp-hint'
          hint.textContent = t('tabListHint')
          list.appendChild(hint)
          return
        }
        for (const e of entries) {
          const label = document.createElement('label')
          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.checked = (prefs.keepTabs || []).includes(e.id)
          cb.addEventListener('change', () => {
            const set = new Set(prefs.keepTabs || [])
            if (cb.checked) set.add(e.id); else set.delete(e.id)
            prefs.keepTabs = [...set]
            savePrefs()
            scheduleScan('tabs-changed')
          })
          label.appendChild(cb)
          label.appendChild(document.createTextNode(e.label))
          list.appendChild(label)
        }
      } catch { /* fail-open */ }
    }

    /* ── 扫描编排 ──────────────────────────────────────────────────────── */
    let scanTimer = null
    let observer = null
    function scheduleScan(tag) {
      clearTimeout(scanTimer)
      scanTimer = setTimeout(() => { scan(tag) }, 80) // 80ms：肉眼基本无感的重放延迟
    }
    function scan(tag) {
      try {
        applyMotion()
        const roots = ofmRoots()
        for (const root of roots) {
          applyAds(root)
          applyTidy(root)
          applyFold(root)
        }
      } catch { /* 单轮失败等下一轮 */ }
    }
    /** 只对我们自己的节点变化短路，其余防抖重扫；广告类同步即时隐藏（防闪现）。 */
    function isOwnMutation(m) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.dataset && (node.dataset.ofmpBar || node.dataset.plugin === NS || node.id === 'ofmp-panel')) continue
        } else if (node.nodeType === 3) continue
        return false
      }
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && node.dataset && (node.dataset.ofmpBar || node.id === 'ofmp-panel')) continue
        if (node.nodeType === 3) continue
        return false
      }
      return true
    }
    function startObserver() {
      /* 热重载防护：模块重载产生新实例时，旧 observer 仍活着（闭包未断），
         用 window 级标记防双 observer 双扫描（幂等但浪费）。 */
      if (window.__ofmpObserverAlive) return
      let lastSync = 0
      observer = new MutationObserver(muts => {
        /* 即时广告隐藏：不等防抖（v3.0 防抖 500ms = 「打开闪现处理前画面」）。 */
        let sawAd = false
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.matches?.('[class*="sponsor"],aside') || node.querySelector?.('a[href*="beichenapi"],a[href*="?aff="],a[href*="&aff="]')) {
              hideAdIn(node)
              sawAd = true
            }
          }
        }
        const own = muts.every(isOwnMutation)
        if (own && !sawAd) return
        /* 同步轻扫（9999.11.3，用户定案「先渲染折叠态才是正确的」）：mutation
           回调运行在浏览器 paint 之前的微任务阶段，此时挂条/收块=用户看到的
           首帧就是折叠态，消除「先全展开再跳到折叠」的闪变。30ms 节流防风暴，
           80ms 防抖完整扫描仍兜底。 */
        const now = Date.now()
        if (now - lastSync > 30) {
          lastSync = now
          try { scan('sync') } catch { /* 同步轮失败等防抖轮 */ }
        }
        scheduleScan('mutation')
      })
      observer.observe(document.body, { childList: true, subtree: true })
      window.__ofmpObserverAlive = true
    }

    /* ── 入口 ──────────────────────────────────────────────────────────── */
    function apply(ctx) {
      /* i18n：注册宿主 browser 侧 locale（zh/en 字典 + bind 现取，同
         adapter-compat 先例）；宿主 locale 缺席时保持探测回落，绝不抛错。 */
      try {
        if (ctx && ctx.effect && ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
          const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
          if (bound) {
            t = (key, vars) => {
              let out = bound(key) || detectDict()[key] || ZH[key] || key
              if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
              return out
            }
          }
        }
      } catch { /* locale 缺席回落探测语言 */ }
      try {
        buildControlPanel()
        applyMotion() // 兜底 CSS 立即注入（.ofm_root 前缀），首帧即砍动画
        startObserver()
        scan('boot') // 立即首扫（OFM 已渲染则当场应用）
        setTimeout(() => scan('boot-soon'), 300)
        setTimeout(() => scan('boot-late'), 1500)
      } catch { /* fail-open：任何失败不影响宿主页面 */ }
    }

    exports.name = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
