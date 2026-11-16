/**
 * Claude Context Studio sidecar 后端（v2）。
 *
 * - 增量解析当前会话 transcript.jsonl（只读新增字节）
 * - 把每次工具调用与其执行结果配对，标出成功 / 失败 / 运行中
 * - 估算上下文构成：系统与内置工具、规则、技能、MCP 工具、对话消息
 * - 汇总环境（工作区、模型）、连接器（MCP）、输出内容（改过的文件 + 产物）
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const PREVIEW_MAX_BYTES = 24 * 1024;
const GEMINI_DIR = join(homedir(), '.gemini');
const CONFIG_DIR = join(GEMINI_DIR, 'config');
const TIMELINE_MAX = 80;

const DEFAULT_SNIPPETS = [
  {
    id: 'builtin-review-changes',
    title: '审查本轮修改的文件',
    tag: '代码审查',
    content: '请使用 code-review 技能审查本次会话修改过的文件，只报告能写出具体触发场景的问题。',
    updatedAt: '2026-11-17T00:00:00.000Z',
  },
  {
    id: 'builtin-handoff',
    title: '交接到新会话',
    tag: '会话交接',
    content: '请使用 handoff 技能，把当前任务的目标、进度、关键文件、踩过的坑和下一步写成交接文件。',
    updatedAt: '2026-11-17T00:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function statSafe(p) {
  try {
    const s = statSync(p);
    return { exists: true, isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
  } catch {
    return { exists: false, isFile: false, isDirectory: false, size: -1, mtime: 0 };
  }
}

function readText(p, max = Infinity) {
  try {
    const t = readFileSync(p, 'utf-8');
    return t.length > max ? t.slice(0, max) : t;
  } catch { return ''; }
}

function normalizePath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('file://')) {
    try { s = fileURLToPath(s); } catch { return ''; }
  }
  try { return resolve(s); } catch { return s; }
}

function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith('file://')) {
    try { return fileURLToPath(uri); } catch { return ''; }
  }
  return isAbsolute(uri) ? uri : '';
}

function toFileUri(p) {
  try { return pathToFileURL(p).href; } catch { return ''; }
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return String(JSON.parse(s)); } catch { return s.slice(1, -1); }
  }
  return s;
}

function oneLine(s, maxLen = 120) {
  const out = String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

/** 粗略 token 估算：中日韩字符约 1 token/字，其余约 4 字符/token。 */
function estTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

function memo(ttlMs, fn) {
  const cache = new Map();
  return (key = '') => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = fn(key);
    cache.set(key, { at: now, value });
    return value;
  };
}

// ---------------------------------------------------------------------------
// 目录定位
// ---------------------------------------------------------------------------

function findAppDataDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
  }
  const primary = join(GEMINI_DIR, 'antigravity');
  if (existsSync(join(primary, 'brain'))) return primary;
  for (const name of safeReaddir(GEMINI_DIR)) {
    const c = join(GEMINI_DIR, name);
    if (existsSync(join(c, 'brain'))) return c;
  }
  return primary;
}

const APP_DATA = findAppDataDir();

function getDataStorageDir() {
  return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(APP_DATA, 'sidecar_data', 'claude-context-studio', 'studio', 'data');
}

function getEventsDir() {
  return join(APP_DATA, 'sidecar_data', 'claude-context-studio', 'studio', 'events');
}

