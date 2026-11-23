/* Claude Context Studio 前端（v2）：仿 Claude 侧栏的分区布局。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const CAPS = [128000, 200000, 1000000];
  const WARN_PCT = 60;
  const DANGER_PCT = 80;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  const state = {
    selectedConvId: '',
    workspaceUris: [],
    etag: '',
    snap: null,
    capacity: Number(store.get('cs.capacity', '1000000')) || 1000000,
    expanded: new Set(),
    tlFilter: 'all',
    tlLimit: 12,
    connLimit: 5,
    outTab: 'docs',
    doc: null, // 正在预览的文档 { path, mode }
    outLimit: 5,
    kbOpen: false,
    editingRule: null,
    previewTarget: null,
    previewText: '',
    timer: null,
    lastHtml: new Map(),
  };

  // ---------- 主题 ----------
  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #faf9f7)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const n = (c.match(/[\d.]+/g) || []).map(Number);
    if (n.length < 3) return;
    const s = c.startsWith('color(') ? 1 : 255;
    const lum = 0.2126 * (n[0] / s) + 0.7152 * (n[1] / s) + 0.0722 * (n[2] / s);
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------- 工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmtTok = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(v);
  };
  const fmtCap = (n) => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}k`);
  const fmtBytes = (b) => (b < 0 ? '已删除' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const ago = (iso) => {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  };

  const ICON = {
    folder: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
    model: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.5" y="3.5" width="9" height="9" rx="2"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
    file: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.5h5L12.5 5v9.5h-8.5z"/><path d="M9 1.5V5h3.5"/></svg>',
    code: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>',
    doc: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M5.5 7.5h5M5.5 10h5"/></svg>',
    image: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m2.5 12 3.5-3.5 3 3 2-2 2.5 2.5"/></svg>',
    plug: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 1.5V5M10 1.5V5M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5v3"/></svg>',
    warn: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.4v.1"/></svg>',
  };

  function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return ICON.image;
    if (['md', 'txt', 'markdown', 'rst', 'docx', 'pdf'].includes(ext)) return ICON.doc;
    if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'vue', 'html', 'css', 'json', 'sh', 'ps1', 'sql', 'yml', 'yaml'].includes(ext)) return ICON.code;
    return ICON.file;
  }

  /** 只有内容变化才写 DOM，避免闪烁和滚动跳动。 */
  function setHtml(id, html) {
    if (state.lastHtml.get(id) === html) return;
    state.lastHtml.set(id, html);
    $(id).innerHTML = html;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  async function copy(text, label = '已复制') {
    try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('复制失败'); }
  }

  const sfetch = (...a) => (window.sidecar?.fetch ? window.sidecar.fetch(...a) : fetch(...a));
  async function apiGet(path) {
    const r = await sfetch(path, { method: 'GET' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function apiPost(path, body) {
    const r = await sfetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  const hostConvId = () => window.sidecar?.conversationId || new URLSearchParams(location.search).get('conversationId') || '';
  const actionConv = () => state.selectedConvId || hostConvId() || state.snap?.conversationId || '';

  async function sendToAgent(text, okMsg) {
    const conv = actionConv();
    if (!window.sidecar?.agent?.sendMessage || !conv) return toast('没有连接到会话');
    try { await window.sidecar.agent.sendMessage(text, conv); toast(okMsg); } catch (e) { toast(`发送失败：${e.message}`); }
  }

  function openFile(uri) {
    if (window.sidecar?.ui?.toggleAuxPane && uri) window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
    else toast('当前环境不支持在侧栏打开');
  }

  // ---------- 顶栏 ----------
  function renderTop() {
    const s = state.snap;
    const pill = $('status-badge');
    const working = s.status === 'working';
    pill.className = `status-pill ${working ? 'working' : 'idle'}`;
    $('status-text').textContent = working ? '运行中' : '空闲';

    const opts = [`<option value="">⚡ 跟随当前会话 · ${esc(s.title || '')}</option>`]
      .concat((s.recentConversations || []).map((c) => `<option value="${esc(c.id)}">${esc(c.title || c.id.slice(0, 8))}</option>`));
    const html = opts.join('');
    if (state.lastHtml.get('conv-select') !== html) {
      state.lastHtml.set('conv-select', html);
      $('conv-select').innerHTML = html;
    }
    $('conv-select').value = state.selectedConvId;
  }

  // ---------- 环境 ----------
  function renderEnv() {
    const e = state.snap.environment || {};
    const rows = [];
    if (e.workspaces?.length) {
      for (const w of e.workspaces) {
        rows.push(`<button type="button" class="row" data-copy="${esc(w.path)}" title="${esc(w.path)}（点击复制路径）"><span class="ico">${ICON.folder}</span><span class="name">${esc(w.name)}</span><span class="val">工作区</span></button>`);
      }
    } else {
      rows.push(`<div class="row"><span class="ico">${ICON.folder}</span><span class="name muted">未打开工作区</span></div>`);
    }
    if (e.model) rows.push(`<div class="row"><span class="ico">${ICON.model}</span><span class="name">${esc(e.model)}</span><span class="val">模型</span></div>`);
    rows.push(`<div class="row"><span class="ico">${ICON.clock}</span><span class="name">${e.turns || 0} 轮对话 · ${e.steps || 0} 步</span><span class="val">${esc(ago(e.lastActivityAt))}</span></div>`);
    if (e.failures) rows.push(`<button type="button" class="row" data-goto-fail="1"><span class="ico" style="color:var(--cs-fail)">${ICON.warn}</span><span class="name">${e.failures} 次失败（命令报错 / 请求出错）</span><span class="val">查看</span></button>`);
    setHtml('env-list', rows.join(''));
  }

  // ---------- 电脑操控 ----------
  function renderComputerUse() {
    const cu = state.snap.computerUse || {};
    const rows = [];
    if (!cu.installed) {
      rows.push(`<button type="button" class="row" data-copy="uv tool install windows-mcp --python 3.14" title="点击复制安装命令"><span class="ico dot-off">●</span><span class="name">未安装 Windows-MCP</span><span class="val">复制安装命令</span></button>`);
    } else if (!cu.connected) {
      rows.push(`<div class="row"><span class="ico dot-off">●</span><span class="name">已安装${cu.version ? ` ${esc(cu.version)}` : ''}，尚未连接</span><span class="val">新开会话后自动连接</span></div>`);
    } else {
      rows.push(`<div class="row"><span class="ico dot-ok">●</span><span class="name">已连接 · ${cu.tools} 个工具</span><span class="val">Windows-MCP ${esc(cu.version || '')}</span></div>`);
    }
    rows.push(`<div class="row"><span class="ico">${ICON.model}</span><span class="name">本会话桌面操作 ${cu.actions || 0} 次</span><span class="val">${cu.lastActionAt ? esc(ago(cu.lastActionAt)) : ''}</span></div>`);
    setHtml('cu-rows', rows.join(''));

    const shot = cu.lastShot;
    const fig = $('cu-shot');
    if (!shot) { fig.classList.add('hidden'); state.lastHtml.delete('cu-shot'); return; }
    fig.classList.remove('hidden');
    fig.dataset.open = shot.uri;
    setHtml('cu-shot', `<img src="/api/image?path=${encodeURIComponent(shot.path)}" alt="Agent 最近看到的画面" loading="lazy">
      <figcaption>Agent 最近看到的画面 · ${esc(shot.source)} · ${esc(fmtTime(shot.at))}（点击放大）</figcaption>`);
  }

  // ---------- 上下文 ----------
  const PART_COLOR = { messages: 'var(--cs-c-messages)', system: 'var(--cs-c-system)', mcp: 'var(--cs-c-mcp)', rules: 'var(--cs-c-rules)', skills: 'var(--cs-c-skills)' };

  function renderContext() {
    const s = state.snap;
    const bd = s.breakdown || { current: 0, parts: [] };
    const cap = state.capacity;
    const used = bd.current;
    const pct = cap ? (used / cap) * 100 : 0;
    $('ctx-used').textContent = pct > 100
      ? `已超出所选窗口（${Math.round(pct)}%），点右侧切换窗口大小`
      : `已使用 ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
    $('ctx-cap').textContent = `${fmtTok(used)} / ${fmtCap(cap)}`;

    const bar = bd.parts
      .filter((p) => p.tokens > 0)
      .map((p) => `<span style="width:${Math.min(100, (p.tokens / cap) * 100).toFixed(3)}%;background:${PART_COLOR[p.key]}" title="${esc(p.label)} ${fmtTok(p.tokens)}"></span>`)
      .join('');
    setHtml('ctx-bar', bar);

    const free = Math.max(0, cap - used);
    const rowHtml = (p) => {
      const exp = p.expandable;
      const open = exp && state.expanded.has(exp);
      const row = `<button type="button" class="ctx-row ${exp ? 'expandable' : ''}" ${exp ? `data-expand="${exp}"` : 'tabindex="-1"'}>
        <span class="sq" style="background:${PART_COLOR[p.key] || 'var(--cs-c-free)'}"></span>
        <span class="lbl">${esc(p.label)}</span>
        <span class="tok">${fmtTok(p.tokens)}</span>
        <span class="pct">${((p.tokens / cap) * 100).toFixed(1)}%</span></button>`;
      return row + (open ? renderDetail(exp) : '');
    };
    const freeRow = `<div class="ctx-row"><span class="sq" style="background:var(--cs-c-free)"></span><span class="lbl">剩余空间</span><span class="tok">${fmtTok(free)}</span><span class="pct">${((free / cap) * 100).toFixed(1)}%</span></div>`;
    setHtml('ctx-rows', bd.parts.map(rowHtml).join('') + freeRow);

    const t = s.tokens || {};
    const ctxNow = (t.latestInput || 0) + (t.latestCache || 0);
    const hit = ctxNow ? Math.round(((t.latestCache || 0) / ctxNow) * 100) : 0;
    setHtml('ctx-foot', `<span>缓存命中 ${hit}%</span><span>本会话累计输出 ${fmtTok(t.totalOutput)}</span><span title="规则、技能、MCP 按文件大小估算，对话消息为实际值减去首轮">分类为估算</span>`);

    renderWarning(pct);
  }

  function renderDetail(kind) {
    const s = state.snap;
    let items = [];
    if (kind === 'mcp') items = (s.connectors || []).filter((c) => c.status === 'connected').map((c) => [`${c.name} · ${c.tools} 个工具`, fmtTok(c.tokens)]);
    if (kind === 'rules') items = (s.rules || []).filter((r) => r.exists).map((r) => [r.label, fmtTok(r.tokens)]);
    if (kind === 'skills') items = (s.skills || []).filter((k) => !k.disabled).sort((a, b) => b.tokens - a.tokens).map((k) => [`${k.name} · ${k.source}`, fmtTok(k.tokens)]);
    if (!items.length) return '<div class="ctx-detail"><div class="d"><span>无</span></div></div>';
    return `<div class="ctx-detail">${items.map(([a, b]) => `<div class="d"><span title="${esc(a)}">${esc(a)}</span><span>${b}</span></div>`).join('')}</div>`;
  }

  function renderWarning(pct) {
    const el = $('ctx-warn');
    const level = pct >= DANGER_PCT ? 'danger' : pct >= WARN_PCT ? 'warn' : '';
    const dismissKey = `cs.dismiss.${state.snap.conversationId}.${level}`;
    if (!level || store.get(dismissKey, '') === '1') { el.classList.add('hidden'); state.lastHtml.delete('ctx-warn'); return; }
    el.classList.remove('hidden');
    el.classList.toggle('danger', level === 'danger');
    const msg = level === 'danger'
      ? `上下文已用 ${Math.round(pct)}%，模型很快会开始遗忘前面的内容或被强制压缩。建议现在交接到新会话。`
      : `上下文已用 ${Math.round(pct)}%。对话再长下去，Agent 容易忘记早期决定；可以考虑交接到新会话。`;
    setHtml('ctx-warn', `<div>${esc(msg)}</div><div class="warn-actions">
      <button type="button" class="primary-btn" data-act="handoff">让 Agent 写交接文件</button>
      <button type="button" class="ghost-btn" data-act="newconv">开新会话接着做</button>
      <button type="button" class="ghost-btn" data-act="dismiss" data-key="${esc(dismissKey)}">先不用</button></div>`);
  }

  // ---------- 执行轨迹 ----------
  const ST_MARK = { ok: '✓', fail: '✕', running: '◷', pending: '·' };

  function renderTimeline() {
    const tl = state.snap.timeline || [];
    let fails = 0;
    for (const x of tl) if (x.kind === 'error' || (x.kind === 'model' && x.actions.some((a) => a.status === 'fail'))) fails += 1;
    $('fail-count').textContent = fails ? String(fails) : '';

    let items = tl;
    if (state.tlFilter === 'fail') {
      items = tl.filter((x) => x.kind === 'error' || (x.kind === 'model' && x.actions.some((a) => a.status === 'fail')));
    }
    const shown = items.slice(0, state.tlLimit);
    $('tl-more').classList.toggle('hidden', items.length <= state.tlLimit);

    if (!shown.length) {
      setHtml('timeline', `<div class="empty">${state.tlFilter === 'fail' ? '没有失败的步骤 👍' : '暂无执行记录'}</div>`);
      return;
    }
    const html = shown.map((x) => {
      if (x.kind === 'user') return `<div class="tl-user"><span class="t">${esc(fmtTime(x.at))}</span>你：${esc(x.text)}</div>`;
      if (x.kind === 'error') return `<div class="tl-error">请求出错：${esc(x.text)}</div>`;
      // 同一步里连续相同的动作（如连改 7 次 hud.css）合并成一行 ×N
      const merged = [];
      for (const a of (state.tlFilter === 'fail' ? x.actions.filter((y) => y.status === 'fail') : x.actions)) {
        const last = merged[merged.length - 1];
        if (last && last.verb === a.verb && last.target === a.target && last.status === a.status && !a.detail) last.n += 1;
        else merged.push({ ...a, n: 1 });
      }
      const acts = merged.map((a) => `
        <div class="act ${a.status}"><span class="st ${a.status}">${ST_MARK[a.status] || '·'}</span><span class="verb">${esc(a.verb)}</span><span class="tgt" title="${esc(a.target)}">${esc(a.target)}</span>${a.n > 1 ? `<span class="verb">×${a.n}</span>` : ''}${a.detail ? `<span class="det">${esc(a.detail)}</span>` : ''}</div>`).join('');
      const thought = x.thought ? `<div class="tl-thought" title="${esc(x.thought)}"><span class="t">${esc(fmtTime(x.at))}</span>${esc(x.thought)}</div>` : '';
      const reply = x.reply ? `<div class="tl-reply">${esc(x.reply)}</div>` : '';
      if (!acts && !reply && !thought) return '';
      return `<div class="tl-step">${thought}${acts}${reply}</div>`;
    }).join('');
    setHtml('timeline', html);
  }

  // ---------- 连接器 ----------
  function renderConnectors() {
    const list = state.snap.connectors || [];
    const shown = list.slice(0, state.connLimit);
    $('conn-more').classList.toggle('hidden', list.length <= state.connLimit);
    const label = { connected: ['已连接', 'ok'], disabled: ['已停用', 'off'], configured: ['未连接', 'warn'] };
    setHtml('connectors', shown.length ? shown.map((c) => {
      const [txt, cls] = label[c.status] || ['', ''];
      const tools = c.tools ? ` · ${c.tools} 个工具` : '';
      return `<div class="row" title="${esc(c.source || '')}"><span class="ico">${ICON.plug}</span><span class="name">${esc(c.name)}<span class="muted">${esc(tools)}</span></span><span class="val ${cls}">${txt}</span></div>`;
    }).join('') : '<div class="empty">没有配置 MCP 连接器</div>');
  }

  // ---------- 输出内容 ----------
  function renderOutputs() {
    const o = state.snap.outputs || { docs: [], files: [], artifacts: [] };
    const list = (state.outTab === 'docs' ? o.docs : state.outTab === 'files' ? o.files : o.artifacts) || [];
    const shown = list.slice(0, state.outLimit);
    $('out-more').classList.toggle('hidden', list.length <= state.outLimit);
    if (!shown.length) {
      const emptyText = { docs: '本会话还没有出现 Word / Excel / PPT / PDF 文档', files: '本会话还没有修改工作区文件', artifacts: '本会话还没有生成产物' }[state.outTab];
      setHtml('outputs', `<div class="empty">${emptyText}</div>`);
      return;
    }
    setHtml('outputs', shown.map((f) => {
      const meta = state.outTab === 'files' ? (f.exists ? `改了 ${f.count} 次` : '已删除') : state.outTab === 'docs' ? `${fmtBytes(f.size)} · ${ago(new Date(f.mtime).toISOString())}` : fmtBytes(f.size);
      if (DOC_RE.test(f.path)) {
        return `<div class="row clickable" data-doc="${esc(f.path)}" title="${esc(f.path)}（点击预览）">
        <span class="ico">${ICON.doc}</span><span class="name">${esc(f.label || f.name)}</span>
        <span class="acts"><button type="button" class="mini-btn" data-external="${esc(f.path)}">用 Word 打开</button><button type="button" class="mini-btn" data-copy="${esc(f.path)}">复制路径</button></span>
        <span class="val">${esc(meta)}</span></div>`;
      }
      return `<div class="row clickable" data-open="${esc(f.uri)}" title="${esc(f.path)}">
        <span class="ico">${fileIcon(f.name)}</span><span class="name">${esc(f.label || f.name)}</span>
        <span class="acts"><button type="button" class="mini-btn" data-preview="${esc(f.path)}" data-uri="${esc(f.uri)}" data-name="${esc(f.name)}">预览</button><button type="button" class="mini-btn" data-copy="${esc(f.path)}">复制路径</button></span>
        <span class="val">${esc(meta)}</span></div>`;
    }).join(''));
  }

  // ---------- 文档预览 ----------
  const DOC_RE = /\.(docx|docm|xlsx|xlsm|pptx|pptm|pdf)$/i;
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  function docStatus(text, isErr = false) {
    const el = $('docview-status');
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('err', isErr);
  }

  // 文档内容放进 Shadow DOM：样式互不干扰，不依赖 iframe（反重力的侧栏可能拦截嵌套页面）
  function docRoot() {
    const host = $('docview-body');
    if (!host.shadowRoot) {
      const root = host.attachShadow({ mode: 'open' });
      // Excel 多工作表切换（文档里的脚本不会执行，这里统一处理）
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
        root.querySelectorAll('[data-sheet]').forEach((s) => s.classList.toggle('hidden', s.dataset.sheet !== b.dataset.tab));
      });
    }
    return host.shadowRoot;
  }

  /** 解析返回的整页 HTML：去掉脚本、事件属性和 javascript: 链接，样式里的 body 改成作用于容器。 */
  function mountHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, link[rel="import"], meta').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        else if (/^(href|src|xlink:href|action)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
    });
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      .replace(/(^|[\s,}])(?:html|body)(?=[\s,{.:#[])/g, '$1.docroot').replace(/:root\b/g, ':host');
    doc.querySelectorAll('style').forEach((s) => s.remove());
    docRoot().innerHTML = `<style>.docroot{min-height:100%}${css}</style><div class="docroot">${doc.body.innerHTML}</div>`;
    $('docview-body').scrollTop = 0;
  }

  async function fetchText(url) {
    const r = await sfetch(url, { method: 'GET' });
    const text = await r.text();
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = JSON.parse(text).error || msg; } catch {}
      throw new Error(msg);
    }
    return text;
  }

  async function loadDoc() {
    const d = state.doc;
    if (!d) return;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === d.mode));
    $('docview-modes').classList.toggle('hidden', !/\.(docx|docm)$/i.test(d.path));
    const bust = Date.now();
    if (/\.pdf$/i.test(d.path)) {
      docRoot().innerHTML = '';
      docStatus('PDF 暂不支持在面板里预览，请点右上角"打开"用默认程序查看。');
      return;
    }
    try {
      if (d.mode === 'hifi') {
        docStatus('正在用 Word 渲染……第一次大约需要 5～15 秒，之后直接用缓存。');
        const r = await apiPost('/api/doc-hifi', { path: d.path });
        if (state.doc !== d) return;
        mountHtml(await fetchText(`${r.url}&t=${bust}`));
      } else {
        docStatus('正在加载……');
        const html = await fetchText(`/api/doc?path=${encodeURIComponent(d.path)}&t=${bust}`);
        if (state.doc !== d) return;
        mountHtml(html);
      }
      docStatus('');
    } catch (err) {
      if (state.doc !== d) return;
      if (d.mode === 'hifi') {
        docStatus(`高保真渲染失败：${err.message}。已切回快速模式。`, true);
        d.mode = 'fast';
        loadDoc();
      } else {
        docStatus(`预览失败：${err.message}`, true);
      }
    }
  }

  function openDoc(path, mode = 'fast') {
    if (!DOC_RE.test(path)) return toast('只支持 docx / xlsx / pptx / pdf');
    state.doc = { path, mode };
    $('docview-title').textContent = baseName(path);
    $('docview-title').title = path;
    $('docview').classList.remove('hidden');
    loadDoc();
  }

  function closeDoc() {
    state.doc = null;
    $('docview').classList.add('hidden');
    if ($('docview-body').shadowRoot) $('docview-body').shadowRoot.innerHTML = '';
  }

  async function openExternal(path) {
    try { await apiPost('/api/open-external', { path }); toast('已用默认程序打开'); } catch (err) { toast(`打开失败：${err.message}`); }
  }

  // ---------- 规则与快捷指令 ----------
  function renderKb() {
    const s = state.snap;
    $('kb-meta').textContent = `${(s.snippets || []).length} 条指令 · ${(s.rules || []).filter((r) => r.exists).length} 个规则文件`;
    if (!state.kbOpen) return;
    setHtml('snippets', (s.snippets || []).map((x) => `
      <div class="row clickable" title="${esc(x.content)}"><span class="name">${esc(x.title)}</span>
        <span class="acts"><button type="button" class="mini-btn" data-snip-edit="${esc(x.id)}">编辑</button><button type="button" class="mini-btn" data-snip-del="${esc(x.id)}">删除</button><button type="button" class="mini-btn" data-snip-new="${esc(x.id)}">新会话</button></span>
        <button type="button" class="mini-btn" data-snip-send="${esc(x.id)}">发送</button></div>`).join('') || '<div class="empty">暂无</div>');

    if (state.editingRule) return; // 编辑时不重绘，避免冲掉输入
    setHtml('rules', (s.rules || []).map((r) => `
      <div class="row"><span class="ico">${ICON.doc}</span><span class="name" title="${esc(r.path)}">${esc(r.label)}</span>
        <span class="acts">${r.exists ? `<button type="button" class="mini-btn" data-preview="${esc(r.path)}" data-uri="${esc(r.uri)}" data-name="${esc(r.name)}">预览</button>` : ''}</span>
        <button type="button" class="mini-btn" data-rule-edit="${esc(r.path)}">${r.exists ? '编辑' : '创建'}</button></div>`).join(''));
  }

  function renderAll() {
    if (!state.snap) return;
    renderTop();
    renderEnv();
    renderComputerUse();
    renderContext();
    renderTimeline();
    renderConnectors();
    renderOutputs();
    renderKb();
  }

  // ---------- 数据 ----------
  async function refresh(force = false) {
    if (force) state.etag = '';
    const p = new URLSearchParams();
    if (state.selectedConvId) p.set('conversationId', state.selectedConvId);
    const h = hostConvId();
    if (h) p.set('hostConversationId', h);
    if (state.workspaceUris.length) p.set('workspaceUris', JSON.stringify(state.workspaceUris));
    if (state.etag) p.set('etag', state.etag);
    try {
      const d = await apiGet(`/api/context?${p}`);
      if (d.unchanged) return;
      state.etag = d.etag || '';
      state.snap = d;
      renderAll();
    } catch (e) {
      console.error('拉取失败', e);
    }
  }

  /** 运行中 1.5 秒刷新一次，空闲 5 秒；页面不可见时暂停。 */
  function schedule() {
    clearTimeout(state.timer);
    const delay = state.snap?.status === 'working' ? 1500 : 5000;
    state.timer = setTimeout(async () => {
      if (!document.hidden && !state.editingRule) await refresh();
      schedule();
    }, delay);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- 预览 ----------
  async function openPreview(path, uri, name) {
    try {
      const r = await apiGet(`/api/preview?path=${encodeURIComponent(path)}`);
      state.previewTarget = { path, uri, name };
      state.previewText = r.content || '';
      $('preview-title').textContent = r.name || name;
      $('preview-meta').textContent = `${fmtBytes(r.size)}${r.truncated ? ' · 只显示前 24KB' : ''}`;
      $('preview-body').textContent = r.content || '（空文件）';
      $('preview-backdrop').classList.remove('hidden');
      $('preview').classList.remove('hidden');
    } catch (e) { toast(`预览失败：${e.message}`); }
  }
  function closePreview() {
    $('preview-backdrop').classList.add('hidden');
    $('preview').classList.add('hidden');
  }

  // ---------- 事件 ----------
  function bind() {
    $('conv-select').addEventListener('change', (e) => { state.selectedConvId = e.target.value; state.lastHtml.clear(); refresh(true); });
    $('btn-refresh').addEventListener('click', () => { state.lastHtml.clear(); refresh(true); });
    $('ctx-cap').addEventListener('click', () => {
      const i = CAPS.indexOf(state.capacity);
      state.capacity = CAPS[(i + 1) % CAPS.length];
      store.set('cs.capacity', String(state.capacity));
      toast(`上下文窗口按 ${fmtCap(state.capacity)} 计算`);
      renderContext();
    });

    document.querySelectorAll('[data-tl]').forEach((b) => b.addEventListener('click', () => {
      state.tlFilter = b.dataset.tl;
      state.tlLimit = 12;
      document.querySelectorAll('[data-tl]').forEach((x) => x.classList.toggle('active', x === b));
      renderTimeline();
    }));
    document.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => {
      state.outTab = b.dataset.out;
      state.outLimit = 5;
      document.querySelectorAll('[data-out]').forEach((x) => x.classList.toggle('active', x === b));
      renderOutputs();
    }));
    $('tl-more').addEventListener('click', () => { state.tlLimit += 20; renderTimeline(); });
    $('conn-more').addEventListener('click', () => { state.connLimit += 20; renderConnectors(); });
    $('out-more').addEventListener('click', () => { state.outLimit += 20; renderOutputs(); });
    $('kb-toggle').addEventListener('click', () => {
      state.kbOpen = !state.kbOpen;
      $('kb-toggle').setAttribute('aria-expanded', String(state.kbOpen));
      $('kb-body').classList.toggle('hidden', !state.kbOpen);
      state.lastHtml.delete('snippets'); state.lastHtml.delete('rules');
      renderKb();
    });

    $('preview-close').addEventListener('click', closePreview);
    $('preview-backdrop').addEventListener('click', closePreview);
    $('preview-copy').addEventListener('click', () => copy(state.previewText, '已复制内容'));
    $('preview-open').addEventListener('click', () => openFile(state.previewTarget?.uri));

    $('btn-new-snippet').addEventListener('click', () => {
      $('snippet-id').value = ''; $('snippet-title').value = ''; $('snippet-content').value = '';
      $('snippet-form').classList.remove('hidden'); $('snippet-title').focus();
    });
    $('btn-cancel-snippet').addEventListener('click', () => $('snippet-form').classList.add('hidden'));
    $('snippet-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('snippet-id').value;
      try {
        await apiPost('/api/snippets', { action: id ? 'update' : 'add', snippet: { id, title: $('snippet-title').value, content: $('snippet-content').value } });
        $('snippet-form').classList.add('hidden');
        toast('已保存');
        refresh(true);
      } catch (err) { toast(`保存失败：${err.message}`); }
    });

    document.querySelector('.main').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-external],[data-doc],[data-copy],[data-preview],[data-open],[data-expand],[data-act],[data-goto-fail],[data-snip-send],[data-snip-new],[data-snip-edit],[data-snip-del],[data-rule-edit],[data-rule-save],[data-rule-cancel]');
      if (!el) return;
      const d = el.dataset;
      if (d.preview) { e.stopPropagation(); return openPreview(d.preview, d.uri, d.name); }
      if (d.copy) { e.stopPropagation(); return copy(d.copy, '已复制路径'); }
      if (d.external) { e.stopPropagation(); return openExternal(d.external); }
      if (d.doc) return openDoc(d.doc);
      if (d.open) return openFile(d.open);
      if (d.expand) {
        state.expanded.has(d.expand) ? state.expanded.delete(d.expand) : state.expanded.add(d.expand);
        return renderContext();
      }
      if (d.gotoFail) {
        document.querySelector('[data-tl="fail"]').click();
        return $('timeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (d.act === 'handoff') return sendToAgent('上下文快满了。请使用 handoff 技能，把当前任务的目标、进度、关键文件、踩过的坑和下一步写成交接文件，写完告诉我文件路径。', '已请 Agent 写交接文件');
      if (d.act === 'newconv') {
        if (!window.sidecar?.agent?.startConversation) return toast('当前环境不支持新建会话');
        try {
          await window.sidecar.agent.startConversation('继续上次的交接：请使用 handoff 技能，读取工作区 .agents/handoff/ 下最新一份 status: open 的交接文件，核对现状后从“下一步”开始继续。', '接续：' + (state.snap.title || '上次的任务'));
          toast('已开启新会话');
        } catch (err) { toast(`开启失败：${err.message}`); }
        return;
      }
      if (d.act === 'dismiss') { store.set(d.key, '1'); return renderContext(); }
      if (d.act === 'cu-look') return sendToAgent('请使用 computer-use 技能截一张屏，告诉我桌面上现在开着哪些程序、当前在前台的是什么。只看不操作。', '已请 Agent 截屏');
      if (d.act === 'cu-release') return sendToAgent('请调用电脑操控的 ControlStatus 工具（release=true），把桌面控制权交还给我，然后不要再操作桌面。', '已请 Agent 交还控制');

      const snip = (state.snap.snippets || []).find((x) => x.id === (d.snipSend || d.snipNew || d.snipEdit || d.snipDel));
      if (d.snipSend && snip) return sendToAgent(snip.content, `已发送「${snip.title}」`);
      if (d.snipNew && snip) {
        if (!window.sidecar?.agent?.startConversation) return toast('当前环境不支持新建会话');
        try { await window.sidecar.agent.startConversation(snip.content, snip.title); toast('已开启新会话'); } catch (err) { toast(`开启失败：${err.message}`); }
        return;
      }
      if (d.snipEdit && snip) {
        $('snippet-id').value = snip.id; $('snippet-title').value = snip.title; $('snippet-content').value = snip.content;
        $('snippet-form').classList.remove('hidden'); $('snippet-title').focus();
        return;
      }
      if (d.snipDel) {
        try { await apiPost('/api/snippets', { action: 'delete', id: d.snipDel }); toast('已删除'); refresh(true); } catch (err) { toast(`删除失败：${err.message}`); }
        return;
      }
      if (d.ruleEdit) {
        const r = (state.snap.rules || []).find((x) => x.path === d.ruleEdit);
        if (!r) return;
        state.editingRule = r.path;
        state.lastHtml.delete('rules');
        $('rules').innerHTML = `<div class="sub-title">${esc(r.label)}</div><textarea id="rule-editor" class="rule-editor">${esc(r.content)}</textarea>
          <div class="form-actions"><button type="button" class="ghost-btn" data-rule-cancel="1">取消</button><button type="button" class="primary-btn" data-rule-save="${esc(r.path)}">保存</button></div>`;
        return;
      }
      if (d.ruleCancel) { state.editingRule = null; state.lastHtml.delete('rules'); return renderKb(); }
      if (d.ruleSave) {
        try {
          await apiPost('/api/save-rule', { path: d.ruleSave, content: $('rule-editor').value });
          state.editingRule = null; state.lastHtml.delete('rules');
          toast('规则已保存');
          refresh(true);
        } catch (err) { toast(`保存失败：${err.message}`); }
      }
    });
  }

  function bindDocview() {
    $('docview-close').addEventListener('click', closeDoc);
    $('docview-reload').addEventListener('click', () => loadDoc());
    $('docview-external').addEventListener('click', () => state.doc && openExternal(state.doc.path));
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      if (!state.doc || state.doc.mode === b.dataset.mode) return;
      state.doc.mode = b.dataset.mode;
      loadDoc();
    }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.doc) closeDoc(); });
  }

  async function init() {
    bind();
    bindDocview();
    // sidecar://claude-context-studio/studio/?preview=<文件路径> 直接打开文档预览
    const pv = new URLSearchParams(location.search).get('preview');
    if (pv) openDoc(pv);
    window.sidecar?.onWorkspaceChange?.((uris) => { state.workspaceUris = Array.isArray(uris) ? uris : []; refresh(true); });
    try { const u = await window.sidecar?.getWorkspaceUris?.(); if (Array.isArray(u)) state.workspaceUris = u; } catch {}
    await refresh(true);
    schedule();
  }
  init();
})();
