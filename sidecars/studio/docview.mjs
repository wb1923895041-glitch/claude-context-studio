/**
 * 文档预览：把 docx / xlsx / pptx 转成可在面板里显示的 HTML。零依赖：
 * Office 文件就是 zip + XML，用 Node 自带的 zlib 解压，再用一个小型 XML 解析器读取。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const cache = new Map();
  return {
    has: (n) => entries.has(n),
    names: () => [...entries.keys()],
    read(name) {
      if (cache.has(name)) return cache.get(name);
      const e = entries.get(name);
      if (!e) return null;
      const lp = e.local;
      const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
      const raw = buf.subarray(start, start + e.compSize);
      const data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? inflateRawSync(raw) : null;
      cache.set(name, data);
      return data;
    },
    text(name) { const d = this.read(name); return d ? d.toString('utf8') : ''; },
  };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()] ?? m;
});

export function parseXml(src) {
  const root = { n: '#root', a: {}, c: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.c.push({ n: '#text', t: m[1] });
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const a = {};
      let am;
      attrRe.lastIndex = 0;
      while ((am = attrRe.exec(m[4] || ''))) a[am[1]] = decode(am[2] ?? am[3] ?? '');
      const node = { n: m[3], a, c: [] };
      top.c.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] != null) {
      if (/\S/.test(m[6]) || top.n === 'w:t' || top.n === 'a:t' || top.n === 't' || top.n === 'm:t') top.c.push({ n: '#text', t: decode(m[6]) });
    }
  }
  return root;
}

const kids = (node, name) => (node?.c || []).filter((x) => x.n === name);
const kid = (node, name) => (node?.c || []).find((x) => x.n === name);
const path_ = (node, ...names) => names.reduce((n, nm) => kid(n, nm), node);
const textOf = (node) => (node?.n === '#text' ? node.t : (node?.c || []).map(textOf).join(''));
function findAll(node, name, out = []) {
  for (const c of node?.c || []) { if (c.n === name) out.push(c); else findAll(c, name, out); }
  return out;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function relsOf(zip, partPath) {
  const dir = posix.dirname(partPath);
  const relPath = posix.join(dir, '_rels', `${posix.basename(partPath)}.rels`);
  const map = {};
  const x = zip.text(relPath);
  if (!x) return map;
  for (const r of findAll(parseXml(x), 'Relationship')) {
    const target = r.a.Target || '';
    map[r.a.Id] = { target: r.a.TargetMode === 'External' ? target : posix.normalize(posix.join(dir, target)).replace(/^\//, ''), external: r.a.TargetMode === 'External', type: r.a.Type || '' };
  }
  return map;
}

export const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
// 图片不内嵌进页面（大 PPT 会有几百 MB），而是由渲染时传入的 mediaUrl 生成按需加载的地址
let mediaUrl = null;
function imageUri(zip, target) {
  const ext = (target.split('.').pop() || '').toLowerCase();
  if (!MIME[ext] || !zip.has(target)) return '';
  if (mediaUrl) return mediaUrl(target);
  const data = zip.read(target);
  return data && data.length <= 8 * 1024 * 1024 ? `data:${MIME[ext]};base64,${data.toString('base64')}` : '';
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

function docxStyles(zip) {
  const styles = {};
  const x = zip.text('word/styles.xml');
  if (!x) return styles;
  for (const s of findAll(parseXml(x), 'w:style')) {
    const id = s.a['w:styleId'];
    const name = (path_(s, 'w:name')?.a['w:val'] || '').toLowerCase();
    const based = path_(s, 'w:basedOn')?.a['w:val'];
    const lvl = path_(s, 'w:pPr', 'w:outlineLvl')?.a['w:val'];
    let heading = 0;
    const hm = name.match(/^(?:heading|标题)\s*(\d)/) || id.match(/^(?:Heading|heading)(\d)$/);
    if (hm) heading = Number(hm[1]);
    else if (name === 'title' || name === '标题') heading = 1;
    else if (lvl != null && Number(lvl) < 6) heading = Number(lvl) + 1;
    styles[id] = { heading, based };
  }
  // 继承：基于标题样式的自定义样式也算标题
  for (const st of Object.values(styles)) {
    let b = st.based;
    let guard = 0;
    while (!st.heading && b && styles[b] && guard++ < 10) { st.heading = styles[b].heading; b = styles[b].based; }
  }
  return styles;
}

function docxNumbering(zip) {
  const x = zip.text('word/numbering.xml');
  const abs = {};
  const nums = {};
  if (!x) return { fmt: () => null };
  const root = parseXml(x);
  for (const an of findAll(root, 'w:abstractNum')) {
    const lv = {};
    for (const l of kids(an, 'w:lvl')) lv[l.a['w:ilvl']] = { fmt: path_(l, 'w:numFmt')?.a['w:val'] || 'decimal', text: path_(l, 'w:lvlText')?.a['w:val'] || '' };
    abs[an.a['w:abstractNumId']] = lv;
  }
  for (const n of findAll(root, 'w:num')) nums[n.a['w:numId']] = path_(n, 'w:abstractNumId')?.a['w:val'];
  return { fmt: (numId, ilvl) => abs[nums[numId]]?.[ilvl] || null };
}

const CN = '〇一二三四五六七八九十';
function numText(fmt, n) {
  switch (fmt) {
    case 'bullet': return '•';
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerRoman': case 'upperRoman': {
      const r = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
      let s = ''; let v = n; for (const [k, t] of r) while (v >= k) { s += t; v -= k; }
      return fmt === 'upperRoman' ? s.toUpperCase() : s;
    }
    case 'chineseCounting': case 'chineseCountingThousand': case 'ideographTraditional':
      return n <= 10 ? CN[n] : n < 20 ? `十${n % 10 ? CN[n % 10] : ''}` : String(n);
    default: return String(n);
  }
}

function runStyle(rPr) {
  if (!rPr) return { open: '', close: '' };
  const css = [];
  let open = '';
  let close = '';
  const on = (name) => { const e = kid(rPr, name); return e && e.a['w:val'] !== '0' && e.a['w:val'] !== 'false'; };
  if (on('w:b')) { open += '<b>'; close = '</b>' + close; }
  if (on('w:i')) { open += '<i>'; close = '</i>' + close; }
  if (kid(rPr, 'w:u') && kid(rPr, 'w:u').a['w:val'] !== 'none') css.push('text-decoration:underline');
  if (on('w:strike')) css.push('text-decoration:line-through');
  const color = kid(rPr, 'w:color')?.a['w:val'];
  if (color && /^[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== '000000') css.push(`color:#${color}`);
  const hl = kid(rPr, 'w:highlight')?.a['w:val'];
  if (hl && hl !== 'none') css.push(`background:${hl}`);
  const sz = Number(kid(rPr, 'w:sz')?.a['w:val']);
  if (sz) css.push(`font-size:${sz / 2}pt`);
  const va = kid(rPr, 'w:vertAlign')?.a['w:val'];
  if (va === 'superscript') { open += '<sup>'; close = '</sup>' + close; }
  if (va === 'subscript') { open += '<sub>'; close = '</sub>' + close; }
  if (css.length) { open = `<span style="${css.join(';')}">` + open; close += '</span>'; }
  return { open, close };
}

function renderDocx(zip) {
  const styles = docxStyles(zip);
  const numbering = docxNumbering(zip);
  const rels = relsOf(zip, 'word/document.xml');
  const counters = {};
  const doc = parseXml(zip.text('word/document.xml'));
  const body = path_(doc, 'w:document', 'w:body');
  if (!body) throw new Error('docx 里没有正文');

  const inline = (node) => {
    let html = '';
    for (const c of node.c || []) {
      switch (c.n) {
        case 'w:r': {
          const st = runStyle(kid(c, 'w:rPr'));
          let inner = '';
          for (const x of c.c) {
            if (x.n === 'w:t') inner += esc(textOf(x));
            else if (x.n === 'w:tab') inner += '&emsp;';
            else if (x.n === 'w:br' || x.n === 'w:cr') inner += '<br>';
            else if (x.n === 'w:sym') inner += esc(String.fromCharCode(parseInt(x.a['w:char'] || '20', 16)));
            else if (x.n === 'w:drawing' || x.n === 'w:pict' || x.n === 'mc:AlternateContent') {
              for (const b of [...findAll(x, 'a:blip'), ...findAll(x, 'v:imagedata')]) {
                const rid = b.a['r:embed'] || b.a['r:id'];
                const t = rels[rid];
                if (t && !t.external) { const uri = imageUri(zip, t.target); if (uri) { inner += `<img src="${uri}" alt="">`; break; } }
              }
            }
          }
          html += inner ? st.open + inner + st.close : '';
          break;
        }
        case 'w:hyperlink': {
          const t = rels[c.a['r:id']];
          const href = t?.external && /^(https?:|mailto:)/i.test(t.target) ? t.target : '';
          html += href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inline(c)}</a>` : inline(c);
          break;
        }
        case 'w:ins': case 'w:smartTag': case 'w:fldSimple': case 'w:customXml': case 'w:sdtContent': case 'w:bdo': case 'w:dir':
          html += inline(c); break;
        case 'w:sdt': html += inline(kid(c, 'w:sdtContent') || { c: [] }); break;
        case 'm:oMath': case 'm:oMathPara':
          html += `<i class="math">${esc(findAll(c, 'm:t').map(textOf).join(''))}</i>`; break;
        default: break;
      }
    }
    return html;
  };

  const para = (p) => {
    const pPr = kid(p, 'w:pPr');
    const styleId = path_(pPr, 'w:pStyle')?.a['w:val'];
    const heading = styles[styleId]?.heading || 0;
    const jc = path_(pPr, 'w:jc')?.a['w:val'];
    const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : '';
    let prefix = '';
    const numPr = path_(pPr, 'w:numPr');
    let indent = 0;
    if (numPr) {
      const numId = path_(numPr, 'w:numId')?.a['w:val'];
      const ilvl = path_(numPr, 'w:ilvl')?.a['w:val'] || '0';
      const lv = numbering.fmt(numId, ilvl);
      if (lv && numId !== '0') {
        const key = `${numId}`;
        counters[key] ||= [];
        const arr = counters[key];
        const li = Number(ilvl);
        arr[li] = (arr[li] || 0) + 1;
        arr.length = li + 1;
        indent = li;
        prefix = lv.fmt === 'bullet' ? '•' : (lv.text || `%${li + 1}.`).replace(/%(\d)/g, (m, d) => numText(lv.fmt, arr[Number(d) - 1] || 1));
        prefix = `<span class="num">${esc(prefix)}</span>`;
      }
    }
    const inner = inline(p);
    const tag = heading ? `h${Math.min(heading, 6)}` : 'p';
    const st = [align && `text-align:${align}`, indent && `margin-left:${indent * 1.5}em`].filter(Boolean).join(';');
    if (!inner && !prefix) return '<p class="empty"></p>';
    return `<${tag}${st ? ` style="${st}"` : ''}>${prefix}${inner}</${tag}>`;
  };

  const table = (tbl) => {
    const rows = kids(tbl, 'w:tr');
    const grid = []; // grid[r][col] = cell 对象或 'merged'
    const cells = [];
    rows.forEach((tr, r) => {
      grid[r] = [];
      let col = 0;
      for (const tc of kids(tr, 'w:tc')) {
        while (grid[r][col]) col++;
        const tcPr = kid(tc, 'w:tcPr');
        const span = Number(path_(tcPr, 'w:gridSpan')?.a['w:val']) || 1;
        const vm = path_(tcPr, 'w:vMerge');
        const fill = path_(tcPr, 'w:shd')?.a['w:fill'];
        if (vm && vm.a['w:val'] !== 'restart') {
          // 向上找同列的起始单元格
          for (let up = r - 1; up >= 0; up--) {
            const above = grid[up][col];
            if (above && above !== 'merged') { above.rowspan++; break; }
          }
          for (let k = 0; k < span; k++) grid[r][col + k] = 'merged';
        } else {
          const cell = { tc, span, rowspan: 1, fill, r };
          cells.push(cell);
          grid[r][col] = cell;
          for (let k = 1; k < span; k++) grid[r][col + k] = 'merged';
        }
        col += span;
      }
    });
    let html = '<div class="tbl"><table>';
    rows.forEach((tr, r) => {
      html += '<tr>';
      for (const cell of grid[r]) {
        if (!cell || cell === 'merged' || cell.r !== r) continue;
        const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}${cell.fill && /^[0-9a-f]{6}$/i.test(cell.fill) ? ` style="background:#${cell.fill}"` : ''}`;
        html += `<td${attrs}>${blocks(cell.tc)}</td>`;
      }
      html += '</tr>';
    });
    return html + '</table></div>';
  };

  const blocks = (node) => {
    let html = '';
    for (const c of node.c || []) {
      if (c.n === 'w:p') html += para(c);
      else if (c.n === 'w:tbl') html += table(c);
      else if (c.n === 'w:sdt') html += blocks(kid(c, 'w:sdtContent') || { c: [] });
      else if (c.n === 'w:customXml') html += blocks(c);
    }
    return html;
  };

  return blocks(body);
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const rowIndex = (ref) => Number(ref.replace(/[A-Z]+/gi, '')) - 1;
const MAX_ROWS = 2000;
const MAX_COLS = 80;

function renderXlsx(zip) {
  const wb = parseXml(zip.text('xl/workbook.xml'));
  const rels = relsOf(zip, 'xl/workbook.xml');
  const shared = findAll(parseXml(zip.text('xl/sharedStrings.xml') || '<sst/>'), 'si').map((si) => findAll(si, 't').map(textOf).join(''));
  const sheets = findAll(wb, 'sheet').map((s) => ({ name: s.a.name, target: rels[s.a['r:id']]?.target })).filter((s) => s.target && zip.has(s.target));
  const parts = sheets.map((s, i) => {
    const x = parseXml(zip.text(s.target));
    const data = [];
    let maxC = 0;
    let truncated = false;
    for (const row of findAll(x, 'row')) {
      const r = Number(row.a.r || data.length + 1) - 1;
      if (r >= MAX_ROWS) { truncated = true; break; }
      for (const c of kids(row, 'c')) {
        const ci = c.a.r ? colIndex(c.a.r) : 0;
        if (ci >= MAX_COLS) { truncated = true; continue; }
        const t = c.a.t;
        let v = textOf(kid(c, 'v'));
        if (t === 's') v = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') v = findAll(c, 't').map(textOf).join('');
        else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (v && /^-?\d+\.\d{6,}$/.test(v)) v = String(Number(Number(v).toPrecision(10)));
        (data[r] ||= [])[ci] = v;
        if (ci + 1 > maxC) maxC = ci + 1;
      }
    }
    const merges = findAll(x, 'mergeCell').map((m) => m.a.ref.split(':')).map(([a, b]) => ({ r1: rowIndex(a), c1: colIndex(a), r2: rowIndex(b || a), c2: colIndex(b || a) }));
    const skip = new Set();
    const spanAt = {};
    for (const m of merges) {
      spanAt[`${m.r1},${m.c1}`] = m;
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) skip.add(`${r},${c}`);
    }
    let html = `<div class="sheet${i ? ' hidden' : ''}" data-sheet="${i}"><div class="tbl"><table class="xl"><tr><th></th>`;
    for (let c = 0; c < maxC; c++) html += `<th>${esc(colName(c))}</th>`;
    html += '</tr>';
    for (let r = 0; r < data.length; r++) {
      html += `<tr><th>${r + 1}</th>`;
      for (let c = 0; c < maxC; c++) {
        if (skip.has(`${r},${c}`)) continue;
        const m = spanAt[`${r},${c}`];
        const v = data[r]?.[c] ?? '';
        const num = v !== '' && !Number.isNaN(Number(v));
        html += `<td${m ? `${m.c2 > m.c1 ? ` colspan="${m.c2 - m.c1 + 1}"` : ''}${m.r2 > m.r1 ? ` rowspan="${m.r2 - m.r1 + 1}"` : ''}` : ''}${num ? ' class="n"' : ''}>${esc(v)}</td>`;
      }
      html += '</tr>';
    }
    html += '</table></div>';
    if (truncated) html += `<p class="note">只显示前 ${MAX_ROWS} 行 / ${MAX_COLS} 列</p>`;
    return html + '</div>';
  });
  const tabs = sheets.length > 1 ? `<div class="tabs">${sheets.map((s, i) => `<button type="button" data-tab="${i}"${i ? '' : ' class="on"'}>${esc(s.name)}</button>`).join('')}</div>` : '';
  return tabs + parts.join('');
}
function colName(c) { let s = ''; c += 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

function renderPptx(zip) {
  const pres = parseXml(zip.text('ppt/presentation.xml'));
  const rels = relsOf(zip, 'ppt/presentation.xml');
  const slides = findAll(pres, 'p:sldId').map((s) => rels[s.a['r:id']]?.target).filter((t) => t && zip.has(t));
  const textBody = (tb) => kids(tb, 'a:p').map((p) => {
    const t = (p.c || []).map((x) => (x.n === 'a:r' || x.n === 'a:fld' ? esc(findAll(x, 'a:t').map(textOf).join('')) : x.n === 'a:br' ? '<br>' : '')).join('');
    const lvl = Number(path_(p, 'a:pPr')?.a.lvl || 0);
    const bullet = path_(p, 'a:pPr', 'a:buNone') ? '' : '';
    return t ? `<p style="margin-left:${lvl * 1.2}em">${bullet}${t}</p>` : '';
  }).join('');
  return slides.map((target, i) => {
    const srels = relsOf(zip, target);
    const tree = path_(parseXml(zip.text(target)), 'p:sld', 'p:cSld', 'p:spTree');
    const out = [];
    const walk = (node) => {
      for (const c of node?.c || []) {
        if (c.n === 'p:sp') {
          const isTitle = /title/i.test(findAll(c, 'p:ph')[0]?.a.type || '');
          const body = kid(c, 'p:txBody');
          const html = body ? textBody(body) : '';
          if (html) out.push(isTitle ? `<div class="slide-title">${html}</div>` : html);
        } else if (c.n === 'p:pic') {
          const rid = findAll(c, 'a:blip')[0]?.a['r:embed'];
          const t = srels[rid];
          const uri = t && !t.external ? imageUri(zip, t.target) : '';
          if (uri) out.push(`<img src="${uri}" alt="">`);
        } else if (c.n === 'p:graphicFrame') {
          const tbl = findAll(c, 'a:tbl')[0];
          if (tbl) out.push(`<div class="tbl"><table>${kids(tbl, 'a:tr').map((tr) => `<tr>${kids(tr, 'a:tc').filter((tc) => !tc.a.hMerge && !tc.a.vMerge).map((tc) => `<td${tc.a.gridSpan ? ` colspan="${tc.a.gridSpan}"` : ''}${tc.a.rowSpan ? ` rowspan="${tc.a.rowSpan}"` : ''}>${textBody(kid(tc, 'a:txBody') || { c: [] })}</td>`).join('')}</tr>`).join('')}</table></div>`);
        } else if (c.n === 'p:grpSp') walk(c);
      }
    };
    walk(tree);
    return `<section class="slide"><div class="slide-no">第 ${i + 1} 页</div>${out.join('') || '<p class="note">（本页没有文字或图片）</p>'}</section>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export const DOC_EXT = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i;

const PAGE_CSS = `
:root{color-scheme:light}
body{margin:0;background:#f3f3f1;font:14px/1.7 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:#1f1f1f}
.page{max-width:860px;margin:16px auto;background:#fff;padding:40px 48px;box-shadow:0 1px 4px rgba(0,0,0,.12);border-radius:4px}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.1em 0 .5em}h1{font-size:1.7em}h2{font-size:1.4em}h3{font-size:1.2em}h4,h5,h6{font-size:1.05em}
p{margin:.35em 0}p.empty{min-height:.8em}.num{display:inline-block;min-width:1.6em;color:#555}
img{max-width:100%;height:auto;display:block;margin:6px auto}
.tbl{overflow-x:auto;margin:10px 0}table{border-collapse:collapse;min-width:40%;font-size:13px}
td,th{border:1px solid #c9c9c9;padding:4px 8px;vertical-align:top}td p{margin:0}
table.xl{font-size:12.5px;background:#fff}table.xl th{background:#f0f0f0;color:#666;font-weight:500;position:sticky;top:0}
table.xl td.n{text-align:right;font-variant-numeric:tabular-nums}
.tabs{position:sticky;top:0;background:#f3f3f1;padding:8px 0;display:flex;gap:4px;flex-wrap:wrap;z-index:2}
.tabs button{border:1px solid #ccc;background:#fff;border-radius:6px;padding:3px 10px;font:inherit;font-size:12.5px;cursor:pointer}.tabs button.on{background:#1f1f1f;color:#fff;border-color:#1f1f1f}
.hidden{display:none}.note{color:#888;font-size:12px}.math{font-family:"Cambria Math",serif}
.slide{background:#fff;margin:14px auto;max-width:860px;padding:24px 32px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.slide-no{color:#999;font-size:12px;margin-bottom:6px}.slide-title p{font-size:1.4em;font-weight:600}
a{color:#2563eb}
`;
const TAB_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-tab]');if(!b)return;document.querySelectorAll('[data-tab]').forEach(function(x){x.classList.toggle('on',x===b)});document.querySelectorAll('[data-sheet]').forEach(function(s){s.classList.toggle('hidden',s.dataset.sheet!==b.dataset.tab)})});`;

/** 读取（带缓存）某个文档里的一个部件，供图片接口使用。 */
const zipCache = new Map();
export function openOffice(file, mtime) {
  const key = `${file}|${mtime}`;
  if (zipCache.has(key)) return zipCache.get(key);
  const zip = readZip(readFileSync(file));
  zipCache.set(key, zip);
  while (zipCache.size > 3) zipCache.delete(zipCache.keys().next().value);
  return zip;
}

/** 返回完整 HTML 文档。toMediaUrl(part) 给出图片地址；不传则把图片内嵌为 data URI。 */
export function renderOfficeFile(file, { mtime = 0, toMediaUrl = null } = {}) {
  const zip = openOffice(file, mtime);
  const ext = file.split('.').pop().toLowerCase();
  let inner;
  let wrap = true;
  mediaUrl = toMediaUrl;
  try {
    if (ext.startsWith('doc')) inner = renderDocx(zip);
    else if (ext.startsWith('xls')) { inner = renderXlsx(zip); wrap = false; }
    else if (ext.startsWith('ppt')) { inner = renderPptx(zip); wrap = false; }
    else throw new Error('不支持的文件类型');
  } finally { mediaUrl = null; }
  const body = wrap ? `<div class="page">${inner}</div>` : `<div style="padding:0 12px">${inner}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>${body}${ext.startsWith('xls') ? `<script>${TAB_JS}</script>` : ''}</body></html>`;
}