function getLatestEventMetadata() {
  const files = safeReaddir(getEventsDir()).filter((n) => n.endsWith('.json')).sort().reverse();
  for (const name of files.slice(0, 8)) {
    try {
      const parsed = JSON.parse(readFileSync(join(getEventsDir(), name), 'utf-8'));
      const meta = parsed?.payload?.conversationMetadata?.metadata;
      if (meta && typeof meta === 'object') {
        const ws = Array.isArray(meta.workspaceUris) ? meta.workspaceUris : [];
        const ws2 = Array.isArray(meta.workspaces) ? meta.workspaces.map((w) => w?.workspaceFolderAbsoluteUri).filter(Boolean) : [];
        return { rootConversationId: String(meta.rootConversationId || ''), workspaceUris: [...new Set([...ws, ...ws2])] };
      }
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// 会话列表与标题
// ---------------------------------------------------------------------------

const titleCache = new Map();
function fetchConvTitle(convId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', convId];
  return new Promise((done) => {
    execFile(exe || 'agentapi', args, { encoding: 'utf-8', timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return done('');
      try {
        const md = JSON.parse(stdout || '{}');
        done(String(md.title || md.summary || md.metadata?.title || md.response?.conversationMetadata?.metadata?.title || '').trim());
      } catch { done(''); }
    });
  });
}

function getConvTitle(convId, fallback = '') {
  const cached = titleCache.get(convId);
  if (typeof cached === 'string' && cached) return cached;
  if (!cached) titleCache.set(convId, fetchConvTitle(convId).then((t) => titleCache.set(convId, t || '')));
  return fallback || convId.slice(0, 8);
}

function cleanUserText(s) {
  return String(s || '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

const firstPromptCache = new Map();
function firstPrompt(trPath) {
  if (firstPromptCache.has(trPath)) return firstPromptCache.get(trPath);
  let out = '';
  try {
    const fd = openSync(trPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf-8').split('\n')) {
      try {
        const s = JSON.parse(line);
        if (s?.type === 'USER_INPUT') { out = oneLine(cleanUserText(s.content), 44); break; }
      } catch {}
    }
  } catch {}
  firstPromptCache.set(trPath, out);
  return out;
}

const listConversations = memo(3000, () => {
  const root = join(APP_DATA, 'brain');
  const out = [];
  for (const id of safeReaddir(root)) {
    if (!ID_RE.test(id)) continue;
    const trPath = join(root, id, '.system_generated', 'logs', 'transcript.jsonl');
    const st = statSafe(trPath);
    if (st.exists) out.push({ id, mtime: st.mtime, trPath });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 20).map((c) => ({ ...c, title: getConvTitle(c.id, firstPrompt(c.trPath)) }));
});

// ---------------------------------------------------------------------------
// 工具调用描述
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['view_file', 'read_file', 'view_file_outline', 'view_code_item']);
const WRITE_TOOLS = new Set(['write_to_file', 'write_file']);
const EDIT_TOOLS = new Set(['replace_file_content', 'multi_replace_file_content', 'edit_file']);

function toolTarget(args) {
  return unquote(args.TargetFile || args.AbsolutePath || args.Path || args.FilePath || args.DirectoryPath || args.SearchPath || '');
}

// ---------------------------------------------------------------------------
// 电脑操控（本插件自带的 Windows-MCP 服务器）
// ---------------------------------------------------------------------------

const CU_SERVER = 'claude-context-studio_computer-use';
const isComputerUseServer = (s) => /computer-use|windows-mcp/i.test(String(s || ''));
const CU_NAMES = {
  Click: '点击', Type: '输入', Scroll: '滚动', Move: '移动 / 拖拽', Shortcut: '快捷键', App: '程序窗口',
  Screenshot: '截屏', Snapshot: '读取界面', Wait: '等待', WaitFor: '等待出现', Scrape: '读取网页',
  Clipboard: '剪贴板', Process: '进程', Notification: '系统通知', ControlStatus: '控制权',
  DisplayInventory: '屏幕信息', MultiSelect: '多选', MultiEdit: '批量输入',
};

function cuDetail(tool, rawArgs) {
  let a = rawArgs;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
  if (!a || typeof a !== 'object') return '';
  const loc = Array.isArray(a.loc) ? `(${a.loc.join(', ')})` : '';
  switch (tool) {
    case 'Type': return oneLine(`${loc} "${unquote(a.text)}"`, 50);
    case 'Click': return `${loc}${a.button && a.button !== 'left' ? ` ${a.button}` : ''}${a.clicks > 1 ? ` ×${a.clicks}` : ''}`;
    case 'Shortcut': return unquote(a.shortcut || a.keys || '');
    case 'App': return oneLine(`${unquote(a.mode || '')} ${unquote(a.name || '')}`, 40);
    case 'Scroll': return `${unquote(a.direction || '')} ${a.wheel_times || ''}`.trim();
    case 'ControlStatus': return a.release ? '交还给用户' : '';
    default: return '';
  }
}

function findWindowsMcpVersion() {
  const base = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'uv', 'tools', 'windows-mcp', 'Lib', 'site-packages');
  const di = safeReaddir(base).find((n) => /^windows_mcp-.*\.dist-info$/i.test(n));
  return di ? di.replace(/^windows_mcp-/i, '').replace(/\.dist-info$/i, '') : '';
}

const computerUseStatus = memo(10000, () => {
  const exe = join(homedir(), '.local', 'bin', 'windows-mcp.exe');
  const installed = existsSync(exe);
  const cacheDir = join(APP_DATA, 'mcp', CU_SERVER);
  const tools = safeReaddir(cacheDir).filter((f) => f.endsWith('.json')).length;
  return { installed, version: installed ? findWindowsMcpVersion() : '', connected: tools > 0, tools, server: CU_SERVER };
});

/** 返回 { icon, verb, target, kind }，kind 用于前端着色。 */
function describeTool(name, args) {
  const t = toolTarget(args);
  const file = t ? basename(t) : '';
  const summary = oneLine(unquote(args.toolSummary || ''), 60);
  if (READ_TOOLS.has(name)) return { icon: 'read', verb: '读取', target: file };
  if (WRITE_TOOLS.has(name)) return { icon: 'write', verb: '写入', target: file };
  if (EDIT_TOOLS.has(name)) return { icon: 'edit', verb: '编辑', target: file };
  switch (name) {
    case 'run_command': return { icon: 'cmd', verb: '运行', target: oneLine(unquote(args.CommandLine), 70) };
    case 'command_status': return { icon: 'cmd', verb: '查看命令输出', target: '' };
    case 'send_command_input': return { icon: 'cmd', verb: '向命令发送输入', target: '' };
    case 'list_dir': return { icon: 'search', verb: '列出目录', target: file };
    case 'find_by_name': return { icon: 'search', verb: '查找文件', target: oneLine(unquote(args.Pattern), 40) };
    case 'grep_search': return { icon: 'search', verb: '搜索代码', target: oneLine(unquote(args.Query), 40) };
    case 'codebase_search': return { icon: 'search', verb: '语义搜索', target: oneLine(unquote(args.Query), 40) };
    case 'search_web': return { icon: 'web', verb: '网页搜索', target: oneLine(unquote(args.query), 40) };
    case 'read_url_content': return { icon: 'web', verb: '读取网页', target: oneLine(unquote(args.Url), 50) };
    case 'webview_browser': return { icon: 'web', verb: '浏览器操作', target: oneLine(unquote(args.intention), 50) };
    case 'call_mcp_tool': {
      const server = unquote(args.ServerName);
      const tool = unquote(args.ToolName);
      if (isComputerUseServer(server)) return { icon: 'cu', verb: `电脑操控 · ${CU_NAMES[tool] || tool}`, target: cuDetail(tool, args.Arguments), cu: true };
      return { icon: 'mcp', verb: `MCP · ${server}`, target: tool };
    }
    case 'invoke_subagent': return { icon: 'agent', verb: '调用子智能体', target: summary };
    case 'manage_task': return { icon: 'task', verb: '任务', target: `${unquote(args.Action)} ${unquote(args.TaskId)}`.trim() };
    case 'ask_question': return { icon: 'ask', verb: '向你提问', target: '' };
    case 'send_message': return { icon: 'agent', verb: '发送消息', target: oneLine(unquote(args.Recipient), 40) };
    case 'schedule': return { icon: 'task', verb: '定时任务', target: oneLine(unquote(args.Prompt), 40) };
    case 'manage_subagents': return { icon: 'agent', verb: '管理子智能体', target: unquote(args.Action) };
    case 'generate_image': return { icon: 'write', verb: '生成图片', target: summary };
    case 'enter_plan_mode': return { icon: 'task', verb: '进入计划模式', target: '' };
    case 'exit_plan_mode': return { icon: 'task', verb: '提交计划', target: '' };
    default:
      if (name.startsWith('browser_')) return { icon: 'web', verb: '浏览器', target: name.slice(8) };
      return { icon: 'tool', verb: name, target: summary };
  }
}

function thinkingHeading(thinking) {
  if (typeof thinking !== 'string' || !thinking.trim()) return '';
  const m = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{2,96})\*\*\s*(?=\n|$)/g)];
  if (m.length) return oneLine(m[m.length - 1][1], 96);
  const t = oneLine(thinking, 110);
  return /^I'm thinking through/i.test(t) ? '' : t;
}

/** 从工具结果（GENERIC 步骤）判断成败。 */
function resultStatus(step) {
  const status = String(step.status || '');
  const content = String(step.content || '');
  if (status === 'RUNNING' || /running as a background task/i.test(content)) return { status: 'running', detail: '后台运行中' };
  const code = content.match(/exited with code (-?\d+)/i);
  if (code && code[1] !== '0') return { status: 'fail', detail: `退出码 ${code[1]}` };
  if (status === 'ERROR') {
    const msg = content.split('\n').map((l) => l.trim()).filter((l) => l && !/^(Created|Completed) At:/.test(l))[0] || '执行出错';
    return { status: 'fail', detail: oneLine(msg, 90) };
  }
  return { status: 'ok', detail: '' };
}

// ---------------------------------------------------------------------------
// transcript 增量解析
// ---------------------------------------------------------------------------

function newConvState() {
  return {
    offset: 0,
    pending: '',
    lineNo: 0,
    turns: 0,
    steps: 0,
    tokens: { input: 0, cache: 0, output: 0, latestInput: 0, latestCache: 0, latestOutput: 0, baseline: 0, history: [] },
    model: '',
    files: new Map(),
    timeline: [],
    pendingActions: [],
    subagents: [],
    lastType: '',
    lastHasCalls: false,
    lastActivityAt: '',
    failures: 0,
  };
}

function ingestStep(st, step) {
  st.steps += 1;
  const idx = Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : st.lineNo;
  const type = String(step.type || '');
  const at = String(step.created_at || '');
  st.lastActivityAt = at || st.lastActivityAt;
  st.lastType = type;

  if (type === 'USER_INPUT') {
    st.turns += 1;
    const raw = String(step.content || '');
    const mm = [...raw.matchAll(/`Model Selection` from (?:None|.+?) to (.+?)\.(?:\s|$)/g)];
    if (mm.length) st.model = mm[mm.length - 1][1].trim();
    st.pendingActions = [];
    st.timeline.push({ kind: 'user', stepIndex: idx, at, text: oneLine(cleanUserText(raw), 160) || '用户输入' });
    st.lastHasCalls = false;
    return;
  }

  if (type === 'ERROR_MESSAGE') {
    st.failures += 1;
    st.timeline.push({ kind: 'error', stepIndex: idx, at, text: oneLine(step.error || step.content || '模型请求出错', 160) });
    return;
  }

  if (type === 'GENERIC') {
    const action = st.pendingActions.shift();
    if (action) {
      const r = resultStatus(step);
      action.status = r.status;
      action.detail = r.detail;
      if (r.status === 'fail') st.failures += 1;
    }
    // 记录 Agent 最近一次"看到"的画面（桌面截屏或浏览器截图）
    const media = Array.isArray(step.media) ? step.media : [];
    const img = media.find((m) => m && /^image\//.test(String(m.mime_type || '')) && m.uri);
    if (img) {
      const p = fileUriToPath(String(img.uri));
      if (p) st.lastShot = { path: normalizePath(p), uri: String(img.uri), at, source: action?.cu ? '桌面' : action?.name === 'webview_browser' || action?.icon === 'web' ? '浏览器' : '工具', stepIndex: idx };
    }
    return;
  }

  if (type !== 'PLANNER_RESPONSE') return;

  const inTok = Number(step.input_tokens) || 0;
  const cacheTok = Number(step.cache_read_tokens) || 0;
  const outTok = Number(step.output_tokens) || 0;
  const ctx = inTok + cacheTok;
  const T = st.tokens;
  if (ctx > 0 || outTok > 0) {
    T.input += inTok; T.cache += cacheTok; T.output += outTok;
    T.latestInput = inTok; T.latestCache = cacheTok; T.latestOutput = outTok;
    if (!T.baseline && ctx > 0) T.baseline = ctx;
    T.history.push({ stepIndex: idx, ctx, out: outTok });
    if (T.history.length > 60) T.history.shift();
  }

  let calls = step.tool_calls;
  if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { calls = []; } }
  calls = Array.isArray(calls) ? calls : [];

  const actions = [];
  for (const tc of calls) {
    if (!tc || typeof tc !== 'object') continue;
    const name = String(tc.name || '');
    const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
    const d = describeTool(name, args);
    const action = { name, ...d, status: 'pending', detail: '' };
    actions.push(action);
    if (d.cu) {
      st.cuCount = (st.cuCount || 0) + 1;
      st.cuLastAt = at;
    }

    const target = toolTarget(args);
    if (target && (READ_TOOLS.has(name) || WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name))) {
      const abs = normalizePath(target);
      const modified = !READ_TOOLS.has(name);
      const prev = st.files.get(abs);
      st.files.set(abs, {
        path: abs,
        action: prev?.action === 'modified' || modified ? 'modified' : 'read',
        count: (prev?.count || 0) + 1,
        lastStep: idx,
        at,
      });
    }
    if (name === 'invoke_subagent') {
      st.subagents.push({ stepIndex: idx, at, role: unquote(args.Role) || '子智能体', prompt: oneLine(unquote(args.Prompt), 120) });
    }
  }
  st.pendingActions = actions.slice();
  st.lastHasCalls = actions.length > 0;

  const thought = thinkingHeading(step.thinking);
  const reply = actions.length ? '' : oneLine(String(step.content || '').replace(/^#{1,6}\s+/gm, '').replace(/^[-*_]{3,}\s*$/gm, '').replace(/^\s*[-*]\s+/gm, ''), 160);
  st.timeline.push({ kind: 'model', stepIndex: idx, at, ctx, out: outTok, thought, reply, actions });
  if (st.timeline.length > TIMELINE_MAX * 2) st.timeline.splice(0, st.timeline.length - TIMELINE_MAX);
}

const convStates = new Map(); // trPath -> state

function readConversation(trPath) {
  const fst = statSafe(trPath);
  let st = convStates.get(trPath);
  if (!fst.exists) return st || newConvState();
  if (!st || fst.size < st.offset) {
    st = newConvState();
    convStates.set(trPath, st);
  }
  if (fst.size > st.offset) {
    const fd = openSync(trPath, 'r');
    try {
      const len = fst.size - st.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      st.offset = fst.size;
      const text = st.pending + buf.toString('utf-8');
      const lines = text.split('\n');
      st.pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        st.lineNo += 1;
        try { ingestStep(st, JSON.parse(line)); } catch {}
      }
    } finally { closeSync(fd); }
  }
  st.mtime = fst.mtime;
  if (convStates.size > 30) {
    const firstKey = convStates.keys().next().value;
    if (firstKey !== trPath) convStates.delete(firstKey);
  }
  return st;
}

// ---------------------------------------------------------------------------
// 全局生态：规则、技能、MCP（带缓存）
// ---------------------------------------------------------------------------

function parseSkillMeta(file, fallback) {
  const raw = readText(file, 3000);
  const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { name: fallback, description: '' };
  const block = fm[1];
  const name = (block.match(/^name:\s*(.+)$/m)?.[1] || '').replace(/^["']|["']$/g, '').trim() || fallback;
  let description = '';
  const d = block.match(/^description:\s*(.*)$/m);
  if (d) {
    description = d[1].trim();
    if (/^[>|]-?$/.test(description)) {
      const after = block.slice(block.indexOf(d[0]) + d[0].length).split(/\r?\n/);
      const lines = [];
      for (const l of after) { if (/^\s+\S/.test(l)) lines.push(l.trim()); else if (l.trim()) break; }
      description = lines.join(' ');
    }
    description = description.replace(/^["']|["']$/g, '');
  }
  return { name, description };
}

function loadPluginStates() {
  try {
    const cfg = JSON.parse(readText(join(CONFIG_DIR, 'config.json')) || '{}');
    return cfg.plugins || {};
  } catch { return {}; }
}

const scanEcosystem = memo(15000, (wsKey) => {
  const wsSeen = new Set();
  const wsPaths = (wsKey ? wsKey.split('|') : []).map(fileUriToPath).filter(Boolean).map(normalizePath)
    .filter((p) => { const k = p.toLowerCase(); if (wsSeen.has(k)) return false; wsSeen.add(k); return true; });
  const pluginStates = loadPluginStates();
  const rules = [];
  const seen = new Set();
  const addRule = (file, scope, label, allowCreate = false) => {
    const abs = normalizePath(file);
    if (!abs || seen.has(abs)) return;
    const st = statSafe(abs);
    if (!st.exists && !allowCreate) return;
    seen.add(abs);
    const content = st.exists ? readText(abs, 60000) : '';
    rules.push({ scope, label, name: basename(abs), path: abs, uri: toFileUri(abs), exists: st.exists, size: st.exists ? st.size : 0, content, tokens: estTokens(content) });
  };

  for (const ws of wsPaths) {
    addRule(join(ws, 'AGENTS.md'), 'workspace', `${basename(ws)} / AGENTS.md`, true);
    addRule(join(ws, 'GEMINI.md'), 'workspace', `${basename(ws)} / GEMINI.md`);
    for (const f of safeReaddir(join(ws, '.agents', 'rules'))) {
      if (f.endsWith('.md')) addRule(join(ws, '.agents', 'rules', f), 'workspace', `${basename(ws)} / .agents/rules/${f}`);
    }
  }
  addRule(join(CONFIG_DIR, 'AGENTS.md'), 'global', '全局规则 AGENTS.md', true);
  addRule(join(CONFIG_DIR, 'GEMINI.md'), 'global', '全局规则 GEMINI.md');

  const skills = [];
  const addSkill = (file, dirName, source, disabled) => {
    if (!statSafe(file).exists) return;
    const meta = parseSkillMeta(file, dirName);
    skills.push({ ...meta, source, disabled, path: normalizePath(file), uri: toFileUri(file), tokens: estTokens(`${meta.name} ${meta.description}`) + 15 });
  };
  for (const d of safeReaddir(join(CONFIG_DIR, 'skills'))) addSkill(join(CONFIG_DIR, 'skills', d, 'SKILL.md'), d, '全局技能', false);
  for (const d of safeReaddir(join(APP_DATA, 'builtin', 'skills'))) addSkill(join(APP_DATA, 'builtin', 'skills', d, 'SKILL.md'), d, '内置', false);

  const plugins = [];
  const pluginsDir = join(CONFIG_DIR, 'plugins');
  for (const dir of safeReaddir(pluginsDir)) {
    const pDir = join(pluginsDir, dir);
    if (!statSafe(pDir).isDirectory) continue;
    let label = dir;
    let disabled = false;
    try {
      const pj = JSON.parse(readText(join(pDir, 'plugin.json')));
      label = pj.displayName || pj.name || dir;
      disabled = Boolean(pj.disabled);
    } catch {}
    if (pluginStates[dir] && typeof pluginStates[dir].disabled === 'boolean') disabled = pluginStates[dir].disabled;
    plugins.push({ dir, label, disabled });
    if (disabled) continue;
    for (const rf of safeReaddir(join(pDir, 'rules'))) {
      if (rf.endsWith('.md')) addRule(join(pDir, 'rules', rf), 'plugin', `${label} / ${rf}`);
    }
    for (const sd of safeReaddir(join(pDir, 'skills'))) addSkill(join(pDir, 'skills', sd, 'SKILL.md'), sd, label, false);
  }

  // MCP：反重力把每个已连接服务器的工具定义缓存在 <appData>/mcp/<server>/*.json
  const mcpDir = join(APP_DATA, 'mcp');
  const mcpServers = [];
  for (const server of safeReaddir(mcpDir)) {
    const sDir = join(mcpDir, server);
    if (!statSafe(sDir).isDirectory) continue;
    let tools = 0;
    let tokens = 0;
    for (const f of safeReaddir(sDir)) {
      if (f.endsWith('.json')) { tools += 1; tokens += estTokens(readText(join(sDir, f))); }
      else if (f === 'instructions.md') tokens += estTokens(readText(join(sDir, f)));
    }
    mcpServers.push({ name: server, tools, tokens, status: 'connected' });
  }
  const configured = new Map();
  const readMcp = (file, source, disabled) => {
    try {
      const map = JSON.parse(readText(file) || '{}')?.mcpServers || {};
      for (const [name, cfg] of Object.entries(map)) {
        if (!cfg || typeof cfg !== 'object') continue;
        configured.set(name, { name, source, disabled: Boolean(cfg.disabled || disabled), transport: cfg.serverUrl || cfg.url ? 'HTTP' : 'stdio' });
      }
    } catch {}
  };
  readMcp(join(CONFIG_DIR, 'mcp_config.json'), '全局配置', false);
  for (const p of plugins) readMcp(join(pluginsDir, p.dir, 'mcp_config.json'), p.label, p.disabled);
  for (const c of configured.values()) {
    const hit = mcpServers.find((s) => s.name === c.name || s.name.endsWith(`_${c.name}`) || s.name.startsWith(`${c.name}`));
    if (hit) Object.assign(hit, { source: c.source, transport: c.transport, status: c.disabled ? 'disabled' : 'connected' });
    else mcpServers.push({ name: c.name, tools: 0, tokens: 0, source: c.source, transport: c.transport, status: c.disabled ? 'disabled' : 'configured' });
  }
  mcpServers.sort((a, b) => (a.status === 'connected' ? 0 : 1) - (b.status === 'connected' ? 0 : 1) || b.tools - a.tools);

  return { wsPaths, rules, skills, plugins, mcpServers };
});

// ---------------------------------------------------------------------------
// 会话产物
// ---------------------------------------------------------------------------

function scanArtifacts(convDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const name of safeReaddir(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      const st = statSafe(full);
      if (st.isDirectory) walk(full, depth + 1);
      else if (st.isFile) {
        const rel = relative(convDir, full).replace(/\\/g, '/');
        out.push({ name, path: normalizePath(full), uri: toFileUri(full), size: st.size, mtime: st.mtime, kind: rel.startsWith('scratch/') ? 'scratch' : 'artifact', label: rel });
      }
    }
  };
  walk(convDir, 0);
  return out;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

const allowedPreviewPaths = new Set();
const allowedRulePaths = new Set();
const allowedImagePaths = new Set();

function resolveConv(requestedId, hostId, recents, eventMeta) {
  const ok = (id) => id && ID_RE.test(id) && existsSync(join(APP_DATA, 'brain', id));
  if (ok(requestedId)) return { id: requestedId, auto: false };
  for (const id of [hostId, app.config.conversationId, eventMeta?.rootConversationId]) if (ok(id)) return { id, auto: true };
  return { id: recents[0]?.id || '', auto: true };
}

function buildContextBreakdown(st, eco) {
  const current = st.tokens.latestInput + st.tokens.latestCache;
  const baseline = st.tokens.baseline || current;
  const rules = eco.rules.filter((r) => r.exists).reduce((a, r) => a + r.tokens, 0);
  const skills = eco.skills.filter((s) => !s.disabled).reduce((a, s) => a + s.tokens, 0);
  const mcp = eco.mcpServers.filter((s) => s.status === 'connected').reduce((a, s) => a + s.tokens, 0);
  // 首轮上下文 = 系统提示 + 工具 + 规则 + 技能 + MCP + 首条消息。估算值超过时按比例压缩，至少给系统提示留 15%
  let fixed = rules + skills + mcp;
  let scale = 1;
  const cap = baseline * 0.85;
  if (fixed > cap && fixed > 0) { scale = cap / fixed; fixed = cap; }
  const system = Math.max(0, baseline - fixed);
  const messages = Math.max(0, current - baseline);
  return {
    current,
    estimated: true,
    parts: [
      { key: 'messages', label: '对话消息', tokens: messages },
      { key: 'system', label: '系统提示与内置工具', tokens: system },
      { key: 'mcp', label: 'MCP 工具', tokens: Math.round(mcp * scale), expandable: 'mcp' },
      { key: 'rules', label: '规则', tokens: Math.round(rules * scale), expandable: 'rules' },
      { key: 'skills', label: '技能', tokens: Math.round(skills * scale), expandable: 'skills' },
    ],
  };
}

function buildSnapshot({ requestedId, hostId, workspaceUris, etag: clientEtag }) {
  const recents = listConversations();
  const eventMeta = getLatestEventMetadata();
  const wsUris = workspaceUris?.length ? workspaceUris : eventMeta?.workspaceUris || [];
  const eco = scanEcosystem(wsUris.join('|'));
  const target = resolveConv(requestedId, hostId, recents, eventMeta);
  const snippets = loadSnippets();
  const snippetsMtime = statSafe(getSnippetsFile()).mtime;

  for (const r of eco.rules) { allowedRulePaths.add(r.path); if (r.exists) allowedPreviewPaths.add(r.path); }
  for (const s of eco.skills) allowedPreviewPaths.add(s.path);

  const convDir = target.id ? join(APP_DATA, 'brain', target.id) : '';
  const trPath = convDir ? join(convDir, '.system_generated', 'logs', 'transcript.jsonl') : '';
  const st = trPath ? readConversation(trPath) : newConvState();
  const artifacts = convDir ? scanArtifacts(convDir) : [];
  const artKey = artifacts.map((a) => `${a.name}:${a.mtime}`).join(',');

  const cu = computerUseStatus();
  if (st.lastShot) allowedImagePaths.add(st.lastShot.path);
  const etag = [target.id, st.offset, st.timeline.length, artKey.length, artKey.slice(-200), snippetsMtime, eco.rules.length, eco.mcpServers.length, titleCache.get(target.id) || '', cu.connected, cu.tools, st.lastShot?.path || ''].join('|');
  if (clientEtag && clientEtag === etag) return { unchanged: true, etag };

  const working = st.lastType === 'USER_INPUT' || st.lastType === 'GENERIC' || (st.lastType === 'PLANNER_RESPONSE' && st.lastHasCalls)
    || st.timeline.some((t) => t.kind === 'model' && t.actions.some((a) => a.status === 'running' || a.status === 'pending') && t === st.timeline[st.timeline.length - 1]);
  const idleTooLong = st.mtime && Date.now() - st.mtime > 10 * 60 * 1000;

  // 输出内容：本会话改过的文件（工作区内）+ 产物，按时间倒序
  const outputs = [];
  for (const f of st.files.values()) {
    if (f.action !== 'modified' || isInside(f.path, GEMINI_DIR)) continue;
    const s = statSafe(f.path);
    outputs.push({ name: basename(f.path), path: f.path, uri: toFileUri(f.path), kind: 'file', count: f.count, exists: s.exists, size: s.size, sortKey: f.lastStep * 1e6 });
  }
  const outFiles = outputs.sort((a, b) => b.sortKey - a.sortKey);
  const arts = artifacts.sort((a, b) => b.mtime - a.mtime);
  for (const o of [...outFiles, ...arts]) allowedPreviewPaths.add(o.path);

  const readFiles = [...st.files.values()].filter((f) => f.action === 'read' && !isInside(f.path, GEMINI_DIR)).length;

  return {
    etag,
    conversationId: target.id,
    autoDetected: target.auto,
    title: target.id ? getConvTitle(target.id, recents.find((c) => c.id === target.id)?.title || '') : '暂无会话',
    recentConversations: recents.map(({ id, title, mtime }) => ({ id, title, mtime })),
    status: working && !idleTooLong ? 'working' : 'idle',
    environment: {
      workspaces: eco.wsPaths.map((p) => ({ name: basename(p), path: p })),
      model: st.model,
      turns: st.turns,
      steps: st.steps,
      lastActivityAt: st.lastActivityAt,
      failures: st.failures,
      readFiles,
    },
    tokens: {
      latestInput: st.tokens.latestInput,
      latestCache: st.tokens.latestCache,
      totalOutput: st.tokens.output,
      totalInput: st.tokens.input,
      totalCache: st.tokens.cache,
      history: st.tokens.history.slice(-40),
    },
    breakdown: buildContextBreakdown(st, eco),
    computerUse: {
      ...cu,
      actions: st.cuCount || 0,
      lastActionAt: st.cuLastAt || '',
      lastShot: st.lastShot ? { path: st.lastShot.path, uri: st.lastShot.uri, at: st.lastShot.at, source: st.lastShot.source } : null,
    },
    timeline: st.timeline.slice(-TIMELINE_MAX).reverse(),
    subagents: st.subagents.slice(-10).reverse(),
    outputs: { files: outFiles.slice(0, 60), artifacts: arts.slice(0, 60) },
    connectors: eco.mcpServers,
    skills: eco.skills.map(({ name, description, source, disabled, path, uri, tokens }) => ({ name, description, source, disabled, path, uri, tokens })),
    plugins: eco.plugins,
    rules: eco.rules,
    snippets,
  };
}

// ---------------------------------------------------------------------------
// 快捷指令卡片
// ---------------------------------------------------------------------------

function getSnippetsFile() { return join(getDataStorageDir(), 'pinned_context.json'); }

function loadSnippets() {
  const f = getSnippetsFile();
  if (!existsSync(f)) return DEFAULT_SNIPPETS;
  try {
    const p = JSON.parse(readFileSync(f, 'utf-8'));
    if (Array.isArray(p?.snippets)) return p.snippets;
  } catch {}
  return DEFAULT_SNIPPETS;
}

function saveSnippets(snippets) {
  const f = getSnippetsFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ snippets }, null, 2), 'utf-8');
}

const jsonError = (status, error) => new Response(JSON.stringify({ error }), { status, contentType: 'application/json' });

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const app = new SidecarApp();

// 给静态资源加上修改时间作为版本号，避免 webview 缓存旧的 CSS / JS
app.page('/', () => {
  const v = (f) => Math.round(statSafe(join(__dirname, f)).mtime);
  return readFileSync(join(__dirname, 'index.html'), 'utf-8')
    .replace('/styles.css', `/styles.css?v=${v('styles.css')}`)
    .replace('/app.js', `/app.js?v=${v('app.js')}`);
});
app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), { contentType: 'text/css' }), 'GET');
app.api('/app.js', () => new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), { contentType: 'application/javascript' }), 'GET');

app.api('/api/context', (data) => {
  let ws = [];
  if (typeof data.workspaceUris === 'string' && data.workspaceUris.trim()) {
    try { const p = JSON.parse(data.workspaceUris); if (Array.isArray(p)) ws = p; } catch {}
  } else if (Array.isArray(data.workspaceUris)) ws = data.workspaceUris;
  return buildSnapshot({
    requestedId: typeof data.conversationId === 'string' ? data.conversationId : '',
    hostId: typeof data.hostConversationId === 'string' ? data.hostConversationId : '',
    workspaceUris: ws,
    etag: typeof data.etag === 'string' ? data.etag : '',
  });
}, 'GET');

app.api('/api/preview', (data) => {
  const target = normalizePath(typeof data.path === 'string' ? data.path : '');
  if (!target || !allowedPreviewPaths.has(target)) return jsonError(403, '该文件不在当前会话或配置的白名单中');
  const st = statSafe(target);
  if (!st.isFile) return jsonError(404, '文件不存在或已被移动');
  const ext = extname(target).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.zip', '.exe', '.dll', '.woff', '.woff2'].includes(ext)) {
    return { path: target, name: basename(target), isBinary: true, size: st.size, content: `二进制或媒体文件（${ext}），请点“打开”在侧栏查看。`, truncated: false };
  }
  try {
    const buf = readFileSync(target);
    const slice = buf.subarray(0, PREVIEW_MAX_BYTES);
    if (slice.includes(0)) return { path: target, name: basename(target), isBinary: true, size: st.size, content: '检测到二进制内容，无法文本预览。', truncated: false };
    return { path: target, name: basename(target), isBinary: false, size: st.size, content: slice.toString('utf-8'), truncated: buf.length > PREVIEW_MAX_BYTES };
  } catch (err) { return jsonError(500, err.message); }
}, 'GET');

// Agent 最近看到的画面（只允许快照里出现过的截图文件）
app.api('/api/image', (data) => {
  const target = normalizePath(typeof data.path === 'string' ? data.path : '');
  if (!target || !allowedImagePaths.has(target)) return jsonError(403, '不允许访问该图片');
  const ext = extname(target).toLowerCase();
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
  if (!type) return jsonError(400, '不是图片');
  try {
    return new Response(readFileSync(target), { contentType: type, headers: { 'Cache-Control': 'max-age=3600' } });
  } catch (err) { return jsonError(404, err.message); }
}, 'GET');

app.api('/api/snippets', (data) => {
  const snippets = [...loadSnippets()];
  const action = String(data.action || '');
  const item = data.snippet && typeof data.snippet === 'object' ? data.snippet : {};
  if (action === 'add') {
    const title = String(item.title || '').trim();
    const content = String(item.content || '').trim();
    if (!title || !content) return jsonError(400, '标题和内容不能为空');
    snippets.unshift({ id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: title.slice(0, 80), tag: String(item.tag || '自定义').trim().slice(0, 24), content: content.slice(0, 8000), updatedAt: new Date().toISOString() });
    saveSnippets(snippets);
    return { ok: true, snippets };
  }
  if (action === 'update') {
    const i = snippets.findIndex((s) => s.id === String(item.id || ''));
    if (i < 0) return jsonError(404, '未找到该卡片');
    snippets[i] = { ...snippets[i], title: String(item.title || snippets[i].title).trim().slice(0, 80), tag: String(item.tag ?? snippets[i].tag).trim().slice(0, 24), content: String(item.content || snippets[i].content).trim().slice(0, 8000), updatedAt: new Date().toISOString() };
    saveSnippets(snippets);
    return { ok: true, snippets };
  }
  if (action === 'delete') {
    const id = String(item.id || data.id || '');
    const filtered = snippets.filter((s) => s.id !== id);
    saveSnippets(filtered);
    return { ok: true, snippets: filtered };
  }
  return jsonError(400, '不支持的操作');
}, 'POST');

app.api('/api/save-rule', (data) => {
  const target = normalizePath(typeof data.path === 'string' ? data.path : '');
  if (!target || !allowedRulePaths.has(target)) return jsonError(403, '只能写入规则文件');
  const content = typeof data.content === 'string' ? data.content : '';
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    allowedPreviewPaths.add(target);
    return { ok: true, path: target };
  } catch (err) { return jsonError(500, err.message); }
}, 'POST');

// 供自测使用：node main.mjs --selftest <transcript.jsonl>
export { readConversation, scanEcosystem, buildContextBreakdown, describeTool, resultStatus, estTokens };

if (!process.argv.includes('--selftest')) app.run();
