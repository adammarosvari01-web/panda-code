#!/usr/bin/env node
// Panda Code - a terminal coding agent for local AI models.
// Zero dependencies. Works with Ollama (native API) and any OpenAI-compatible
// server (LM Studio, llama.cpp, Jan, vLLM, KoboldCpp, OpenRouter, ...).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const readline = require('readline');
const { AsyncLocalStorage } = require('async_hooks');

const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const HOME_DIR = path.join(os.homedir(), '.panda');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
const HISTORY_PATH = path.join(HOME_DIR, 'history.json');
const SESSIONS_DIR = path.join(HOME_DIR, 'sessions');
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.mypy_cache', '.pytest_cache']);
const SHELL_TOOL = IS_WIN ? 'PowerShell' : 'Bash';
const CWD_MARK = '__PANDA_CWD__';

// ───────────────────────────── colors ─────────────────────────────
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (o, c) => s => useColor ? `\x1b[${o}m${s}\x1b[${c}m` : String(s);
const rgb = (r, g, b) => esc(`38;2;${r};${g};${b}`, '39');
const C = {
  bamboo: rgb(122, 201, 92), leaf: rgb(178, 226, 128), white: rgb(240, 240, 240), ink: rgb(80, 80, 88),
  gray: rgb(135, 135, 140), red: rgb(235, 105, 105), green: rgb(120, 205, 120), yellow: rgb(235, 195, 90),
  blue: rgb(120, 170, 235), pink: rgb(240, 150, 180), cyan: rgb(110, 200, 205),
  bold: esc('1', '22'), dim: esc('2', '22'), italic: esc('3', '23'), strike: esc('9', '29'),
  bgDel: esc('48;2;80;25;30', '49'), bgAdd: esc('48;2;25;70;35', '49'),
};
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const fmtK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
// Per-run context: the /btw side agent runs next to the main agent, with its own output sink, model and spinner.
const als = new AsyncLocalStorage();
const curModel = () => als.getStore()?.model || state.model;
const curNative = () => { const s = als.getStore(); return s && s.nativeTools !== undefined ? s.nativeTools : state.nativeTools; };
const setNative = v => { const s = als.getStore(); if (s && s.nativeTools !== undefined) s.nativeTools = v; else state.nativeTools = v; };
const NULLSP = { t: null, label: '', tokens: 0, start() { }, set() { }, stop() { }, clear() { }, draw() { } };
const SP = () => als.getStore()?.side ? NULLSP : spinner;

// ───────────────────────────── state ─────────────────────────────
const state = {
  cwd: process.cwd(),
  kind: 'ollama', baseUrl: '', apiKey: '', model: '', providerName: '',
  numCtx: 32768, think: null, showThinking: false, keepAlive: '30m',
  nativeTools: true,
  mode: 'default', // default | acceptEdits | plan | bypass
  allow: new Set(),
  read: new Map(), // abs path -> mtimeMs
  todos: [],
  shells: new Map(), shellSeq: 0,
  lastPrompt: 0, totalIn: 0, totalOut: 0, lastTps: 0,
  interactive: true,
};
let session = newSession();
let pendingContext = [];

function newSession() {
  return { id: new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6), cwd: state.cwd, created: Date.now(), messages: [], summary: '' };
}

// ───────────────────────────── config ─────────────────────────────
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function saveConfig() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const c = { kind: state.kind, baseUrl: state.baseUrl, apiKey: state.apiKey, model: state.model, providerName: state.providerName, numCtx: state.numCtx, think: state.think, showThinking: state.showThinking, keepAlive: state.keepAlive, pin: state.pin, mouse: state.mouse, imageUrl: state.imageUrl, imageKind: state.imageKind, repo: state.repo };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

// ───────────────────────────── output / spinner ─────────────────────────────
const VERBS = ['Munching bamboo', 'Chewing', 'Rolling around', 'Foraging', 'Pondering', 'Snacking', 'Climbing', 'Nibbling', 'Panda-ing', 'Somersaulting', 'Sniffing around', 'Lounging', 'Bamboozling', 'Cuddling the code', 'Napping on it', 'Crunching shoots'];
const FRAMES = ['◐', '◓', '◑', '◒'];
// ── animated panda: sits at the right edge of the terminal while Panda works, munching a bamboo stalk ──
const SPR = { K: [58, 58, 66], W: [245, 245, 245], P: [240, 150, 180], G: [96, 180, 76], L: [170, 222, 120], D: [60, 128, 60] };
const SPR_W = 20, SPR_H = 8;
function munchGrid(len, open) {
  const g = Array.from({ length: SPR_H }, () => Array(SPR_W).fill('.'));
  const put = (y, x, c) => { if (y >= 0 && y < SPR_H && x >= 0 && x < SPR_W) g[y][x] = c; };
  ['KK........KK', 'KKWWWWWWWWKK', '.WWWWWWWWWW.', '.WKKKWWKKKW.', '.WKWKWWKWKW.', '.WWWWKKWWWW.', '..WWWWWWWW..', '...WWWWWW...']
    .forEach((r, y) => [...r].forEach((c, x) => { if (c !== '.') put(y, x, c); }));
  if (open) { put(6, 4, 'K'); put(6, 5, 'P'); put(6, 6, 'P'); put(6, 7, 'K'); } // mouth open
  for (let x = 9; x < 9 + len && x < SPR_W; x++) { put(5, x, 'L'); put(6, x, (x - 9) % 4 === 3 ? 'D' : 'G'); } // the bamboo
  put(6, 8, 'K'); put(7, 8, 'K'); put(7, 9, 'K'); // paw holding it
  return g;
}
function sprRender(g) {
  const fg = c => `\x1b[38;2;${SPR[c].join(';')}m`, bg = c => `\x1b[48;2;${SPR[c].join(';')}m`, R = '\x1b[0m';
  const lines = [];
  for (let y = 0; y < g.length; y += 2) {
    let s = '';
    for (let x = 0; x < g[y].length; x++) {
      const t = g[y][x], b = g[y + 1][x];
      if (t === '.' && b === '.') s += ' ';
      else if (t === '.') s += fg(b) + '▄' + R;
      else if (b === '.') s += fg(t) + '▀' + R;
      else if (t === b) s += fg(t) + '█' + R;
      else s += fg(t) + bg(b) + '▀' + R;
    }
    lines.push(s);
  }
  return lines;
}
const SPR_CACHE = {};
function sprFrame(f) {
  const len = 11 - (Math.floor(f / 4) % 9); // the stalk gets shorter bite by bite, then a fresh one appears
  const open = f % 2 === 0;
  return SPR_CACHE[len * 2 + (open ? 1 : 0)] ||= sprRender(munchGrid(len, open));
}
const spinner = {
  t: null, label: '', t0: 0, i: 0, tokens: 0, drawn: 0,
  start(label) {
    this.label = label || VERBS[Math.floor(Math.random() * VERBS.length)];
    this.t0 = Date.now(); this.tokens = 0;
    if (!process.stdout.isTTY) return;
    clearInterval(this.t); this.drawn = 0; this.t = setInterval(() => this.draw(), 140); this.draw();
  },
  set(label) { this.label = label; },
  // The animated block (status text + munching panda) as rows of a given width, for the pinned layout.
  block(W) {
    const big = useColor && W >= 44;
    const avail = big ? W - SPR_W - 1 : W;
    const s = Math.floor((Date.now() - this.t0) / 1000);
    const extra = this.tokens ? ` · ↓ ${fmtK(this.tokens)} tokens` : '';
    const f = this.i;
    const head = C.bamboo(FRAMES[f % 4]) + ' ' + C.leaf(this.label + '…');
    let text = head + C.gray(` (${s}s${extra} · esc to interrupt)`);
    if (stripAnsi(text).length > avail) text = head + C.gray(` (${s}s)`);
    if (!big) return [text];
    return sprFrame(f).map((sp, idx) => { const left = idx === 1 ? text : ''; return left + ' '.repeat(Math.max(1, W - dispW(left) - SPR_W)) + sp; });
  },
  draw() {
    if (!this.t) return;
    if (hdr.on) { this.i++; schedulePaint(); return; }
    if (scr.on) return;
    const cols = (process.stdout.columns || 80) - 1;
    const big = useColor && cols >= 64;
    const avail = big ? cols - SPR_W - 1 : cols;
    const s = Math.floor((Date.now() - this.t0) / 1000);
    const extra = this.tokens ? ` · ↓ ${fmtK(this.tokens)} tokens` : '';
    const f = this.i++;
    const head = C.bamboo(FRAMES[f % 4]) + ' ' + C.leaf(this.label + '…');
    let text = head + C.gray(` (${s}s${extra} · esc to interrupt)`);
    if (stripAnsi(text).length > avail) text = head + C.gray(` (${s}s)`);
    let buf = (this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : '') + '\r\x1b[J';
    if (big) {
      const lines = sprFrame(f).map((sp, idx) => {
        const left = idx === 1 ? text : '';
        return left + ' '.repeat(Math.max(1, cols - stripAnsi(left).length - SPR_W)) + sp;
      });
      buf += lines.join('\n'); this.drawn = lines.length;
    } else { buf += text; this.drawn = 1; }
    process.stdout.write(buf);
  },
  clear() { if (hdr.on) return; if (this.t && this.drawn && !scr.on) { process.stdout.write((this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : '') + '\r\x1b[J'); this.drawn = 0; } },
  stop() { if (this.t) { clearInterval(this.t); this.clear(); this.t = null; if (hdr.on) schedulePaint(); } },
};
function out(s = '') {
  const st = als.getStore(); if (st && st.out) return st.out(s); // side-agent output goes to its own pane
  slog.add(s);
  if (hdr.on) { // pinned layout: add to the log and redraw
    if (scr.on) { // the user is scrolled back: keep the view still and just count what arrived
      const g = geom();
      let n = 0; for (const l of String(s).split('\n')) n += wrapCached(l, g.leftW).length;
      scr.off += n; scr.unread += n;
    }
    schedulePaint();
    return;
  }
  spinner.clear(); process.stdout.write(s + '\n'); spinner.draw();
}

// ───────────────────────────── markdown (line-streamed) ─────────────────────────────
function inline(s) {
  const parts = s.split(/(`[^`]+`)/);
  return parts.map(p => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return C.cyan(p.slice(1, -1));
    return p.replace(/\*\*([^*]+)\*\*/g, (m, t) => C.bold(t))
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, (m, a, t) => a + C.italic(t))
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (m, t, u) => t + ' ' + C.gray('(' + u + ')'));
  }).join('');
}
class MD {
  constructor(write, indent = '') { this.write = write; this.indent = indent; this.buf = ''; this.code = false; this.hide = false; this.think = false; this.first = true; }
  push(t) { this.buf += t; let i; while ((i = this.buf.indexOf('\n')) >= 0) { this.line(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); } }
  end() { if (this.buf) { this.line(this.buf); this.buf = ''; } }
  line(l) {
    l = l.replace(/\r$/, '');
    if (l.includes('<tool_call>')) this.hide = true;
    if (this.hide) { if (l.includes('</tool_call>')) this.hide = false; return; }
    if (l.includes('<think>')) { this.think = true; l = l.replace('<think>', ''); }
    if (this.think) {
      const endT = l.includes('</think>');
      const txt = l.replace('</think>', '');
      if (endT) this.think = false;
      if (state.showThinking && txt.trim()) this.write(this.indent + C.gray(C.italic('  ' + txt)));
      return;
    }
    if (this.first && !l.trim()) return;
    const prefix = this.first ? C.white('● ') : '  ';
    this.first = false;
    let f;
    if (/^\s*```/.test(l)) { this.code = !this.code; f = C.ink(l); }
    else if (this.code) f = C.leaf(l);
    else if (/^#{1,6}\s+/.test(l)) f = C.bold(C.bamboo(l.replace(/^#{1,6}\s+/, '')));
    else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) f = C.ink('─'.repeat(40));
    else if (/^\s*>\s?/.test(l)) f = C.gray('│ ') + C.italic(inline(l.replace(/^\s*>\s?/, '')));
    else f = inline(l.replace(/^(\s*)[-*+]\s+/, (m, sp) => sp + '• '));
    this.write(this.indent + prefix + f);
  }
}

// ───────────────────────────── panda art ─────────────────────────────
function pandaArt() {
  const px = [
    '..KKK......KKK..',
    '.KKKKWWWWWWKKKK.',
    '.KKKWWWWWWWWKKK.',
    '..WWWWWWWWWWWW..',
    '.WWKKKWWWWKKKWW.',
    '.WKKWKKWWKKWKKW.',
    '.WKKKKWWWWKKKKW.',
    '.WPWKKWWWWKKWPW.',
    '.WWWWWWKKWWWWWW.',
    '..WWWKWKKWKWWW..',
    '...WWWKWWKWWW...',
    '.....WWWWWW.....',
  ];
  if (!useColor) return ['  (o)___(o)  ', ' /  @   @  \\ ', '(     v     )', ' \\  \\_/   / ', '  `-------`  ', '             '];
  const col = { K: [62, 62, 70], W: [245, 245, 245], P: [240, 160, 185] };
  const fg = c => `\x1b[38;2;${col[c].join(';')}m`, bg = c => `\x1b[48;2;${col[c].join(';')}m`, R = '\x1b[0m';
  const lines = [];
  for (let y = 0; y < px.length; y += 2) {
    let s = '';
    for (let x = 0; x < px[y].length; x++) {
      const t = px[y][x], b = (px[y + 1] || '')[x] || '.';
      if (t === '.' && b === '.') s += ' ';
      else if (t === '.') s += fg(b) + '▄' + R;
      else if (b === '.') s += fg(t) + '▀' + R;
      else if (t === b) s += fg(t) + '█' + R;
      else s += fg(t) + bg(b) + '▀' + R;
    }
    lines.push(s);
  }
  return lines;
}
// ── pinned header ──
// The panda banner lives above the terminal's scroll region, so the conversation scrolls underneath it
// instead of pushing it off the screen. (Trade-off: lines that scroll away are not kept in the terminal's scrollback.)
const hdr = { on: false, h: 0, tip: '', resize: false };
function headerLines() {
  const rows = process.stdout.rows || 24, cols = (process.stdout.columns || 80) - 1;
  if (rows >= 28) { const b = banner().split('\n'); hdr.tip = b.pop(); return b; }
  hdr.tip = '';
  let l = '🐼 ' + C.bold(C.white('Panda Code')) + C.gray(' · ') + C.bamboo(state.model || '(no model)') + C.gray(' · ' + shortPath(state.cwd));
  if (stripAnsi(l).length > cols) l = C.gray(stripAnsi(l).slice(0, cols - 1) + '…');
  return [l, C.ink('─'.repeat(Math.min(cols, 60)))];
}
function pinHeader(clear = true) {
  if (!process.stdout.isTTY || !useColor || state.pin === false || process.env.PANDA_NO_PIN || (process.stdout.rows || 24) < 16) return false;
  const rows = process.stdout.rows || 24, lines = headerLines();
  hdr.on = true; hdr.h = lines.length; if (clear) slog.lines.length = 0;
  process.stdout.write((clear ? '\x1b[2J' : '') + '\x1b[H' + lines.map(l => l + '\x1b[K').join('\n') + `\x1b[${hdr.h + 1};${rows - 2}r\x1b[${rows};1H`);
  if (!hdr.resize) { hdr.resize = true; process.stdout.on('resize', () => { drawHeader(); paint(); }); }
  installMouseFilter(); setMouse(state.mouse !== false);
  return true;
}
function drawHeader() {
  if (!hdr.on) return;
  const rows = process.stdout.rows || 24, lines = headerLines();
  hdr.h = lines.length;
  process.stdout.write('\x1b7\x1b[H' + lines.map(l => l + '\x1b[K').join('\n') + `\x1b[${hdr.h + 1};${rows - 2}r\x1b8`);
}
function unpinHeader() {
  if (!hdr.on) return;
  scr.on = false; scr.saved = null; setMouse(false);
  hdr.on = false;
  process.stdout.write(`\x1b[r\x1b[${process.stdout.rows || 24};1H\n`);
}
process.on('exit', unpinHeader);

// ── scrollable history under the pinned banner ──
// The terminal throws away lines that scroll past a pinned banner, so Panda keeps its own copy of everything it prints
// and redraws it when you scroll back (PgUp / mouse wheel). End or Esc returns to the live view.
const slog = { lines: [], add(s) { for (const l of String(s).replace(/\r/g, '').split('\n')) this.lines.push(l.replace(/\t/g, '    ')); if (this.lines.length > 6000) this.lines.splice(0, this.lines.length - 4500); } };
const scr = { on: false, off: 0, unread: 0, saved: null };
function dispW(s) { let w = 0; for (const ch of stripAnsi(s)) w += cw(ch.codePointAt(0)); return w; } // display width of a string
function cw(cp) { // display width of a code point
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
// Splits one line (with colour codes) into terminal rows of at most `cols` columns, carrying colours across the breaks.
function wrapAnsi(s, cols) {
  const rows = [], st = { fg: '', bg: '', b: 0, d: 0, i: 0, s: 0 };
  let cur = '', w = 0;
  const styled = () => st.fg || st.bg || st.b || st.d || st.i || st.s;
  const open = () => (st.b ? '\x1b[1m' : '') + (st.d ? '\x1b[2m' : '') + (st.i ? '\x1b[3m' : '') + (st.s ? '\x1b[9m' : '') + st.fg + st.bg;
  const sgr = codes => {
    const c = codes === '' ? [0] : codes.split(';').map(Number);
    for (let j = 0; j < c.length; j++) {
      const n = c[j];
      if (n === 0) { st.fg = st.bg = ''; st.b = st.d = st.i = st.s = 0; }
      else if (n === 1) st.b = 1; else if (n === 2) st.d = 1; else if (n === 3) st.i = 1; else if (n === 9) st.s = 1;
      else if (n === 22) st.b = st.d = 0; else if (n === 23) st.i = 0; else if (n === 29) st.s = 0;
      else if (n === 39) st.fg = ''; else if (n === 49) st.bg = '';
      else if ((n === 38 || n === 48) && c[j + 1] === 2) { const v = `\x1b[${n};2;${c[j + 2]};${c[j + 3]};${c[j + 4]}m`; if (n === 38) st.fg = v; else st.bg = v; j += 4; }
      else if ((n === 38 || n === 48) && c[j + 1] === 5) { const v = `\x1b[${n};5;${c[j + 2]}m`; if (n === 38) st.fg = v; else st.bg = v; j += 2; }
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) st.fg = `\x1b[${n}m`;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) st.bg = `\x1b[${n}m`;
    }
  };
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) === 27 && s[i + 1] === '[') {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i, i + 48));
      if (m) { if (m[2] === 'm') { sgr(m[1]); cur += m[0]; } i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp); i += ch.length;
    const wd = cw(cp);
    if (wd && w + wd > cols) { rows.push(cur + (styled() ? '\x1b[0m' : '')); cur = open(); w = 0; }
    cur += ch; w += wd;
  }
  rows.push(cur + (styled() ? '\x1b[0m' : ''));
  return rows;
}
const wrapMemo = new Map();
function wrapCached(line, cols) {
  const k = cols + '|' + line;
  let r = wrapMemo.get(k);
  if (!r) { r = wrapAnsi(line, cols); if (wrapMemo.size > 30000) wrapMemo.clear(); wrapMemo.set(k, r); }
  return r;
}
function allRows(cols) { const a = []; for (const l of slog.lines) for (const r of wrapCached(l, cols)) a.push(r); return a; }
// Screen geometry in the pinned layout: banner on top, a drawing area, then a divider row and the prompt row at the bottom.
function geom() {
  const so = process.stdout, rows = so.rows || 24, cols = so.columns || 80;
  const top = hdr.h + 1, H = Math.max(3, rows - 2 - hdr.h);
  const sideW = side.width(cols);
  // one spare column at the right edge: writing into the very last column would make the following erase-to-end-of-line eat a character
  return { rows, cols, top, H, sideW, leftW: sideW ? cols - sideW - 1 : cols - 1 };
}
function viewBody() { return geom().H; }
function viewHint() {
  const cols = process.stdout.columns || 80;
  let t = ` ↑ ${scr.off} lines back · PgUp/PgDn/wheel scroll · End or Esc to return` + (scr.unread ? ` · ${scr.unread} new below` : '') + ' ';
  t = t.slice(0, Math.max(0, cols - 4));
  return C.bamboo('──') + C.leaf(t) + C.bamboo('─'.repeat(Math.max(0, Math.min(cols, 140) - 2 - t.length)));
}
// Everything on screen is drawn from Panda's own logs, so the prompt row stays free for typing while Panda works.
let paintTimer = null;
function schedulePaint() { if (!hdr.on || paintTimer) return; paintTimer = setTimeout(paint, 24); }
function mainRows(g) {
  const all = allRows(g.leftW);
  if (scr.on) { // scrolled back: show a window of the history
    scr.off = Math.min(Math.max(scr.off, 1), Math.max(1, all.length - g.H));
    const end = all.length - scr.off;
    return all.slice(Math.max(0, end - g.H), end);
  }
  const spin = spinner.t ? spinner.block(g.leftW) : []; // the munching panda sits right after the latest output
  return all.slice(-Math.max(1, g.H - spin.length)).concat(spin);
}
function paint() {
  if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
  if (!hdr.on) return;
  const so = process.stdout, g0 = geom();
  const mn = ui.menuLines ? Math.min(ui.menuLines.length, g0.H - 3) : 0; // an open menu takes rows at the bottom; the output above shrinks to make room
  const g = { ...g0, H: g0.H - mn };
  const left = mainRows(g), right = g.sideW ? side.rows(g.sideW - 1, g.H) : null;
  let buf = '\x1b[?25l';
  for (let r = 0; r < g.H; r++) {
    const l = left[r] ?? '';
    buf += `\x1b[${g.top + r};1H` + (right ? l + ' '.repeat(Math.max(0, g.leftW - dispW(l))) + '\x1b[0m' + C.ink('│') + (right[r] ?? '') : l) + '\x1b[0m\x1b[K';
  }
  for (let i = 0; i < mn; i++) buf += `\x1b[${g.top + g.H + i};1H\x1b[2K` + ui.menuLines[i] + '\x1b[0m';
  buf += `\x1b[${g.rows - 1};1H\x1b[2K` + (scr.on ? viewHint() : ui.dividerStr()) + '\x1b[0m';
  if (!scr.on && !ui.inSelect) {
    const p = ui.rl ? ui.rl.getCursorPos() : { cols: 0 };
    buf += `\x1b[${g.rows};${Math.min(g.cols, p.cols + 1)}H\x1b[?25h`;
  }
  so.write(buf);
}
function drawHint() { schedulePaint(); }
function drawView() { paint(); }
function enterView() {
  if (scr.on || !hdr.on || ui.pending || ui.inSelect) return false;
  const g = geom();
  if (allRows(g.leftW).length <= g.H) return false; // everything is already on screen
  scr.on = true; scr.off = 0; scr.unread = 0;
  scr.saved = process.stdin.listeners('keypress');
  process.stdin.removeAllListeners('keypress'); // detach the line editor so arrow keys don't walk through prompt history
  process.stdin.on('keypress', viewKey);
  return true;
}
function exitView(pass) {
  if (!scr.on) return;
  scr.on = false;
  process.stdin.removeListener('keypress', viewKey);
  for (const l of scr.saved || []) process.stdin.on('keypress', l);
  scr.saved = null;
  paint();
  if (pass) process.stdin.emit('keypress', pass[0], pass[1]);
}
function scrollView(n) {
  if (!scr.on && !enterView()) return;
  scr.off += n;
  if (scr.off <= 0) { exitView(); return; }
  paint();
}
function viewKey(s, k) {
  if (!k) return;
  const n = k.name;
  if (n === 'pageup') scrollView(viewBody() - 2);
  else if (n === 'pagedown') scrollView(-(viewBody() - 2));
  else if (n === 'up') scrollView(1);
  else if (n === 'down') scrollView(-1);
  else if (n === 'home') scrollView(1e9);
  else if (n === 'end' || n === 'escape' || s === 'q') exitView();
  else exitView([s, k]); // any other key: go back to the live view and let the key through
}
function onWheel(btn) {
  if (!(btn & 64) || ui.pending || ui.inSelect) return;
  if ((btn & 1) === 0) scrollView(3); else if (scr.on) scrollView(-3);
}
function setMouse(on) {
  hdr.mouse = !!on;
  if (process.stdout.isTTY) process.stdout.write(on ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
}
let mouseFilterOn = false;
function installMouseFilter() { // mouse reports arrive on stdin; take the wheel events out so the line editor never sees them
  if (mouseFilterOn) return; mouseFilterOn = true;
  const orig = process.stdin.emit;
  process.stdin.emit = function (ev, ...a) {
    if (ev === 'data' && hdr.mouse && Buffer.isBuffer(a[0]) && a[0].includes('\x1b[<')) {
      const s = a[0].toString('utf8').replace(/\x1b\[<(\d+);\d+;\d+([Mm])/g, (m, b, t) => { if (t === 'M') onWheel(+b); return ''; });
      if (!s) return true;
      a[0] = Buffer.from(s, 'utf8');
    }
    return orig.call(this, ev, ...a);
  };
}
function shortPath(p) { const h = os.homedir(); return p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p; }
function banner() {
  const art = pandaArt();
  const maxW = Math.max(20, Math.min(70, (process.stdout.columns || 80) - 28));
  let cwdS = shortPath(state.cwd); if (cwdS.length > maxW) cwdS = '…' + cwdS.slice(-(maxW - 1));
  const info = ['', C.bold(C.white('Panda Code')) + C.gray(' v' + VERSION), C.bamboo(state.model || '(no model)') + C.gray(' · ' + state.providerName), C.gray(cwdS), '', C.gray('/help · esc interrupt · shift+tab modes')];
  const lines = art.map((a, i) => '  ' + a + '   ' + (info[i] || ''));
  const w = Math.max(...lines.map(l => stripAnsi(l).length)) + 2;
  const o = [C.bamboo('╭' + '─'.repeat(w) + '╮')];
  for (const l of lines) o.push(C.bamboo('│') + l + ' '.repeat(w - stripAnsi(l).length) + C.bamboo('│'));
  o.push(C.bamboo('╰' + '─'.repeat(w) + '╯'));
  const tips = ['Type @ followed by a path to attach a file', 'Start a line with ! to run a shell command yourself', 'Start a line with # to save a note to PANDA.md', '/init writes a PANDA.md guide for this project', 'End a line with \\ for multi-line input', '/compact frees up context when it gets full', 'Shift+Tab cycles: default → accept edits → plan mode'];
  o.push(C.gray('  ✻ Tip: ' + tips[Math.floor(Math.random() * tips.length)]));
  return o.join('\n');
}

// ───────────────────────────── paths & fs helpers ─────────────────────────────
const abs = p => path.resolve(state.cwd, String(p || '.'));
function rel(p) { const r = path.relative(state.cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; }
const posix = p => p.split(path.sep).join('/');
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }
function maxResult() { return Math.max(6000, Math.min(40000, Math.floor(state.numCtx * 0.4))); }
function truncateMiddle(s, max = maxResult()) {
  if (s.length <= max) return s;
  const h = Math.floor(max * 0.6), t = max - h;
  return s.slice(0, h) + `\n\n… [${s.length - max} characters truncated] …\n\n` + s.slice(-t);
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function globToRegex(g) {
  g = g.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const j = g.indexOf('}', i);
      if (j < 0) { re += '\\{'; continue; }
      re += '(?:' + g.slice(i + 1, j).split(',').map(x => globToRegex(x).source.slice(1, -1)).join('|') + ')';
      i = j;
    } else if (c === '[') {
      const j = g.indexOf(']', i);
      if (j < 0) { re += '\\['; continue; }
      re += '[' + g.slice(i + 1, j).replace(/^!/, '^') + ']'; i = j;
    } else re += escRe(c);
  }
  return new RegExp('^' + re + '$', IS_WIN ? 'i' : '');
}
function* walk(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? Infinity;
  const stack = [[root, 0]];
  let n = 0;
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!opts.hidden && e.name.startsWith('.')) continue;
        if (d + 1 < maxDepth) stack.push([full, d + 1]);
      } else {
        yield full;
        if (++n > 200000) return;
      }
    }
  }
}
function assertRead(p) {
  if (!state.read.has(p)) throw new Error('File has not been read yet. Read it first before writing to it.');
  try {
    const m = fs.statSync(p).mtimeMs;
    if (m > state.read.get(p) + 1) throw new Error('File has been modified since it was read (by the user or a linter). Read it again before attempting to write it.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function markRead(p) { try { state.read.set(p, fs.statSync(p).mtimeMs); } catch { } }

function diffDisplay(before, after, maxLines = 40) {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const w = String(Math.max(a.length, b.length)).length;
  const num = n => String(n).padStart(w);
  const L = [];
  for (let i = Math.max(0, s - 2); i < s; i++) L.push(C.gray(num(i + 1) + '   ' + a[i]));
  for (let i = s; i <= ea; i++) L.push(C.bgDel(C.red(num(i + 1) + ' - ' + a[i])));
  for (let i = s; i <= eb; i++) L.push(C.bgAdd(C.green(num(i + 1) + ' + ' + b[i])));
  for (let i = eb + 1; i <= Math.min(b.length - 1, eb + 2); i++) L.push(C.gray(num(i + 1) + '   ' + b[i]));
  const added = Math.max(0, eb - s + 1), removed = Math.max(0, ea - s + 1);
  let lines = L;
  if (L.length > maxLines) lines = L.slice(0, maxLines).concat(C.gray(`… +${L.length - maxLines} lines`));
  return { added, removed, text: lines.join('\n') };
}
// When an edit's old_string isn't found, point at the closest text in the file. Small models mostly get indentation or one word wrong.
function nearestLines(content, needle) {
  const first = needle.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (!first) return '';
  const lines = content.split(/\r?\n/);
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const nb = grams(first.toLowerCase());
  let best = -1, bs = 0;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    if (t === first) { if (bs < 2) { best = i; bs = 2; } return; }
    const lb = grams(t.toLowerCase());
    let inter = 0; for (const [g, c] of nb) inter += Math.min(c, lb.get(g) || 0);
    const sc = (2 * inter) / Math.max(1, (first.length - 1) + (t.length - 1));
    if (sc > bs && bs < 2) { bs = sc; best = i; }
  });
  if (best < 0 || bs < 0.55) return '';
  const from = Math.max(0, best - 1), to = Math.min(lines.length, best + 4);
  return `\nThe closest text in the file is near line ${best + 1}${bs === 2 ? ' (the same text, but with different whitespace/indentation)' : ''}:\n` +
    lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(6)}\t${l}`).join('\n') + '\nCopy old_string exactly from the file (Read it again if needed).';
}
// Runs a quick syntax check on a file Panda just wrote, so mistakes show up at once instead of three steps later.
function syntaxCheck(p) {
  const ext = path.extname(p).toLowerCase();
  const fail = msg => `\n[Syntax check FAILED - fix this now]\n${String(msg).trim().slice(0, 700)}`;
  try {
    if (ext === '.json') { try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fail(`${rel(p)}: ${e.message}`); } return ''; }
    const run = (cmd, args) => cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    let r = null;
    if (['.js', '.mjs', '.cjs'].includes(ext)) r = run('node', ['--check', p]);
    else if (ext === '.py') r = run(IS_WIN ? 'python' : 'python3', ['-m', 'py_compile', p]);
    if (r && !r.error && r.status !== 0) return fail(r.stderr || r.stdout);
  } catch { }
  return '';
}
function applyEdit(content, oldS, newS, replaceAll) {
  if (oldS === newS) throw new Error('No changes to make: old_string and new_string are exactly the same.');
  if (oldS === '') throw new Error('old_string is empty. To create a new file use Write.');
  let o = oldS, n = newS;
  if (!content.includes(o) && content.includes('\r\n')) { o = oldS.replace(/\r?\n/g, '\r\n'); n = newS.replace(/\r?\n/g, '\r\n'); }
  const count = content.split(o).length - 1;
  if (!count) throw new Error('String to replace not found in file.\nString: ' + oldS + nearestLines(content, oldS));
  if (count > 1 && !replaceAll) throw new Error(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to uniquely identify the instance.`);
  if (replaceAll) return content.split(o).join(n);
  const idx = content.indexOf(o);
  return content.slice(0, idx) + n + content.slice(idx + o.length);
}

// ───────────────────────────── shell ─────────────────────────────
function spawnShell(command, cwd, withMarker = true) {
  if (IS_WIN) {
    let script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8\n${command}\n`;
    if (withMarker) script += `$__ok=$?; $__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 }\nWrite-Output ("${CWD_MARK}" + (Get-Location).ProviderPath + "|" + $__ec + "${CWD_MARK}")\n`;
    const tmp = path.join(os.tmpdir(), `panda-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.ps1`);
    fs.writeFileSync(tmp, String.fromCharCode(0xFEFF) + script, 'utf8');
    const proc = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PANDA_CODE: '1' } });
    proc.on('close', () => { try { fs.unlinkSync(tmp); } catch { } });
    return proc;
  }
  const script = withMarker ? `${command}\n__ec=$?; printf '\\n${CWD_MARK}%s|%s${CWD_MARK}\\n' "$PWD" "$__ec"` : command;
  return cp.spawn('bash', ['-c', script], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PANDA_CODE: '1' } });
}
function killTree(proc) {
  try {
    if (IS_WIN) cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch { try { proc.kill('SIGKILL'); } catch { } }
}
function runShell(command, { timeout = 120000, signal } = {}) {
  return new Promise(resolve => {
    let cwd = state.cwd;
    if (!fs.existsSync(cwd)) cwd = os.homedir();
    const proc = spawnShell(command, cwd, true);
    let stdout = '', stderr = '', done = false, timedOut = false, interrupted = false;
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); if (stdout.length > 5e6) stdout = stdout.slice(-4e6); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); if (stderr.length > 5e6) stderr = stderr.slice(-4e6); });
    const timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeout);
    const onAbort = () => { interrupted = true; killTree(proc); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = code => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let exit = code;
      const mre = new RegExp(`\\r?\\n?${CWD_MARK}([^\\r\\n]*?)${CWD_MARK}\\r?\\n?`);
      const mm = stdout.match(mre);
      if (mm) {
        const tail = mm[1];
        stdout = (stdout.slice(0, mm.index) + '\n' + stdout.slice(mm.index + mm[0].length)).replace(/^\s*\n|\n\s*$/g, '');
        const bar = tail.lastIndexOf('|');
        const dir = tail.slice(0, bar), ec = parseInt(tail.slice(bar + 1), 10);
        if (dir && fs.existsSync(dir)) state.cwd = dir;
        if (!isNaN(ec)) exit = ec;
      }
      resolve({ stdout, stderr, code: exit, timedOut, interrupted });
    };
    proc.on('close', finish);
    proc.on('error', e => { stderr += String(e.message); finish(1); });
  });
}

// ───────────────────────────── web helpers ─────────────────────────────
function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return map[e.toLowerCase()] ?? m;
  });
}
function htmlToText(h) {
  h = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|head|iframe)\b[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<a\s[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, u, t) => {
    const tt = t.replace(/<[^>]+>/g, '').trim();
    return tt ? (/^https?:/.test(u) ? `[${tt}](${u})` : tt) : '';
  });
  h = h.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(+n) + ' ');
  h = h.replace(/<li[^>]*>/gi, '\n- ').replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n');
  h = h.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer|\/table|\/ul|\/ol)[^>]*>/gi, '\n');
  h = h.replace(/<(td|th)[^>]*>/gi, ' | ');
  h = decodeEntities(h.replace(/<[^>]+>/g, ''));
  return h.replace(/[ \t\r\f]+/g, ' ').replace(/^ +| +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ───────────────────────────── tools ─────────────────────────────
const P = (type, description, extra = {}) => ({ type, description, ...extra });
const TOOLS = {
  Read: {
    perm: null,
    description: 'Reads a file from the local filesystem. Returns lines in `cat -n` format (line number, tab, content), starting at 1. By default reads up to 2000 lines from the start; use offset/limit for large files. You must Read a file before you Edit or overwrite it. You can call Read on several files in parallel. Also reads image files (png, jpg, gif, webp): the image is shown to you in the next message if the model supports vision.',
    schema: { type: 'object', properties: { file_path: P('string', 'Absolute (or cwd-relative) path of the file to read'), offset: P('number', '1-based line number to start reading from'), limit: P('number', 'Number of lines to read') }, required: ['file_path'] },
    label: a => rel(abs(a.file_path)),
    async run(a, ctx = {}) {
      const p = abs(a.file_path);
      let st; try { st = fs.statSync(p); } catch { throw new Error(`File does not exist: ${p}`); }
      if (st.isDirectory()) throw new Error(`${p} is a directory, not a file. Use LS or Glob to list it.`);
      if (IMG_EXT[path.extname(p).toLowerCase()]) {
        if (state.vision === false) throw new Error(`The current model (${state.model}) cannot view images. Ask the user to switch to a vision model with /model.`);
        const img = loadImage(p);
        return { content: `Image ${img.name} (${imgKB(img)}) is attached in the next message so you can look at it.`, images: [img], display: `Read image ${C.bold(img.name)} (${imgKB(img)})` };
      }
      if (st.size > 50 * 1024 * 1024) throw new Error(`File is too large (${st.size} bytes).`);
      const buf = fs.readFileSync(p);
      if (!ctx.side) markRead(p);
      if (isBinary(buf)) return { content: `(binary file, ${st.size} bytes — cannot display as text)`, display: 'Binary file' };
      const text = buf.toString('utf8').replace(/^\uFEFF/, '');
      if (!text.length) return { content: '<system-reminder>The file exists but is empty.</system-reminder>', display: 'Empty file' };
      const lines = text.split(/\r?\n/);
      const off = Math.max(1, Math.floor(a.offset || 1));
      const lim = Math.max(1, Math.floor(a.limit || 2000));
      const slice = lines.slice(off - 1, off - 1 + lim);
      let body = slice.map((l, i) => `${String(off + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '… [line truncated]' : l}`).join('\n');
      let note = '';
      if (body.length > maxResult()) { body = body.slice(0, maxResult()); note = `\n\n[Output truncated to fit context. File has ${lines.length} lines — use offset/limit to read the rest.]`; }
      else if (off - 1 + lim < lines.length) note = `\n\n[Showing lines ${off}-${off - 1 + slice.length} of ${lines.length}. Use offset to read more.]`;
      return { content: body + note, display: `Read ${C.bold(slice.length)} lines` };
    },
  },
  Write: {
    perm: 'edit',
    description: 'Writes a file to the local filesystem, overwriting it if it exists. If the file exists you MUST Read it first. Prefer Edit for changing existing files. Never create documentation files unless asked.',
    schema: { type: 'object', properties: { file_path: P('string', 'Absolute (or cwd-relative) path of the file to write'), content: P('string', 'The full content to write') }, required: ['file_path', 'content'] },
    label: a => rel(abs(a.file_path)),
    preview(a) {
      const p = abs(a.file_path);
      const lines = String(a.content).split(/\r?\n/);
      if (fs.existsSync(p)) { try { return diffDisplay(fs.readFileSync(p, 'utf8'), String(a.content), 30).text; } catch { } }
      return lines.slice(0, 20).map((l, i) => C.green(String(i + 1).padStart(4) + ' ' + l)).join('\n') + (lines.length > 20 ? '\n' + C.gray(`… +${lines.length - 20} lines`) : '');
    },
    async run(a) {
      const p = abs(a.file_path);
      const exists = fs.existsSync(p);
      let before = '';
      if (exists) { assertRead(p); before = fs.readFileSync(p, 'utf8'); }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(a.content));
      markRead(p);
      const n = String(a.content).split(/\r?\n/).length;
      if (exists) {
        const d = diffDisplay(before, String(a.content), 20);
        return { content: `The file ${p} has been overwritten successfully.`, display: `Updated ${C.bold(rel(p))} with ${d.added} additions and ${d.removed} removals\n${d.text}` };
      }
      const lines = String(a.content).split(/\r?\n/);
      const prev = lines.slice(0, 6).map((l, i) => C.gray(String(i + 1).padStart(4) + ' ' + l)).join('\n') + (lines.length > 6 ? '\n' + C.gray(`     … +${lines.length - 6} lines`) : '');
      return { content: `File created successfully at: ${p}`, display: `Wrote ${C.bold(n)} lines to ${C.bold(rel(p))}\n${prev}` };
    },
  },
  Edit: {
    perm: 'edit',
    description: 'Performs an exact string replacement in a file. You must Read the file first. old_string must match the file exactly (including indentation; do not include the line-number prefix from Read) and must be unique unless replace_all is true. Prefer this over Write for existing files.',
    schema: { type: 'object', properties: { file_path: P('string', 'Path of the file to modify'), old_string: P('string', 'Exact text to replace'), new_string: P('string', 'Replacement text (must differ from old_string)'), replace_all: P('boolean', 'Replace every occurrence (default false)') }, required: ['file_path', 'old_string', 'new_string'] },
    label: a => rel(abs(a.file_path)),
    preview(a) {
      const p = abs(a.file_path);
      try { const c = fs.readFileSync(p, 'utf8'); return diffDisplay(c, applyEdit(c, a.old_string, a.new_string, a.replace_all), 30).text; }
      catch { return diffDisplay(String(a.old_string), String(a.new_string), 30).text; }
    },
    async run(a) {
      const p = abs(a.file_path);
      if (!fs.existsSync(p)) {
        if (a.old_string === '') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.new_string); markRead(p); return { content: `File created successfully at: ${p}`, display: `Created ${rel(p)}` }; }
        throw new Error(`File does not exist: ${p}`);
      }
      assertRead(p);
      const before = fs.readFileSync(p, 'utf8');
      const after = applyEdit(before, String(a.old_string), String(a.new_string), !!a.replace_all);
      fs.writeFileSync(p, after); markRead(p);
      const d = diffDisplay(before, after);
      return { content: `The file ${p} has been updated successfully.`, display: `Updated ${C.bold(rel(p))} with ${d.added} additions and ${d.removed} removals\n${d.text}` };
    },
  },
  MultiEdit: {
    perm: 'edit',
    description: 'Makes multiple exact string replacements in ONE file, applied in order, atomically (all succeed or none are applied). Same rules as Edit for each edit. Read the file first.',
    schema: { type: 'object', properties: { file_path: P('string', 'Path of the file to modify'), edits: { type: 'array', description: 'Edits to apply in sequence', items: { type: 'object', properties: { old_string: P('string', 'Exact text to replace'), new_string: P('string', 'Replacement text'), replace_all: P('boolean', 'Replace all occurrences') }, required: ['old_string', 'new_string'] } } }, required: ['file_path', 'edits'] },
    label: a => rel(abs(a.file_path)),
    preview(a) {
      try { const c = fs.readFileSync(abs(a.file_path), 'utf8'); let r = c; for (const e of a.edits || []) r = applyEdit(r, e.old_string, e.new_string, e.replace_all); return diffDisplay(c, r, 30).text; } catch (e) { return C.gray('(preview unavailable: ' + e.message + ')'); }
    },
    async run(a) {
      const p = abs(a.file_path);
      assertRead(p);
      const before = fs.readFileSync(p, 'utf8');
      let r = before;
      (a.edits || []).forEach((e, i) => { try { r = applyEdit(r, String(e.old_string), String(e.new_string), !!e.replace_all); } catch (err) { throw new Error(`Edit #${i + 1} failed: ${err.message}`); } });
      fs.writeFileSync(p, r); markRead(p);
      const d = diffDisplay(before, r);
      return { content: `Applied ${a.edits.length} edits to ${p}.`, display: `Updated ${C.bold(rel(p))} with ${d.added} additions and ${d.removed} removals\n${d.text}` };
    },
  },
  Glob: {
    perm: null,
    description: 'Fast file pattern matching (e.g. "**/*.js", "src/**/*.{ts,tsx}"). Returns matching file paths sorted by modification time (newest first). Use this to find files by name.',
    schema: { type: 'object', properties: { pattern: P('string', 'Glob pattern to match files against'), path: P('string', 'Directory to search in (default: current working directory)') }, required: ['pattern'] },
    label: a => a.pattern + (a.path ? ` in ${a.path}` : ''),
    async run(a) {
      const base = abs(a.path || '.');
      const pat = String(a.pattern).replace(/\\/g, '/').replace(/^\.\//, '');
      const re = globToRegex(pat);
      const maxDepth = pat.includes('**') ? Infinity : pat.split('/').length;
      const hits = [];
      for (const f of walk(base, { hidden: true, maxDepth })) if (re.test(posix(path.relative(base, f)))) hits.push(f);
      const withTime = hits.map(f => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { } return [f, m]; }).sort((x, y) => y[1] - x[1]);
      const shown = withTime.slice(0, 100).map(x => x[0]);
      let content = shown.length ? shown.join('\n') : 'No files found';
      if (withTime.length > 100) content += `\n(Results truncated: ${withTime.length} total. Use a more specific pattern.)`;
      return { content, display: `Found ${C.bold(withTime.length)} files` };
    },
  },
  Grep: {
    perm: null,
    description: 'Searches file contents with a JavaScript regular expression (ripgrep-like). Filter files with `glob` (e.g. "*.js", "**/*.tsx") or `type` (js, ts, py, rust, go, java, cs, cpp, ...). output_mode: "files_with_matches" (default, file paths), "content" (matching lines, supports -A/-B/-C context and -n), or "count". Skips node_modules, .git and hidden directories.',
    schema: {
      type: 'object', properties: {
        pattern: P('string', 'Regular expression to search for'), path: P('string', 'File or directory to search (default: cwd)'), glob: P('string', 'Glob to filter files'), type: P('string', 'File type to search, e.g. js, py, rust'),
        output_mode: P('string', 'content | files_with_matches | count', { enum: ['content', 'files_with_matches', 'count'] }),
        '-i': P('boolean', 'Case insensitive'), '-n': P('boolean', 'Show line numbers (content mode, default true)'), '-A': P('number', 'Lines after each match'), '-B': P('number', 'Lines before each match'), '-C': P('number', 'Lines before and after each match'),
        multiline: P('boolean', 'Allow patterns to span lines'), head_limit: P('number', 'Limit output to first N lines/entries'),
      }, required: ['pattern'],
    },
    label: a => `"${a.pattern}"` + (a.path ? ` in ${a.path}` : '') + (a.glob ? ` (${a.glob})` : ''),
    async run(a) {
      const TYPES = { js: 'js,jsx,mjs,cjs', ts: 'ts,tsx,mts,cts', py: 'py,pyi', rust: 'rs', go: 'go', java: 'java', c: 'c,h', cpp: 'cpp,cc,cxx,hpp,hh,h', cs: 'cs', rb: 'rb', php: 'php', html: 'html,htm', css: 'css,scss,sass,less', json: 'json', md: 'md,markdown', sh: 'sh,bash', ps: 'ps1,psm1', yaml: 'yml,yaml', swift: 'swift', kt: 'kt,kts', lua: 'lua', sql: 'sql', xml: 'xml', toml: 'toml', vue: 'vue', svelte: 'svelte', dart: 'dart' };
      let flags = 'g' + (a['-i'] ? 'i' : '') + (a.multiline ? 'ms' : '');
      let re; try { re = new RegExp(a.pattern, flags); } catch (e) { throw new Error('Invalid regex: ' + e.message); }
      const base = abs(a.path || '.');
      let st; try { st = fs.statSync(base); } catch { throw new Error(`Path does not exist: ${base}`); }
      const files = st.isFile() ? [base] : walk(base, {});
      let globRe = a.glob ? globToRegex(a.glob) : null;
      const globHasSlash = a.glob && a.glob.includes('/');
      const exts = a.type ? (TYPES[a.type] || a.type).split(',') : null;
      const mode = a.output_mode || 'files_with_matches';
      const before = a['-C'] ?? a['-B'] ?? 0, after = a['-C'] ?? a['-A'] ?? 0, showN = a['-n'] !== false;
      const results = []; let total = 0;
      for (const f of files) {
        const r = posix(path.relative(st.isFile() ? path.dirname(base) : base, f));
        if (globRe && !globRe.test(globHasSlash ? r : path.basename(f))) continue;
        if (exts && !exts.includes(path.extname(f).slice(1).toLowerCase())) continue;
        let buf; try { const s = fs.statSync(f); if (s.size > 5e6) continue; buf = fs.readFileSync(f); } catch { continue; }
        if (isBinary(buf)) continue;
        const text = buf.toString('utf8');
        re.lastIndex = 0;
        if (mode === 'files_with_matches') { if (re.test(text)) results.push(f); continue; }
        const lines = text.split(/\r?\n/);
        if (mode === 'count') {
          const m = text.match(re); if (m) { results.push(`${f}:${m.length}`); total += m.length; } continue;
        }
        const matchLines = new Set();
        if (a.multiline) {
          let m; re.lastIndex = 0;
          while ((m = re.exec(text))) { const s = text.slice(0, m.index).split('\n').length - 1, e = s + m[0].split('\n').length - 1; for (let i = s; i <= e; i++) matchLines.add(i); if (!m[0].length) re.lastIndex++; }
        } else {
          const lre = new RegExp(a.pattern, a['-i'] ? 'i' : '');
          lines.forEach((l, i) => { if (lre.test(l)) matchLines.add(i); });
        }
        if (!matchLines.size) continue;
        const show = new Set();
        for (const i of matchLines) for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) show.add(j);
        let prev = -2;
        for (const i of [...show].sort((x, y) => x - y)) {
          if ((before || after) && prev >= 0 && i > prev + 1) results.push('--');
          const sep = matchLines.has(i) ? ':' : '-';
          const l = lines[i].length > 500 ? lines[i].slice(0, 500) + '…' : lines[i];
          results.push(`${f}${sep}${showN ? (i + 1) + sep : ''}${l}`);
          prev = i;
        }
        total += matchLines.size;
      }
      let list = results;
      if (mode === 'files_with_matches') list = results.map(f => [f, (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })()]).sort((x, y) => y[1] - x[1]).map(x => x[0]);
      const limit = a.head_limit || (mode === 'content' ? 400 : 200);
      let content = list.slice(0, limit).join('\n');
      if (list.length > limit) content += `\n(Showing first ${limit} of ${list.length} results.)`;
      if (!list.length) content = 'No matches found';
      content = truncateMiddle(content);
      const disp = mode === 'files_with_matches' ? `Found ${C.bold(list.length)} files` : mode === 'count' ? `Found ${C.bold(total)} matches in ${list.length} files` : `Found ${C.bold(total)} matching lines`;
      return { content, display: disp };
    },
  },
  LS: {
    perm: null,
    description: 'Lists files and directories in a path as a tree (2 levels deep). Directories end with "/". Prefer Glob/Grep when you know what you are looking for.',
    schema: { type: 'object', properties: { path: P('string', 'Directory to list (default: cwd)'), ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to ignore' } }, required: [] },
    label: a => rel(abs(a.path || '.')) || '.',
    async run(a) {
      const root = abs(a.path || '.');
      if (!fs.existsSync(root)) throw new Error(`Directory does not exist: ${root}`);
      const ign = (a.ignore || []).map(globToRegex);
      const outL = [root + path.sep]; let n = 0;
      const rec = (dir, depth, pre) => {
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        ents.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
        for (const e of ents) {
          if (n > 400) return;
          if (ign.some(r => r.test(e.name))) continue;
          n++;
          if (e.isDirectory()) {
            const skip = SKIP_DIRS.has(e.name);
            outL.push(`${pre}- ${e.name}/${skip ? ' (skipped)' : ''}`);
            if (!skip && depth < 2) rec(path.join(dir, e.name), depth + 1, pre + '  ');
          } else outL.push(`${pre}- ${e.name}`);
        }
      };
      rec(root, 1, '  ');
      if (n > 400) outL.push('  … (truncated; use Glob for specific files)');
      return { content: outL.join('\n'), display: `Listed ${C.bold(n)} paths` };
    },
  },
  [SHELL_TOOL]: {
    perm: 'exec',
    description: IS_WIN
      ? 'Executes a PowerShell (Windows PowerShell 5.1) command and returns its output. The working directory persists between calls (Set-Location carries over). Use PowerShell syntax: `;` instead of `&&`, `if ($?) { ... }` for conditional chaining, Get-ChildItem, etc. Quote paths with spaces. Do NOT use this for reading/writing/searching files — use Read/Write/Edit/Glob/Grep. Default timeout 2 min (max 10 min). Set run_in_background for servers/watchers and check them with BashOutput. Interactive commands will not work (stdin is closed).'
      : 'Executes a bash command and returns its output. The working directory persists between calls. Quote paths with spaces. Do NOT use this for reading/writing/searching files — use Read/Write/Edit/Glob/Grep. Default timeout 2 min (max 10 min). Set run_in_background for servers/watchers and check them with BashOutput. Interactive commands will not work.',
    schema: { type: 'object', properties: { command: P('string', 'The command to execute'), description: P('string', 'Short (5-10 word) description of what the command does'), timeout: P('number', 'Timeout in milliseconds (max 600000)'), run_in_background: P('boolean', 'Run in the background and return a shell ID') }, required: ['command'] },
    label: a => { const c = String(a.command).replace(/\s+/g, ' '); return c.length > 90 ? c.slice(0, 90) + '…' : c; },
    preview: a => C.white(String(a.command)) + (a.description ? '\n' + C.gray(a.description) : ''),
    async run(a, ctx) {
      if (a.run_in_background) {
        const id = 'shell_' + (++state.shellSeq);
        const proc = spawnShell(String(a.command), state.cwd, false);
        const sh = { id, command: a.command, proc, out: '', read: 0, status: 'running', code: null, started: Date.now() };
        proc.stdout.on('data', d => { sh.out += d.toString('utf8'); });
        proc.stderr.on('data', d => { sh.out += d.toString('utf8'); });
        proc.on('close', c => { sh.status = sh.status === 'killed' ? 'killed' : 'completed'; sh.code = c; });
        proc.on('error', e => { sh.out += e.message; sh.status = 'failed'; });
        state.shells.set(id, sh);
        return { content: `Command running in background with ID: ${id}. Use BashOutput to read its output and KillShell to stop it.`, display: C.gray(`Running in background (${id})`) };
      }
      const timeout = Math.min(600000, Math.max(1000, a.timeout || 120000));
      const r = await runShell(String(a.command), { timeout, signal: ctx.signal });
      let content = r.stdout.trimEnd();
      if (r.stderr.trim()) content += (content ? '\n' : '') + r.stderr.trimEnd();
      if (r.timedOut) content += `\n[Command timed out after ${timeout} ms]`;
      if (r.interrupted) content += '\n[Command was interrupted by the user]';
      if (r.code && !r.timedOut && !r.interrupted) content += `\n[Exit code: ${r.code}]`;
      content = truncateMiddle(content || '(no output)', 30000);
      const lines = (r.stdout.trimEnd() + (r.stderr.trim() ? '\n' + r.stderr.trimEnd() : '')).split(/\r?\n/).filter((l, i, arr) => arr.length > 1 || l);
      let display = lines.length && lines[0] !== '' ? lines.slice(0, 5).map(l => C.gray(l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n') + (lines.length > 5 ? '\n' + C.gray(`… +${lines.length - 5} lines`) : '') : C.gray('(No content)');
      if (r.code && !r.interrupted) display += '\n' + C.red(r.timedOut ? 'Timed out' : `Exit code ${r.code}`);
      if (r.interrupted) display += '\n' + C.red('Interrupted');
      return { content, display };
    },
  },
  BashOutput: {
    perm: null,
    description: 'Retrieves new output (since the last check) from a background shell started with run_in_background, plus its status.',
    schema: { type: 'object', properties: { bash_id: P('string', 'ID of the background shell'), filter: P('string', 'Optional regex; only lines matching it are returned') }, required: ['bash_id'] },
    label: a => a.bash_id,
    async run(a) {
      const sh = state.shells.get(a.bash_id);
      if (!sh) throw new Error(`No background shell with ID ${a.bash_id}`);
      let chunk = sh.out.slice(sh.read); sh.read = sh.out.length;
      if (a.filter) { const r = new RegExp(a.filter); chunk = chunk.split(/\r?\n/).filter(l => r.test(l)).join('\n'); }
      return { content: `<status>${sh.status}${sh.code != null ? ` (exit ${sh.code})` : ''}</status>\n<output>\n${truncateMiddle(chunk.trimEnd() || '(no new output)', 30000)}\n</output>`, display: C.gray(`${sh.status} · ${chunk.split('\n').filter(Boolean).length} new lines`) };
    },
  },
  KillShell: {
    perm: null,
    description: 'Kills a running background shell by its ID.',
    schema: { type: 'object', properties: { shell_id: P('string', 'ID of the background shell to kill') }, required: ['shell_id'] },
    label: a => a.shell_id,
    async run(a) {
      const sh = state.shells.get(a.shell_id);
      if (!sh) throw new Error(`No background shell with ID ${a.shell_id}`);
      if (sh.status === 'running') { sh.status = 'killed'; killTree(sh.proc); }
      return { content: `Successfully killed shell: ${a.shell_id}`, display: 'Shell killed' };
    },
  },
  WebFetch: {
    perm: 'net',
    description: 'Fetches a URL and returns its content as readable text (HTML is converted to text/markdown). Use `prompt` to state what you want to learn from the page. Results may be truncated for very large pages.',
    schema: { type: 'object', properties: { url: P('string', 'The fully-formed URL to fetch'), prompt: P('string', 'What information you want from the page') }, required: ['url'] },
    label: a => a.url,
    preview: a => C.white(a.url),
    async run(a, ctx) {
      let url = String(a.url);
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]), redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8' } });
      const ct = res.headers.get('content-type') || '';
      let body = await res.text();
      const size = body.length;
      if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(body)) body = htmlToText(body);
      body = truncateMiddle(body, Math.min(maxResult(), 40000));
      let content = `URL: ${res.url}\nStatus: ${res.status} ${res.statusText}\nContent-Type: ${ct}\n\n${body}`;
      if (a.prompt) content += `\n\n[Use the page content above to address: ${a.prompt}]`;
      return { content, display: `Received ${fmtK(size)} chars (${res.status} ${res.statusText}) in ${((Date.now() - t0) / 1000).toFixed(1)}s` };
    },
  },
  WebSearch: {
    perm: 'net',
    description: 'Searches the web (DuckDuckGo) and returns result titles, URLs and snippets. Use WebFetch to read a result in full.',
    schema: { type: 'object', properties: { query: P('string', 'The search query'), allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' }, blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' } }, required: ['query'] },
    label: a => `"${a.query}"`,
    preview: a => C.white(a.query),
    async run(a, ctx) {
      const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(a.query), { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]), headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const html = await res.text();
      const results = [];
      const tre = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const marks = []; let m;
      while ((m = tre.exec(html))) marks.push({ idx: m.index, href: m[1], title: m[2] });
      marks.forEach((mk, i) => {
        const seg = html.slice(mk.idx, marks[i + 1] ? marks[i + 1].idx : mk.idx + 4000);
        const sm = seg.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
        let url = decodeEntities(mk.href); const u = url.match(/uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
        if (url.startsWith('//')) url = 'https:' + url;
        if (/duckduckgo\.com\/y\.js/.test(url)) return; // ads
        let host = ''; try { host = new URL(url).hostname; } catch { }
        const dm = (list) => (list || []).some(d => host === d || host.endsWith('.' + d));
        if (a.allowed_domains?.length && !dm(a.allowed_domains)) return;
        if (dm(a.blocked_domains)) return;
        results.push({ title: decodeEntities(mk.title.replace(/<[^>]+>/g, '')).trim(), url, snippet: sm ? decodeEntities(sm[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '' });
      });
      const top = results.slice(0, 10);
      if (!top.length) return { content: `No results found for "${a.query}". (The search engine may have rate-limited the request; try again or rephrase.)`, display: 'No results' };
      return { content: `Web search results for "${a.query}":\n\n` + top.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'), display: `Found ${C.bold(top.length)} results` };
    },
  },
  TodoWrite: {
    perm: null,
    description: 'Creates and updates a structured task list for the current session. Use it proactively for any task with 3+ steps: plan the steps, mark exactly one task in_progress at a time, and mark tasks completed immediately when done. Send the FULL list every time.',
    schema: { type: 'object', properties: { todos: { type: 'array', description: 'The full, updated todo list', items: { type: 'object', properties: { content: P('string', 'Task in imperative form, e.g. "Run the tests"'), status: P('string', 'pending | in_progress | completed', { enum: ['pending', 'in_progress', 'completed'] }), activeForm: P('string', 'Present-continuous form, e.g. "Running the tests"') }, required: ['content', 'status'] } } }, required: ['todos'] },
    label: () => '',
    async run(a) {
      state.todos = (a.todos || []).map(t => ({ content: String(t.content), status: t.status || 'pending', activeForm: t.activeForm }));
      return { content: 'Todos have been modified successfully. Keep using the todo list to track progress and proceed with the current task.', display: renderTodos() };
    },
  },
  Task: {
    perm: null,
    description: 'Launches a sub-agent with its own fresh context to autonomously handle a self-contained task (e.g. a broad codebase search or research question) and return a single final report. Give it a detailed prompt with everything it needs; it cannot see this conversation. Its final message is returned to you, not to the user.',
    schema: { type: 'object', properties: { description: P('string', 'Short (3-5 word) task description'), prompt: P('string', 'The full task for the sub-agent'), subagent_type: P('string', 'Optional agent flavor, e.g. general-purpose') }, required: ['description', 'prompt'] },
    label: a => a.description,
    async run(a, ctx) {
      const msgs = [{ role: 'user', content: a.prompt }];
      const tools = Object.keys(TOOLS).filter(n => !['Task', 'ExitPlanMode', 'AskUserQuestion', 'TodoWrite'].includes(n));
      const sub = { ...ctx, depth: ctx.depth + 1, indent: ctx.indent + '    ', quiet: true, tools, toolUses: 0, sub: true };
      const t0 = Date.now();
      const text = await agentLoop(msgs, sub);
      return { content: text || '(the sub-agent returned no text)', display: `Done (${sub.toolUses} tool uses · ${((Date.now() - t0) / 1000).toFixed(0)}s)` };
    },
  },
  AskUserQuestion: {
    perm: null,
    description: 'Asks the user one or more multiple-choice questions when you need a decision or clarification to proceed. The user can always type a custom answer.',
    schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: P('string', 'The question'), header: P('string', 'Very short label'), options: { type: 'array', items: { type: 'object', properties: { label: P('string', 'Option text'), description: P('string', 'What this option means') }, required: ['label'] } }, multiSelect: P('boolean', 'Allow choosing several options') }, required: ['question'] } } }, required: ['questions'] },
    label: a => (a.questions || []).map(q => q.header || '').filter(Boolean).join(', '),
    async run(a, ctx) {
      if (!state.interactive) throw new Error('Cannot ask questions in non-interactive mode.');
      spinner.stop();
      const answers = [];
      for (const q of a.questions || []) {
        const opts = q.options || [];
        if (opts.length && !q.multiSelect) {
          const qi = await ui.select(ctx.indent + '  ' + C.bold(C.white(q.question)), opts.map(o => ({ label: o.label, desc: o.description ? C.gray('— ' + o.description) : '' })).concat([{ label: 'Type something else…' }]));
          if (qi === -1) throw new Error('The user declined to answer.');
          let val = opts[qi]?.label;
          if (val === undefined) {
            val = (await ui.ask(ctx.indent + C.bamboo('    your answer ❯ '))).trim();
            if (val === '\x1b' || val === '\x03') throw new Error('The user declined to answer.');
          }
          out(ctx.indent + C.gray('  ⎿  ') + C.white(q.header ? q.header + ': ' : '') + C.bamboo(val));
          answers.push(`"${q.question}"="${val}"`);
          continue;
        }
        out(ctx.indent + '  ' + C.bold(C.white(q.question)));
        opts.forEach((o, i) => out(ctx.indent + '    ' + C.bamboo(`${i + 1}.`) + ' ' + o.label + (o.description ? C.gray(' — ' + o.description) : '')));
        out(ctx.indent + '    ' + C.gray(`${opts.length + 1}. Type something else`));
        const ans = (await ui.ask(ctx.indent + C.bamboo('    answer ❯ '))).trim();
        if (ans === '\x1b' || ans === '\x03') throw new Error('The user declined to answer.');
        const picks = ans.split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= opts.length);
        const val = picks.length && /^[\d\s,]+$/.test(ans) ? picks.map(n => opts[n - 1].label).join(', ') : ans;
        answers.push(`"${q.question}"="${val}"`);
      }
      return { content: `User has answered your questions: ${answers.join(', ')}. You can now continue with the user's answers in mind.`, display: C.gray('Answered') };
    },
  },
  ExitPlanMode: {
    perm: null,
    description: 'Use ONLY in plan mode, when you have finished researching and are ready to present an implementation plan to the user for approval. The plan should be concise markdown.',
    schema: { type: 'object', properties: { plan: P('string', 'The implementation plan (markdown)') }, required: ['plan'] },
    label: () => '',
    async run(a, ctx) {
      if (state.mode !== 'plan') return { content: 'You are not in plan mode. Proceed with the task.', display: C.gray('Not in plan mode') };
      spinner.stop();
      out(ctx.indent + C.bamboo('  ╭─ Plan ─────────────────────────'));
      const md = new MD(l => out(l), ctx.indent + C.bamboo('  │ '));
      md.first = false; md.push(String(a.plan) + '\n'); md.end();
      out(ctx.indent + C.bamboo('  ╰────────────────────────────────'));
      if (!state.interactive) return { content: 'Plan presented (non-interactive).', display: '' };
      const OKMSG = 'User has approved your plan. You can now start coding. Start by updating your todo list if applicable.';
      const pi = await ui.select('  ' + C.bold('Would you like to proceed?'), [{ label: 'Yes, and auto-accept edits' }, { label: 'Yes, manually approve edits' }, { label: 'No, keep planning' }]);
      if (pi === 0) { state.mode = 'acceptEdits'; return { content: OKMSG, display: C.green('Plan approved · auto-accepting edits') }; }
      if (pi === 1) { state.mode = 'default'; return { content: OKMSG, display: C.green('Plan approved') }; }
      let fb = '';
      if (pi === 2) { const t = (await ui.ask(C.bamboo('  what should change? (enter to skip) ❯ '))).trim(); if (t && t !== '\x1b' && t !== '\x03') fb = ` Feedback: ${t}`; }
      return { content: `The user rejected the plan and wants to keep planning.${fb}`, display: C.yellow('Plan rejected'), stop: !fb };
    },
  },
};

// ── /undo: file checkpoints ──
// Before Panda writes or edits a file it remembers the old contents, grouped per request, so /undo can roll the last request back.
function snapshotForUndo(p) {
  state.undo ||= [];
  let g = state.undo[state.undo.length - 1];
  if (!g || g.turn !== state.turnId) { g = { turn: state.turnId, files: [] }; state.undo.push(g); if (state.undo.length > 25) state.undo.shift(); }
  if (g.files.some(f => f.p === p)) return;
  let content = null, existed = false;
  try {
    const st = fs.statSync(p); existed = true;
    if (st.isFile()) { if (st.size > 8 * 1024 * 1024) return; content = fs.readFileSync(p); }
  } catch { }
  g.files.push({ p, existed, content });
}
function undoLast() {
  const g = state.undo?.pop();
  if (!g) return null;
  const done = [];
  for (const f of [...g.files].reverse()) {
    try {
      if (f.existed && f.content) { fs.writeFileSync(f.p, f.content); done.push('restored ' + rel(f.p)); }
      else if (!f.existed) { fs.rmSync(f.p, { force: true }); done.push('removed ' + rel(f.p)); }
    } catch (e) { done.push('could not revert ' + rel(f.p) + ': ' + e.message); }
    state.read.delete(f.p);
  }
  return done;
}

// ── image generation (local backends) ──
const IMAGE_HELP = `No image generator found. Panda can draw with any of these (all run on your PC):
  - Stable Diffusion WebUI / Forge started with the --api option (http://127.0.0.1:7860)
  - ComfyUI (http://127.0.0.1:8188)
  - an Ollama image model, if your Ollama supports them
  - any OpenAI-style images server: tell Panda where with /imagine url http://host:port/v1
Start one and try again. Your current Ollama models are text/vision models: they can look at images but not draw them.`;
const clampDim = v => Math.min(2048, Math.max(256, Math.round((+v || 768) / 8) * 8));
function defaultImagePath(prompt) {
  const slug = String(prompt || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  return path.join('generated', `${slug}-${Date.now().toString(36)}.png`);
}
async function probe(url, ms = 1500) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; } }
async function detectImageBackend() {
  const set = process.env.PANDA_IMAGE_URL || state.imageUrl;
  if (set) { const url = set.replace(/\/+$/, ''); return { kind: state.imageKind || (/:8188/.test(url) ? 'comfy' : /\/v1$/.test(url) ? 'openai' : 'a1111'), url }; }
  if (await probe('http://127.0.0.1:7860/sdapi/v1/options')) return { kind: 'a1111', url: 'http://127.0.0.1:7860' };
  if (await probe('http://127.0.0.1:7861/sdapi/v1/options')) return { kind: 'a1111', url: 'http://127.0.0.1:7861' };
  if (await probe('http://127.0.0.1:8188/system_stats')) return { kind: 'comfy', url: 'http://127.0.0.1:8188' };
  if (state.kind === 'ollama') {
    try {
      const m = (await listModelsRaw()).find(x => x.caps?.includes('image') || /(flux|z-image|stable-diffusion|sdxl|sd3|qwen-image)/i.test(x.name));
      if (m) return { kind: 'ollama', url: state.baseUrl.replace(/\/+$/, ''), model: m.name };
    } catch { }
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function generateImage({ prompt, negative = '', width = 768, height = 768, steps = 25, seed = -1, signal }) {
  const be = await detectImageBackend();
  if (!be) throw new Error(IMAGE_HELP);
  const sig = ms => AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(ms)]);
  const post = async (url, body, ms = 600000) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig(ms) });
    if (!r.ok) throw new Error(`Image server ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  let buf;
  if (be.kind === 'a1111') {
    const j = await post(be.url + '/sdapi/v1/txt2img', { prompt, negative_prompt: negative, width, height, steps, seed, cfg_scale: 7, batch_size: 1 });
    if (!j.images?.[0]) throw new Error('The image server returned no image.');
    buf = Buffer.from(j.images[0], 'base64');
    try { const info = JSON.parse(j.info || '{}'); if (info.seed !== undefined) seed = info.seed; } catch { }
  } else if (be.kind === 'openai') {
    const j = await post(be.url + '/images/generations', { prompt, n: 1, size: `${width}x${height}`, response_format: 'b64_json' });
    const d = j.data?.[0];
    if (d?.b64_json) buf = Buffer.from(d.b64_json, 'base64');
    else if (d?.url) buf = Buffer.from(await (await fetch(d.url, { signal: sig(120000) })).arrayBuffer());
    else throw new Error('The image server returned no image.');
  } else if (be.kind === 'ollama') {
    const j = await post(be.url + '/api/generate', { model: be.model, prompt, stream: false, width, height, steps });
    const b64 = j.image || j.images?.[0] || (typeof j.response === 'string' && j.response.length > 1000 ? j.response : '');
    if (!b64) throw new Error(`The Ollama model ${be.model} returned no image. Image generation needs an Ollama build and model that support it.`);
    buf = Buffer.from(b64, 'base64');
  } else if (be.kind === 'comfy') {
    const oi = await (await fetch(be.url + '/object_info/CheckpointLoaderSimple', { signal: sig(10000) })).json();
    const ck = oi.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.[0];
    if (!ck) throw new Error('ComfyUI has no checkpoint (model) installed. Put one in ComfyUI/models/checkpoints.');
    const s = seed < 0 ? Math.floor(Math.random() * 1e9) : seed; seed = s;
    const wf = {
      3: { class_type: 'KSampler', inputs: { seed: s, steps, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ck } },
      5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'panda', images: ['8', 0] } },
    };
    const { prompt_id } = await post(be.url + '/prompt', { prompt: wf }, 30000);
    const end = Date.now() + 600000; let im = null;
    while (Date.now() < end && !im) {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      await sleep(700);
      try { const h = await (await fetch(`${be.url}/history/${prompt_id}`, { signal: sig(10000) })).json(); im = h[prompt_id]?.outputs?.[9]?.images?.[0] || null; } catch { }
    }
    if (!im) throw new Error('ComfyUI did not finish in time.');
    buf = Buffer.from(await (await fetch(`${be.url}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`, { signal: sig(60000) })).arrayBuffer());
  }
  return { buf, seed, backend: be.kind };
}
async function enhancePrompt(p, signal) {
  let text = ''; const saved = state.think; state.think = false;
  try {
    for await (const ev of streamChat({ system: 'You write prompts for text-to-image models. Reply with ONE paragraph only: no preface, no quotes.', messages: [{ role: 'user', content: `Rewrite this as a detailed image prompt (subject, style, lighting, composition, quality tags), under 90 words: ${p}` }], tools: null, signal })) if (ev.type === 'text') text += ev.text;
  } finally { state.think = saved; }
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || p;
}
TOOLS.ImageGen = {
  perm: 'edit',
  description: 'Generates an image from a text prompt with a local image model (Stable Diffusion WebUI/Forge, ComfyUI or an Ollama image model) and saves it as a file. Write a detailed visual prompt: subject, style, lighting, composition. If the model has vision, the result is shown to you so you can check it and try again with a better prompt.',
  schema: { type: 'object', properties: { prompt: P('string', 'Detailed description of the image'), negative_prompt: P('string', 'Things to avoid'), width: P('number', 'Width in pixels (256-2048, default 768)'), height: P('number', 'Height in pixels (256-2048, default 768)'), steps: P('number', 'Sampling steps (default 25)'), seed: P('number', 'Seed for reproducible results (-1 = random)'), file_path: P('string', 'Where to save the PNG (default: ./generated/<name>.png)') }, required: ['prompt'] },
  label: a => String(a.prompt || '').slice(0, 60),
  preview: a => C.white(String(a.prompt)) + '\n' + C.gray(`→ ${rel(abs(a.file_path || defaultImagePath(a.prompt)))} · ${clampDim(a.width)}x${clampDim(a.height)}`),
  async run(a, ctx) {
    const w = clampDim(a.width), h = clampDim(a.height), p = abs(a.file_path || defaultImagePath(a.prompt));
    const r = await generateImage({ prompt: String(a.prompt), negative: a.negative_prompt || '', width: w, height: h, steps: Math.min(80, Math.max(1, +a.steps || 25)), seed: a.seed ?? -1, signal: ctx.signal });
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, r.buf);
    const img = { name: path.basename(p), mime: r.buf[0] === 0xff ? 'image/jpeg' : 'image/png', bytes: r.buf.length, data: r.buf.toString('base64') };
    const seeIt = state.vision !== false;
    return { content: `Image saved to ${p} (${w}x${h}, seed ${r.seed}, via ${r.backend}).${seeIt ? ' It is attached in the next message so you can check it.' : ''}`, images: seeIt ? [img] : undefined, display: `Saved ${C.bold(rel(p))} (${w}x${h}, ${Math.round(r.buf.length / 1024)} KB)` };
  },
};
function parseImagine(arg) {
  const o = { w: 768, h: 768, steps: 25, seed: -1, neg: '', enhance: false, open: true };
  let rest = arg;
  const take = (re, fn) => { const m = rest.match(re); if (m) { fn(m); rest = rest.replace(m[0], ' '); } };
  take(/--size\s+(\d+)x(\d+)/i, m => { o.w = +m[1]; o.h = +m[2]; });
  take(/--steps\s+(\d+)/i, m => { o.steps = +m[1]; });
  take(/--seed\s+(-?\d+)/i, m => { o.seed = +m[1]; });
  take(/--neg\s+"([^"]*)"/i, m => { o.neg = m[1]; });
  take(/--enhance\b/i, () => { o.enhance = true; });
  take(/--no-open\b/i, () => { o.open = false; });
  o.prompt = rest.trim();
  return o;
}
async function imagineCmd(arg) {
  const a = arg.trim();
  const um = a.match(/^url\s+(\S+)(?:\s+(a1111|comfy|openai|ollama))?/i);
  if (um) { state.imageUrl = um[1]; state.imageKind = um[2] || ''; saveConfig(); out(C.gray('  ⎿  image server set to ') + C.bamboo(um[1])); return; }
  if (!a || /^setup\b/i.test(a)) {
    const be = await detectImageBackend();
    out(be ? C.gray('  Image backend: ') + C.bamboo(`${be.kind} at ${be.url}${be.model ? ' (' + be.model + ')' : ''}`) : C.yellow(IMAGE_HELP));
    out(C.gray('  Usage: /imagine <prompt> [--size 1024x1024] [--steps 30] [--seed 42] [--neg "blurry"] [--enhance] [--no-open]'));
    return;
  }
  const o = parseImagine(a);
  if (!o.prompt) { out(C.yellow('  Give me a prompt: /imagine a panda eating bamboo in the rain')); return; }
  const ac = new AbortController(); ui.abort = ac;
  spinner.start('Painting');
  try {
    if (o.enhance) { SP().set('Improving the prompt'); o.prompt = await enhancePrompt(o.prompt, ac.signal); out(C.gray('  ⎿  prompt: ') + o.prompt); SP().set('Painting'); }
    const p = abs(defaultImagePath(o.prompt)), w = clampDim(o.w), h = clampDim(o.h);
    const r = await generateImage({ prompt: o.prompt, negative: o.neg, width: w, height: h, steps: o.steps, seed: o.seed, signal: ac.signal });
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, r.buf);
    spinner.stop();
    out(C.gray('  ⎿  ') + '🖼  ' + C.bamboo(rel(p)) + C.gray(` (${w}x${h}, ${Math.round(r.buf.length / 1024)} KB, seed ${r.seed}, ${r.backend})`));
    if (o.open) { try { cp.spawn(IS_WIN ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', IS_WIN ? ['/c', 'start', '', p] : [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { } }
  } catch (e) {
    spinner.stop();
    out(e.name === 'AbortError' || ac.signal.aborted ? C.gray('  ⎿  stopped') : C.red('  ⎿  ') + (e.message || e).split('\n').map((l, i) => (i ? '     ' : '') + l).join('\n'));
  } finally { spinner.stop(); ui.abort = null; }
}

// ── /flaws: a full, purpose-driven review ──
function flawsPrompt(purpose, tree) {
  return `Run a /flaws review of this project.

PURPOSE (from the user; judge everything against it): ${purpose}

${tree}

How to do it:
1. Map and READ the project properly. Read the manifest/README and every important source file in full (several Read calls per step), not just the first lines. Use Grep to follow how the pieces connect.
2. Run what exists with the ${SHELL_TOOL} tool: build, tests, linter, type-checker, or at least a syntax check or start-up. Report the real output, not guesses.
3. Report findings in three groups, most important first. For each one say what is wrong, where (file_path:line_number), why it matters for the PURPOSE, and a concrete fix.
   - Critical: bugs, crashes, security problems, data loss, anything that stops the PURPOSE from working
   - Important: reliability, performance, design problems, pieces the PURPOSE needs that are missing
   - Polish: UX, naming, docs, small cleanups
4. Then a section "What would make this better": missing features and big ideas. If this project is a coding agent or CLI tool, compare it with the best tools in its class such as Claude Code (hooks, MCP servers, sub-agents, skills and custom slash commands, checkpoints/undo, permission rules, git and PR integration, headless/JSON mode, IDE integration, memory files, background tasks, sandboxing) and say which gaps matter most.
5. BIG ideas must not be started without the user. Pick the 2-4 biggest and ask about them with the AskUserQuestion tool: one question per idea, 2-4 options, your recommendation first with the reason in its description. Ask after the report.
Rules: this is a READ-ONLY review (do not modify files; propose changes instead). Be honest and specific: every flaw must cite evidence you actually read or ran. Do not invent problems to look thorough, and say plainly when something is good.`;
}
async function flawsCmd(arg) {
  let purpose = arg.trim();
  if (!purpose) {
    out(C.bold('  What is this project for?') + C.gray(' Who uses it, what it must do, what "good" looks like. The more specific you are, the better the review.'));
    purpose = (await ui.ask(C.bamboo('  purpose ❯ '))).trim();
    if (!purpose || purpose === '\x1b' || purpose === '\x03') { out(C.gray('  (cancelled)')); return; }
  }
  out(C.gray('  ⎿  Reviewing the whole project against: ') + C.white(purpose));
  state.readonlyTurn = true;
  try { await runTurn(flawsPrompt(purpose, projectDigest(0).text)); } finally { state.readonlyTurn = false; }
}
function renderTodos() {
  if (!state.todos.length) return C.gray('(no todos)');
  return state.todos.map(t => t.status === 'completed' ? C.gray('☒ ' + C.strike(t.content)) : t.status === 'in_progress' ? C.bold(C.leaf('▸ ' + t.content)) : '☐ ' + t.content).join('\n');
}

// ───────────────────────────── permissions ─────────────────────────────
function permKey(name, a) {
  if (name === SHELL_TOOL) return `${name}:${String(a.command).trim().split(/\s+/)[0].toLowerCase()}`;
  if (name === 'WebFetch') { try { return `WebFetch:${new URL(/^https?:/.test(a.url) ? a.url : 'https://' + a.url).hostname}`; } catch { return 'WebFetch'; } }
  return name;
}
async function checkPermission(name, tool, a, ctx) {
  const kind = tool.perm;
  if (!kind) return { ok: true };
  if (state.readonlyTurn && kind === 'edit') return { ok: false, message: 'This is a read-only analysis (/flaws): do not modify files. Describe the change you would make instead.' };
  if (state.mode === 'bypass') return { ok: true };
  if (state.mode === 'plan' && (kind === 'edit' || kind === 'exec')) return { ok: false, message: 'Plan mode is active: you must not modify files or run commands yet. Keep researching with read-only tools, then present your plan with the ExitPlanMode tool.' };
  if (state.mode === 'acceptEdits' && kind === 'edit') return { ok: true };
  const key = permKey(name, a);
  if (state.allow.has(key) || state.allow.has(name)) return { ok: true };
  if (!state.interactive) return { ok: false, message: 'Permission denied: running non-interactively. Re-run with --yolo to allow this.' };
  spinner.stop();
  const ind = ctx.indent + '  ';
  const title = kind === 'edit' ? (fs.existsSync(abs(a.file_path)) ? 'Edit file' : 'Create file') : kind === 'exec' ? `${SHELL_TOOL} command` : name === 'WebSearch' ? 'Web search' : 'Fetch';
  out(ind + C.bamboo('╭─ ' + C.bold(title) + ' ' + C.gray(kind === 'edit' ? rel(abs(a.file_path)) : '')));
  if (tool.preview) for (const l of String(tool.preview(a)).split('\n')) out(ind + C.bamboo('│ ') + l);
  out(ind + C.bamboo('╰─'));
  const always = kind === 'edit' ? 'Yes, allow all edits this session' : `Yes, and don't ask again for ${key.split(':')[1] || name}${kind === 'exec' ? ' commands' : ''}`;
  const STOP = { ok: false, stop: true, message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed." };
  const pi = await ui.select(ind + C.bold('Do you want to proceed?'), [{ label: 'Yes' }, { label: always }, { label: 'No, and tell Panda what to do differently' }]);
  if (pi === 0) return { ok: true };
  if (pi === 1) {
    if (kind === 'edit') state.mode = 'acceptEdits'; else state.allow.add(key);
    return { ok: true };
  }
  if (pi === 2) {
    const fb = (await ui.ask(ind + C.bamboo('tell Panda what to do instead ❯ '))).trim();
    if (!fb || fb === '\x1b' || fb === '\x03') return STOP;
    return { ok: false, message: `The user rejected this tool use and said: ${fb}` };
  }
  return STOP;
}

// ───────────────────────────── tool execution ─────────────────────────────
function printResult(ctx, display, color) {
  if (ctx.quiet && ctx.sub) return; // sub-agent: only headers
  const lines = String(display || '').split('\n');
  lines.forEach((l, i) => out(ctx.indent + (i === 0 ? C.gray('  ⎿  ') : '     ') + (color ? color(l) : l)));
}
async function executeTool(call, ctx) {
  const tool = TOOLS[call.name];
  if (!tool || (ctx.tools && !ctx.tools.includes(call.name))) {
    out(ctx.indent + C.red('● ') + C.bold(call.name) + C.gray(' (unknown tool)'));
    return { content: `Error: No such tool available: ${call.name}. Available tools: ${(ctx.tools || Object.keys(TOOLS)).join(', ')}` };
  }
  let a = call.args;
  if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch (e) { out(ctx.indent + C.red('● ') + C.bold(call.name) + C.red(' (malformed arguments)')); return { content: `Error: tool arguments were not valid JSON (${e.message}). Retry with valid JSON.` }; } }
  if (!a || typeof a !== 'object') a = {};
  if (call.name === 'ImageGen' && !a.file_path) a.file_path = defaultImagePath(a.prompt);
  if (ctx.toolUses !== undefined) ctx.toolUses++;
  let label = ''; try { label = tool.label(a) || ''; } catch { }
  out(ctx.indent + C.bamboo('● ') + C.bold(call.name) + (label ? C.gray('(') + label + C.gray(')') : ''));
  for (const r of tool.schema.required || []) if (a[r] === undefined || a[r] === null) { printResult(ctx, `Missing required parameter: ${r}`, C.red); return { content: `Error: Missing required parameter "${r}" for ${call.name}.` }; }
  const perm = await checkPermission(call.name, tool, a, ctx);
  if (!perm.ok) { printResult(ctx, perm.stop ? 'Rejected by user' : (perm.message.length > 120 ? perm.message.slice(0, 120) + '…' : perm.message), C.red); return { content: perm.message, stop: perm.stop }; }
  if (['Write', 'Edit', 'MultiEdit', 'ImageGen'].includes(call.name) && a.file_path) { try { snapshotForUndo(abs(a.file_path)); } catch { } } // so /undo can roll it back
  const spin = call.name !== 'AskUserQuestion' && call.name !== 'ExitPlanMode' && call.name !== 'Task';
  if (spin && !SP().t) SP().start(call.name === SHELL_TOOL ? 'Running' : VERBS[Math.floor(Math.random() * VERBS.length)]);
  try {
    const r = await tool.run(a, ctx);
    if ((call.name === 'Write' || call.name === 'Edit' || call.name === 'MultiEdit') && a.file_path) { // catch broken code immediately
      const sc = syntaxCheck(abs(a.file_path));
      if (sc) { r.content += sc; r.display = (r.display || '') + '\n' + C.red(sc.trim().split('\n')[0]); }
    }
    if (spin && ctx.depth === 0) SP().stop();
    printResult(ctx, r.display);
    return { content: r.content, stop: r.stop, images: r.images };
  } catch (e) {
    if (spin && ctx.depth === 0) SP().stop();
    const msg = e.name === 'AbortError' ? 'Interrupted by user' : (e.message || String(e));
    printResult(ctx, 'Error: ' + msg.split('\n')[0], C.red);
    return { content: `<tool_use_error>${msg}</tool_use_error>` };
  }
}

// ───────────────────────────── providers ─────────────────────────────
function authHeaders() { const h = { 'Content-Type': 'application/json' }; if (state.apiKey) h.Authorization = 'Bearer ' + state.apiKey; return h; }
async function* readLines(res) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) yield l; }
  }
  if (buf.trim()) yield buf.trim();
}
function toolSpecs(names) { return names.map(n => ({ type: 'function', function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].schema } })); }
function fallbackMessages(msgs) {
  // For models without native tool calling: encode calls/results as text.
  return msgs.map(m => {
    if (m.role === 'assistant' && m.tool_calls?.length) return { role: 'assistant', content: (m.content || '') + m.tool_calls.map(c => `\n<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args })}\n</tool_call>`).join('') };
    if (m.role === 'tool') return { role: 'user', content: `<tool_response name="${m.name}">\n${m.content}\n</tool_response>` };
    return m;
  });
}
async function* streamOllama({ system, messages, tools, signal }) {
  const msgs = [{ role: 'system', content: system }];
  const src = tools ? messages : fallbackMessages(messages);
  for (const m of src) {
    if (m.role === 'assistant') { const o = { role: 'assistant', content: m.content || '' }; if (m.tool_calls?.length) o.tool_calls = m.tool_calls.map(c => ({ function: { name: c.name, arguments: typeof c.args === 'object' ? c.args : {} } })); msgs.push(o); }
    else if (m.role === 'tool') msgs.push({ role: 'tool', content: m.content, tool_name: m.name });
    else msgs.push(m.images?.length ? { role: m.role, content: m.content, images: m.images.map(i => i.data) } : { role: m.role, content: m.content });
  }
  // keep_alive: keep the model in VRAM between turns (Ollama's default unloads it after 5 idle minutes).
  const body = { model: curModel(), messages: msgs, stream: true, keep_alive: state.keepAlive, options: { num_ctx: state.numCtx, num_predict: Math.min(16384, Math.max(4096, Math.floor(state.numCtx * 0.3))) } };
  if (tools) body.tools = toolSpecs(tools);
  { const th = als.getStore()?.think !== undefined ? als.getStore().think : state.think; if (th !== null && th !== undefined) body.think = th; }
  const res = await fetch(state.baseUrl.replace(/\/+$/, '') + '/api/chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 500)}`);
  let n = 0;
  for await (const line of readLines(res)) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.error) throw new Error('Ollama: ' + j.error);
    const m = j.message || {};
    if (m.thinking) yield { type: 'think', text: m.thinking };
    if (m.content) yield { type: 'text', text: m.content };
    if (m.tool_calls?.length) yield { type: 'calls', calls: m.tool_calls.map(c => ({ id: 'call_' + Date.now().toString(36) + (n++), name: c.function?.name, args: c.function?.arguments ?? {} })) };
    if (j.done) yield { type: 'usage', prompt: j.prompt_eval_count || 0, completion: j.eval_count || 0, tps: j.eval_duration ? j.eval_count / (j.eval_duration / 1e9) : 0, prefillMs: (j.prompt_eval_duration || 0) / 1e6, loadMs: (j.load_duration || 0) / 1e6, cachedAware: true };
    if (j.done && j.done_reason) yield { type: 'finish', reason: j.done_reason };
  }
}
async function* streamOpenAI({ system, messages, tools, signal }) {
  const msgs = [{ role: 'system', content: system }];
  const src = tools ? messages : fallbackMessages(messages);
  for (const m of src) {
    if (m.role === 'assistant') { const o = { role: 'assistant', content: m.content || '' }; if (m.tool_calls?.length) o.tool_calls = m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })); msgs.push(o); }
    else if (m.role === 'tool') msgs.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    else msgs.push(m.images?.length ? { role: m.role, content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] } : { role: m.role, content: m.content });
  }
  const body = { model: curModel(), messages: msgs, stream: true, stream_options: { include_usage: true } };
  if (tools) body.tools = toolSpecs(tools);
  const t0 = Date.now();
  const res = await fetch(state.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Server ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const acc = new Map();
  let usage = null, firstTok = 0, finish = null;
  for await (const line of readLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.usage) usage = j.usage;
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
    const d = j.choices?.[0]?.delta || {};
    const think = d.reasoning_content || d.reasoning;
    if (think) { firstTok ||= Date.now(); yield { type: 'think', text: think }; }
    if (d.content) { firstTok ||= Date.now(); yield { type: 'text', text: d.content }; }
    for (const tc of d.tool_calls || []) {
      const k = tc.index ?? acc.size;
      const cur = acc.get(k) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      acc.set(k, cur);
    }
  }
  if (acc.size) yield { type: 'calls', calls: [...acc.values()].map((c, i) => ({ id: c.id || 'call_' + Date.now().toString(36) + i, name: c.name, args: c.args })) };
  if (finish) yield { type: 'finish', reason: finish };
  if (usage) { const secs = (Date.now() - (firstTok || t0)) / 1000; yield { type: 'usage', prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, tps: secs > 0 ? (usage.completion_tokens || 0) / secs : 0 }; }
}
const streamChat = o => state.kind === 'ollama' ? streamOllama(o) : streamOpenAI(o);

async function listModels() { const r = await listModelsRaw(); state.modelNames = r.map(m => m.name); return r; }
async function listModelsRaw() {
  const base = state.baseUrl.replace(/\/+$/, '');
  if (state.kind === 'ollama') {
    const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return (j.models || []).map(m => ({ name: m.name, caps: m.capabilities || null, ctx: m.details?.context_length || 0, size: m.size }));
  }
  const r = await fetch(base + '/models', { headers: authHeaders(), signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  return (j.data || []).map(m => ({ name: m.id }));
}
async function detectProviders() {
  const ollamaHost = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : 'http://' + process.env.OLLAMA_HOST) : 'http://localhost:11434';
  const cands = [
    { name: 'Ollama', kind: 'ollama', url: ollamaHost, probe: '/api/tags' },
    { name: 'LM Studio', kind: 'openai', url: 'http://localhost:1234/v1', probe: '/models' },
    { name: 'llama.cpp', kind: 'openai', url: 'http://localhost:8080/v1', probe: '/models' },
    { name: 'Jan', kind: 'openai', url: 'http://localhost:1337/v1', probe: '/models' },
    { name: 'vLLM', kind: 'openai', url: 'http://localhost:8000/v1', probe: '/models' },
    { name: 'KoboldCpp', kind: 'openai', url: 'http://localhost:5001/v1', probe: '/models' },
    { name: 'text-gen-webui', kind: 'openai', url: 'http://localhost:5000/v1', probe: '/models' },
  ];
  const found = await Promise.all(cands.map(async c => { try { const r = await fetch(c.url + c.probe, { signal: AbortSignal.timeout(1500) }); return r.ok ? c : null; } catch { return null; } }));
  return found.filter(Boolean);
}

// ───────────────────────────── system prompt ─────────────────────────────
function projectInstructions() {
  const files = [path.join(HOME_DIR, 'PANDA.md'), path.join(state.cwd, 'PANDA.md'), path.join(state.cwd, 'AGENTS.md'), path.join(state.cwd, 'CLAUDE.md')];
  const parts = [];
  for (const f of files) { try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) parts.push(`Contents of ${f}:\n${t.slice(0, 20000)}`); } catch { } }
  return parts.join('\n\n');
}
// A small, stable overview of the project so the model starts oriented instead of spending steps on exploring.
let SNAP = { cwd: '', text: '' };
function projectSnapshot(opts = {}) {
  if (opts.sub || opts.side) return '';
  if (SNAP.cwd === state.cwd) return SNAP.text;
  let text = '';
  try {
    const files = [];
    for (const f of walk(state.cwd, { maxDepth: 2 })) { files.push(posix(path.relative(state.cwd, f))); if (files.length >= 60) break; }
    const parts = [];
    if (files.length) parts.push(`Top-level files (up to 60): ${files.join(', ')}`);
    const pj = path.join(state.cwd, 'package.json');
    if (fs.existsSync(pj)) { const j = JSON.parse(fs.readFileSync(pj, 'utf8')); parts.push(`package.json: ${j.name || '(unnamed)'}; scripts: ${Object.keys(j.scripts || {}).join(', ') || 'none'}`); }
    for (const m of ['pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'Makefile', 'Dockerfile']) if (fs.existsSync(path.join(state.cwd, m))) parts.push('has ' + m);
    if (parts.length) text = '\nProject snapshot:\n' + parts.join('\n');
  } catch { }
  SNAP = { cwd: state.cwd, text };
  return text;
}
function buildSystemPrompt(opts) {
  if (opts.side) return sideSystemPrompt(opts);
  const isGit = fs.existsSync(path.join(state.cwd, '.git'));
  let s = `You are Panda Code, an interactive CLI coding agent running in the user's terminal. You help with software engineering tasks: fixing bugs, adding features, refactoring, explaining code, running commands and more. You have tools to read, write and edit files, search the codebase, run shell commands, browse the web and track tasks. USE THEM: do the work, don't just describe it.

# Tone and style
- Be concise and direct. Your output is shown in a terminal that renders basic markdown. Skip preamble ("Sure!", "Great question") and postamble summaries unless asked. Keep answers under 4 lines unless the user asks for detail or the task needs it.
- No emojis unless the user asks. Never invent file contents, paths, APIs or command output; if unsure, look it up with your tools.
- When referencing code, use the pattern file_path:line_number.

# Doing tasks
1. Understand first: explore with Glob, Grep, LS and Read before changing code. Prefer these over shell commands for file operations.
2. Plan: for tasks with 3+ steps, use TodoWrite to track steps; keep exactly one in_progress and mark items completed as soon as they are done.
3. Implement: use Edit/MultiEdit for existing files (Read them first) and Write only for new files or full rewrites. Match the existing code style and conventions; check what libraries the project already uses before adding new ones. Don't add comments unless asked. Don't create README/docs files unless asked.
4. Verify: run the project's build, tests, type-checker or linter with the ${SHELL_TOOL} tool when available, and fix what fails.
- Call several independent tools in one response when possible (e.g. read multiple files at once).
- If the user rejects a tool call, do not retry it as-is; adjust or ask.
- Never commit, push or do destructive operations (deleting files, git reset --hard, etc.) unless the user asked.

# Working rules (follow these closely)
- Act, don't narrate: never say you edited, ran or checked something unless you actually called the tool and saw its result. Report real output.
- Read a file before you change it. Keep edits small and targeted; do not rewrite whole files to change a few lines.
- After every change, check it: look at the syntax-check result the tool returns, then run the tests, build or the program itself. If something fails, read the error, fix the cause, and run it again. Never repeat a failed call unchanged.
- Don't stop to ask questions you can answer yourself by reading the code. Only ask when the request is truly ambiguous or a decision is the user's to make; otherwise make a sensible assumption and say what it was.
- Find things with Grep and Glob before reading whole files. Read big files in sections with offset and limit.
- Finish the whole task. When done, say in at most 3 lines what changed, how you verified it, and anything you could not verify.

# Shell
- The shell tool is ${SHELL_TOOL}${IS_WIN ? ' (Windows PowerShell 5.1). Use PowerShell syntax: no `&&`/`||`; use `;` or `if ($?) { }`. Use Get-ChildItem, Select-String, etc. when you really need the shell for that.' : ' (bash).'}
- Quote paths containing spaces. Avoid interactive commands (stdin is closed). Use run_in_background for dev servers and watchers.

# Environment
Working directory: ${state.cwd}
Is a git repository: ${isGit ? 'yes' : 'no'}
Platform: ${process.platform} (${os.type()} ${os.release()})
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${curModel()}${projectSnapshot(opts)}`;
  if (state.mode === 'plan' && !opts.sub) s += `\n\n# PLAN MODE IS ACTIVE\nThe user wants a plan before any changes. You MUST NOT edit files, write files or run commands that change anything. Research with read-only tools (Read, Glob, Grep, LS, WebFetch, WebSearch), then call ExitPlanMode with a concise plan. Do not make changes until the plan is approved.`;
  if (opts.sub) s += `\n\n# Sub-agent\nYou are a sub-agent launched to complete one task. Work autonomously with your tools, then reply with a single, complete final report of your findings or results (include file paths and key details). The report is returned to the main agent, not the user.`;
  const pi = projectInstructions();
  if (pi && !opts.sub) s += `\n\n# Project instructions\nThe user's instructions below OVERRIDE default behavior; follow them exactly.\n\n${pi}`;
  if (session.summary && !opts.sub) s += `\n\n# Summary of the earlier conversation (compacted)\n${session.summary}`;
  // NOTE: keep this prompt stable between requests. Anything that changes here (e.g. todos)
  // invalidates the server's prompt cache and forces a full re-read of the conversation.
  if (!curNative()) {
    const names = opts.tools || Object.keys(TOOLS);
    s += `\n\n# Tools\nYou can call tools. To call a tool, output EXACTLY this format (JSON inside the tags), then stop and wait for the result:\n<tool_call>\n{"name": "ToolName", "arguments": {"param": "value"}}\n</tool_call>\nYou may output several tool_call blocks in one reply. Results arrive in <tool_response> messages. When the task is done, reply normally without any tool_call.\n\nAvailable tools:\n` +
      names.map(n => `## ${n}\n${TOOLS[n].description}\nParameters (JSON Schema): ${JSON.stringify(TOOLS[n].schema)}`).join('\n\n');
  }
  return s;
}

// ───────────────────────────── agent loop ─────────────────────────────
function parseTextToolCalls(text) {
  const calls = []; const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g; let m, i = 0;
  while ((m = re.exec(text))) {
    try {
      let raw = m[1].trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const j = JSON.parse(raw);
      calls.push({ id: 'call_t' + Date.now().toString(36) + (i++), name: j.name || j.tool, args: j.arguments ?? j.parameters ?? j.args ?? {} });
    } catch { }
  }
  return calls;
}
async function modelTurn(messages, opts) {
  const sys = buildSystemPrompt(opts);
  const tools = opts.tools || Object.keys(TOOLS);
  const md = new MD(l => out(l), opts.indent);
  const thinkMd = { buf: '', push(t) { this.buf += t; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (l.trim()) out(opts.indent + C.gray(C.italic('  ✻ ' + l))); } }, end() { if (this.buf.trim()) out(opts.indent + C.gray(C.italic('  ✻ ' + this.buf))); this.buf = ''; } };
  let text = '', calls = [], usage = null, finish = null;
  if (!SP().t) SP().start();
  opts.partial = '';
  try {
    for await (const ev of streamChat({ system: sys, messages, tools: curNative() ? tools : null, signal: opts.signal })) {
      if (ev.type === 'think') { SP().tokens++; SP().set('Thinking'); if (state.showThinking && !opts.quiet) thinkMd.push(ev.text); }
      else if (ev.type === 'text') {
        if (SP().label === 'Thinking') { thinkMd.end(); SP().set(VERBS[Math.floor(Math.random() * VERBS.length)]); }
        SP().tokens++; text += ev.text; opts.partial = text; if (!opts.quiet) md.push(ev.text);
      }
      else if (ev.type === 'calls') calls.push(...ev.calls);
      else if (ev.type === 'usage') usage = ev;
      else if (ev.type === 'finish') finish = ev.reason;
    }
  } finally { thinkMd.end(); if (!opts.quiet) md.end(); }
  if (opts.depth === 0 || !SP().t) SP().stop();
  if (usage) {
    // Ollama's prompt count excludes tokens served from its prompt cache, so estimate the true context size too.
    if (opts.depth === 0) state.lastPrompt = usage.cachedAware ? Math.max(usage.prompt + usage.completion, estimateTokens(messages) + usage.completion) : usage.prompt + usage.completion;
    state.totalIn += usage.prompt; state.totalOut += usage.completion; state.lastTps = usage.tps;
    if (process.env.PANDA_DEBUG) process.stderr.write(`[panda] prefill ${usage.prompt} tok${usage.prefillMs != null ? ` in ${usage.prefillMs.toFixed(0)}ms` : ''}${usage.loadMs > 50 ? ` · model load ${usage.loadMs.toFixed(0)}ms` : ''} · gen ${usage.completion} tok @ ${usage.tps.toFixed(1)} tok/s\n`);
  }
  if (!calls.length && text.includes('<tool_call>')) calls = parseTextToolCalls(text);
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  return { text, calls, finish };
}
async function agentLoop(messages, opts) {
  let overflow = 0, cont = 0; const fails = new Map();
  for (let step = 0; step < 150; step++) {
    if (opts.depth === 0) await maybeCompact(opts);
    let r;
    try { r = await modelTurn(messages, opts); }
    catch (e) {
      if (curNative() && /does not support tools|tool.*not supported|tools.*unsupported|"tools".*(unknown|invalid)/i.test(e.message || '')) {
        setNative(false);
        out(C.yellow(`  ⚠ ${state.model} has no native tool calling — switching to text-based tool calls.`));
        step--; continue;
      }
      // The model can't take images: strip them from the conversation and carry on with the text.
      if (/image input is not supported|does not support (image|vision)|mmproj|multimodal|doesn't support image/i.test(e.message || '') && messages.some(m => m.images?.length)) {
        state.vision = false; SP().stop();
        for (const m of messages) if (m.images?.length) { m.content = (m.content || '') + '\n[image removed: this model cannot see images]'; m.images = null; }
        out(C.yellow(`  ⚠ ${state.model} can't see images, so Panda carried on without them. Switch to a vision model with /model.`));
        step--; continue;
      }
      // The server rejected the request because the conversation no longer fits: shrink it and retry.
      if (opts.depth === 0 && overflow < 2 && /(context|prompt|input).{0,40}(length|window|limit|exceed|too long|too large)|maximum context|too many tokens|exceeds? the (maximum|model)/i.test(e.message || '')) {
        overflow++; SP().stop();
        out(C.yellow('  ⚠ Context limit hit — compacting and retrying…'));
        await maybeCompact(opts, true);
        step--; continue;
      }
      throw e;
    }
    messages.push(r.calls.length ? { role: 'assistant', content: r.text, tool_calls: r.calls } : { role: 'assistant', content: r.text });
    if (!r.calls.length) {
      // The reply was cut off by the output-token limit: ask the model to carry on instead of ending mid-sentence.
      if (r.finish === 'length' && cont < 5) {
        cont++;
        out(C.gray('  ⎿  output limit reached — continuing…'));
        messages.push({ role: 'user', content: '[Your previous reply hit the output token limit and was cut off. Continue exactly where you stopped. Do not repeat anything.]' });
        continue;
      }
      return r.text;
    }
    let stop = false; const imgs = [];
    for (const call of r.calls) {
      if (stop || opts.signal.aborted) { messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'Tool use was cancelled.' }); continue; }
      const res = await executeTool(call, opts);
      if (/^<tool_use_error>|^Error:/.test(String(res.content))) { // the same failing call over and over: tell the model to change course
        const sig = call.name + ':' + JSON.stringify(call.args), n = (fails.get(sig) || 0) + 1; fails.set(sig, n);
        if (n >= 2) res.content += `\n[Panda: this exact call has now failed ${n} times. Do not repeat it. Re-read the file or try a different approach.]`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: String(res.content ?? '') });
      if (res.stop) stop = true;
      if (res.images) imgs.push(...res.images);
    }
    if (imgs.length) messages.push({ role: 'user', content: '[Image(s) from the tool result above]', images: imgs });
    if (opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (stop) { if (opts.depth === 0) out(C.gray('  ⎿  ') + C.yellow('What should Panda do instead?')); return null; }
    if (opts.depth === 0 && !SP().t) SP().start();
  }
  out(C.yellow('  ⚠ Stopped after 150 steps.'));
  return null;
}

// ───────────────────────────── compaction ─────────────────────────────
let TOOL_SCHEMA_CHARS = 0;
function estimateTokens(msgs) {
  if (!TOOL_SCHEMA_CHARS) TOOL_SCHEMA_CHARS = JSON.stringify(toolSpecs(Object.keys(TOOLS))).length;
  let c = buildSystemPrompt({}).length + (state.nativeTools ? TOOL_SCHEMA_CHARS : 0);
  for (const m of msgs) c += (m.content || '').length + JSON.stringify(m.tool_calls || '').length + 12 + (m.images ? m.images.length * 3800 : 0); // ~1200 tokens per image
  return Math.ceil(c / 3.2);
}
const ctxUsed = msgs => Math.max(state.lastPrompt, estimateTokens(msgs));
// Cheap first step: old tool results (file dumps, command output) are the bulk of the context and rarely needed again.
function clearOldToolResults(msgs, keepLast = 6) {
  let freed = 0;
  for (let i = 0; i < msgs.length - keepLast; i++) {
    const m = msgs[i];
    if (m.images?.length) { freed += m.images.length * 3800; m.content = (m.content || '') + '\n[image removed to save context]'; m.images = null; }
    if (m.role === 'tool' && !m.cleared && String(m.content).length > 400) {
      freed += String(m.content).length;
      m.content = `[Old ${m.name} result cleared to save context (${String(m.content).length} chars). Run the tool again if you need it.]`;
      m.cleared = true;
    }
  }
  return freed;
}
// Last resort if summarizing fails: drop the oldest messages (keeping turn boundaries intact).
function hardTrim(msgs, target = 0.5) {
  let lastUser = 0;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
  // drop whole old turns (user message + everything the agent did for it), never the latest request
  while (estimateTokens(msgs) > state.numCtx * target) {
    const next = msgs.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next === -1 || next > lastUser) break;
    msgs.splice(0, next); lastUser -= next;
  }
  if (estimateTokens(msgs) > state.numCtx * target) clearOldToolResults(msgs, 2);
  while (msgs.length > 1 && msgs[0].role !== 'user') msgs.shift();
}
function lastUserRequest(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m.role === 'user' && !/^\[(Request interrupted|previous request failed|Your previous reply)/.test(m.content || '') && !/^\(Earlier conversation was compacted/.test(m.content || '')) return m.content; }
  return '';
}
// Keeps the conversation inside the context window so nothing is silently dropped by the server.
async function maybeCompact(opts, force = false) {
  const msgs = session.messages;
  if (!force && ctxUsed(msgs) < state.numCtx * 0.5) return;
  if (clearOldToolResults(msgs) > 0) state.lastPrompt = 0;
  if (!force && estimateTokens(msgs) < state.numCtx * 0.6) return;
  if (msgs.length < 3) { hardTrim(msgs); return; }
  spinner.stop();
  out(C.gray(`  ✻ Context ${Math.min(100, Math.round(100 * ctxUsed(msgs) / state.numCtx))}% full — compacting the conversation so Panda can keep going…`));
  const request = lastUserRequest(msgs);
  try {
    await compact('', opts.signal);
    msgs.push({ role: 'user', content: `(Earlier conversation was compacted into the summary in your system prompt.) My most recent request was:\n\n${String(request).slice(0, 6000)}\n\nContinue working on it from where you left off.` });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    out(C.yellow('  ⚠ Could not summarize (' + (e.message || e) + ') — dropping the oldest messages instead.'));
    hardTrim(msgs);
  }
  state.lastPrompt = 0;
}
async function compact(instructions, signal) {
  const msgs = session.messages;
  let transcript = msgs.map(m => {
    if (m.role === 'tool') return `[tool result: ${m.name}]\n${String(m.content).slice(0, 1500)}`;
    let s = `[${m.role}]\n${m.content || ''}`;
    if (m.tool_calls) s += '\n' + m.tool_calls.map(c => `[tool call: ${c.name} ${JSON.stringify(c.args).slice(0, 600)}]`).join('\n');
    return s;
  }).join('\n\n');
  const maxChars = Math.floor(state.numCtx * 1.8);
  if (transcript.length > maxChars) transcript = '…(earlier part truncated)…\n' + transcript.slice(-maxChars);
  if (session.summary) transcript = `[earlier summary]\n${session.summary}\n\n` + transcript;
  const prompt = `Summarize the coding conversation below so the work can continue seamlessly in a fresh context. Include:\n1. The user's requests and intent (quote key instructions)\n2. Key technical decisions and concepts\n3. Files read, created or modified (with paths) and important code details\n4. Errors encountered and how they were fixed\n5. Current state of the work and pending tasks\n6. The exact next step\nBe thorough but concise.${instructions ? `\n\nAdditional focus: ${instructions}` : ''}\n\n<conversation>\n${transcript}\n</conversation>`;
  spinner.start('Compacting');
  let text = '';
  const savedThink = state.think;
  state.think = false; // summaries don't need a long reasoning phase; skipping it makes compaction several times faster
  try {
    for await (const ev of streamChat({ system: 'You summarize software engineering conversations accurately and concisely.', messages: [{ role: 'user', content: prompt }], tools: null, signal })) {
      if (ev.type === 'text') { text += ev.text; spinner.tokens++; } else if (ev.type === 'think') spinner.tokens++;
    }
  } finally { state.think = savedThink; spinner.stop(); }
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('Compaction failed: the model returned an empty summary.');
  session.summary = text;
  msgs.length = 0;
  state.lastPrompt = 0;
  out(C.gray('  ⎿  Conversation compacted') + C.gray(` (${fmtK(text.length)} char summary)`));
}

// ───────────────────────────── sessions ─────────────────────────────
function saveSession() {
  if (!session.messages.length) return;
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(path.join(SESSIONS_DIR, session.id + '.json'), JSON.stringify({ ...session, messages: session.messages.map(m => m.images?.length ? { ...m, images: undefined, content: (m.content || '') + ' [image omitted]' } : m), cwd: state.cwd, model: state.model, todos: state.todos, updated: Date.now() })); } catch { }
}
function listSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).map(f => { const p = path.join(SESSIONS_DIR, f); return { p, m: fs.statSync(p).mtimeMs }; }).sort((a, b) => b.m - a.m).slice(0, 15)
      .map(x => { try { return { ...JSON.parse(fs.readFileSync(x.p, 'utf8')), _m: x.m }; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function loadSession(s) {
  session = { id: s.id, cwd: s.cwd, created: s.created, messages: s.messages || [], summary: s.summary || '' };
  state.todos = s.todos || [];
  if (s.cwd && fs.existsSync(s.cwd)) { state.cwd = s.cwd; try { process.chdir(s.cwd); } catch { } }
  state.read.clear(); state.lastPrompt = 0;
}

// ───────────────────────────── terminal UI ─────────────────────────────
// ───────────────────────────── /btw side agent ─────────────────────────────
// A second, READ-ONLY agent that slides out in its own pane (headed "Question") while the main agent keeps working.
// Before answering it reads the whole conversation and the project, then can use Read/Glob/Grep/LS to look deeper.
const SIDE_PROFILES = [
  { id: 'explore', label: 'Explorer', desc: 'answers questions about the code and the conversation', extra: '' },
  { id: 'review', label: 'Reviewer', desc: 'critiques the work so far: bugs, risks, missed cases', extra: 'Act as a careful, skeptical code reviewer. Look at the changes the main agent has made or is about to make. Point out bugs, risky assumptions, missing edge cases and simpler alternatives, most important first, and say what you verified by reading the code.' },
  { id: 'teach', label: 'Explainer', desc: 'explains how the code works in plain language', extra: 'Explain things in plain language for someone new to this code base: what it does, how the pieces connect and why. Use short examples.' },
];
const SIDE_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
const side = {
  open: false, slide: 0, target: 0, timer: null, tick: null, frame: 0,
  log: { lines: [], add(s) { for (const l of String(s).replace(/\r/g, '').split('\n')) this.lines.push(l.replace(/\t/g, '    ')); if (this.lines.length > 3000) this.lines.splice(0, this.lines.length - 2000); } },
  msgs: [], seen: 0, running: false, abort: null, status: '',
  profile: 'explore', model: null, caps: null,
  width(cols) { if (this.slide < 0.02) return 0; return Math.max(20, Math.round(Math.floor((cols - 1) / 2) * this.slide)); },
  setOpen(b) {
    if (b) {
      const cols = process.stdout.columns || 80;
      if (!hdr.on) { out(C.yellow('  The side pane needs the pinned layout. Turn it on with /pin on.')); return false; }
      if (cols < 90) { out(C.yellow('  The window is too narrow for a side pane (needs 90+ columns).')); return false; }
      this.open = true;
    }
    this.target = b ? 1 : 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => { // slide in/out
      this.slide += (this.target - this.slide) * 0.4;
      if (Math.abs(this.target - this.slide) < 0.03) { this.slide = this.target; clearInterval(this.timer); this.timer = null; if (!this.target) this.open = false; }
      paint();
    }, 24);
    return true;
  },
  startTick() { clearInterval(this.tick); this.tick = setInterval(() => { this.frame++; schedulePaint(); }, 140); },
  stopTick() { clearInterval(this.tick); this.tick = null; },
  rows(W, H) {
    const prof = SIDE_PROFILES.find(p => p.id === this.profile) || SIDE_PROFILES[0];
    const mdl = String(this.model || state.model || '').replace(/:latest$/, '');
    const rows = [wrapAnsi(C.bamboo(' ❯ ') + C.bold(C.white('Question')) + C.gray(` · ${prof.label} · read-only · ${mdl}`), W)[0], C.ink('─'.repeat(W))];
    const all = [];
    for (const l of this.log.lines) for (const r of wrapCached(l, W - 1)) all.push(' ' + r);
    rows.push(...all.slice(-Math.max(1, H - 3)));
    while (rows.length < H - 1) rows.push('');
    rows.push(this.running ? C.leaf(' ' + FRAMES[this.frame % 4] + ' ' + (this.status || 'Working') + '…') + C.gray('  (esc to stop)') : C.gray(' /btw <question> · agent · model · close'));
    return rows.slice(0, H);
  },
};
function sideSystemPrompt(opts) {
  const prof = SIDE_PROFILES.find(p => p.id === opts.profile) || SIDE_PROFILES[0];
  let s = `You are Panda Code's side assistant. The user opened you with /btw while the main Panda agent works on their task in another pane. You answer their quick questions about the project and about what the main agent is doing or has done.

# Rules
- You are READ-ONLY. You can read files and search (Read, Glob, Grep, LS). You cannot edit, write, run commands or change anything. If the user wants something changed, say exactly what to change, or tell them to ask the main agent.
- You were given an overview of the project and of the main conversation so far. Use your tools to look deeper whenever that is not enough. Never guess file contents.
- Be concise and direct: a few short paragraphs at most, no preamble. Cite code as file_path:line_number.
- If the question is ambiguous or the answer depends on the user's goals, ask one short clarifying question.${prof.extra ? '\n\n# Your role\n' + prof.extra : ''}

# Environment
Working directory: ${state.cwd}
Platform: ${process.platform}
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${curModel()}`;
  if (!curNative()) {
    const names = opts.tools || SIDE_TOOLS;
    s += `\n\n# Tools\nYou can call tools. To call a tool, output EXACTLY this format (JSON inside the tags), then stop and wait for the result:\n<tool_call>\n{"name": "ToolName", "arguments": {"param": "value"}}\n</tool_call>\nResults arrive in <tool_response> messages. When you can answer, reply normally without any tool_call.\n\nAvailable tools:\n` +
      names.map(n => `## ${n}\n${TOOLS[n].description}\nParameters (JSON Schema): ${JSON.stringify(TOOLS[n].schema)}`).join('\n\n');
  }
  return s;
}
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.lua', '.sh', '.ps1', '.bat', '.json', '.toml', '.yml', '.yaml', '.xml', '.html', '.css', '.scss', '.md', '.txt', '.sql', '.vue', '.svelte', '.gradle', '.ini', '.cfg', '.dart', '.zig']);
// Reads the project into one text block: the full file list plus the contents of as many files as fit in the budget.
function projectDigest(budget) {
  const root = state.cwd, all = [];
  for (const f of walk(root, { maxDepth: 8 })) { all.push(f); if (all.length > 4000) break; }
  const rank = f => {
    const b = path.basename(f).toLowerCase(), depth = posix(path.relative(root, f)).split('/').length;
    if (/^(readme|panda|claude|agents)(\.|$)/.test(b)) return [0, depth, 0];
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|makefile|dockerfile|tsconfig\.json|pom\.xml|build\.gradle)$|\.(csproj|sln)$/.test(b)) return [1, depth, 0];
    let sz = 0; try { sz = fs.statSync(f).size; } catch { }
    return [2, depth, sz];
  };
  const isText = f => CODE_EXT.has(path.extname(f).toLowerCase()) || /^(readme|makefile|dockerfile|license)/i.test(path.basename(f));
  const skip = f => /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)|\.map)$/i.test(f);
  const cand = all.filter(f => isText(f) && !skip(f)).map(f => ({ f, r: rank(f) })).sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2]);
  const tree = all.map(f => posix(path.relative(root, f))).sort().slice(0, 600);
  const treeText = tree.join('\n') + (all.length > tree.length ? `\n… and ${all.length - tree.length} more files` : '');
  let used = treeText.length, bytes = 0, n = 0;
  const parts = [];
  for (const { f } of cand) {
    let t;
    try { if (fs.statSync(f).size > 300000) continue; t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.includes('\0')) continue;
    if (t.length > 12000) t = t.slice(0, 12000) + '\n… [file truncated]';
    const block = `<file path="${posix(path.relative(root, f))}">\n${t}\n</file>\n`;
    if (used + block.length > budget) { if (budget - used < 2000) break; continue; }
    parts.push(block); used += block.length; bytes += t.length; n++;
  }
  return { text: `Working directory: ${root}\n\nAll files (${all.length}):\n${treeText}\n\n${parts.join('')}`, nFiles: n, nListed: all.length, bytes };
}
// Turns the main conversation (from message #`from` on) into plain text.
function chatDigest(budget, from = 0) {
  const msgs = session.messages.slice(from), lines = [];
  for (const m of msgs) {
    if (m.role === 'user') lines.push('USER: ' + String(m.content || '').slice(0, 1500) + (m.images?.length ? ' [+image]' : ''));
    else if (m.role === 'assistant') { if (m.content) lines.push('PANDA: ' + String(m.content).slice(0, 1500)); for (const c of m.tool_calls || []) lines.push(`PANDA ran ${c.name}(${JSON.stringify(c.args).slice(0, 200)})`); }
    else if (m.role === 'tool') lines.push(`  → ${m.name} result: ${String(m.content).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  let text = lines.join('\n');
  if (text.length > budget) text = '… [older messages omitted]\n' + text.slice(-budget);
  if (!from && session.summary) text = 'Summary of the earlier conversation:\n' + session.summary + '\n\n' + text;
  return { text, n: msgs.length };
}
async function askSide(q) {
  if (side.running) { side.log.add(C.yellow('  Still answering the previous question. /btw stop cancels it.')); schedulePaint(); return; }
  if (!side.open || !side.target) { if (!side.setOpen(true)) return; }
  side.running = true; side.abort = new AbortController(); side.status = 'Reading'; side.startTick();
  side.log.add(''); side.log.add(C.bamboo('❯ ') + C.bold(C.white(q)));
  schedulePaint();
  try {
    await new Promise(r => setTimeout(r, 60)); // let the pane paint before the (synchronous) reading starts
    // keep the side chat inside the context window
    if (side.msgs.reduce((a, m) => a + String(m.content || '').length, 0) / 3.2 > state.numCtx * 0.65) {
      clearOldToolResults(side.msgs, 4);
      if (side.msgs.reduce((a, m) => a + String(m.content || '').length, 0) / 3.2 > state.numCtx * 0.65) { side.msgs.length = 0; side.log.add(C.gray('  (side chat was reset to save context)')); }
    }
    const first = !side.msgs.length;
    if (first || session.messages.length < side.seen) side.seen = 0;
    const budget = Math.floor(state.numCtx * 0.4 * 3.2);
    let content = q;
    if (first) {
      side.log.add(C.gray('  ◐ Reading the whole conversation and the project…')); schedulePaint();
      await new Promise(r => setTimeout(r, 30));
      const chat = chatDigest(Math.floor(budget * 0.4), 0), proj = projectDigest(Math.max(4000, budget - chat.text.length));
      side.log.add(C.gray(`  ✓ Read ${chat.n} chat messages and ${proj.nFiles} project files (${Math.round(proj.bytes / 1024)} KB, ${proj.nListed} files listed)`));
      content = `<project_overview>\n${proj.text}\n</project_overview>\n\n<main_conversation>\n${chat.text || '(nothing yet)'}\n</main_conversation>\n\nQuestion: ${q}`;
    } else if (session.messages.length > side.seen) {
      const upd = chatDigest(Math.floor(budget * 0.3), side.seen);
      content = `<main_conversation_update>\n${upd.text}\n</main_conversation_update>\n\nQuestion: ${q}`;
    }
    side.seen = session.messages.length;
    side.msgs.push({ role: 'user', content });
    side.status = 'Thinking';
    const opts = { signal: side.abort.signal, depth: 1, indent: '', quiet: false, side: true, profile: side.profile, tools: SIDE_TOOLS };
    const store = { side: true, out: l => { side.log.add(l); schedulePaint(); }, model: side.model || state.model, nativeTools: side.model ? (side.caps ? side.caps.includes('tools') : true) : state.nativeTools, think: false };
    await als.run(store, () => agentLoop(side.msgs, opts));
  } catch (e) {
    const l = side.msgs[side.msgs.length - 1];
    if (l && l.role === 'assistant' && l.tool_calls) side.msgs.pop(); // don't leave a dangling tool call behind
    side.log.add(e.name === 'AbortError' || side.abort?.signal.aborted ? C.gray('  ⎿  stopped') : C.red('  ⎿  ' + (e.message || e)));
  } finally { side.running = false; side.stopTick(); side.log.add(''); schedulePaint(); }
}
async function handleBtw(arg) {
  const a = arg.trim(), lo = a.toLowerCase();
  const hint = () => { if (!side.log.lines.length) side.log.add(C.gray('  Ask me anything about the project or what the main agent is doing.\n  I read the whole conversation and the project first, and I can only read, never write.\n\n  /btw <question>   ask\n  /btw agent        pick Explorer / Reviewer / Explainer\n  /btw model        pick which model answers\n  /btw refresh      re-read everything on the next question\n  /btw clear        wipe this side chat\n  /btw close        slide the pane away')); };
  if (!a) { if (side.open && side.target) side.setOpen(false); else if (side.setOpen(true)) hint(); return; }
  if (lo === 'close') { side.setOpen(false); return; }
  if (lo === 'stop') { side.abort?.abort(); return; }
  if (lo === 'clear') { side.msgs.length = 0; side.log.lines.length = 0; side.seen = 0; hint(); schedulePaint(); return; }
  if (lo === 'refresh') { side.msgs.length = 0; side.seen = 0; side.log.add(C.gray('  ⎿  will re-read the conversation and project on the next question')); schedulePaint(); return; }
  if (lo === 'agent') {
    const i = await ui.select('  ' + C.bold('Which side agent? (all are read-only)'), SIDE_PROFILES.map(p => ({ label: p.label, desc: C.gray(p.desc) })), { current: SIDE_PROFILES.findIndex(p => p.id === side.profile) });
    if (i >= 0) { side.profile = SIDE_PROFILES[i].id; side.msgs.length = 0; side.setOpen(true); side.log.add(C.gray(`  ⎿  side agent: ${SIDE_PROFILES[i].label}`)); schedulePaint(); }
    return;
  }
  if (lo === 'model') {
    let ms = []; try { ms = await listModels(); } catch (e) { out(C.red('  Could not list models: ' + e.message)); return; }
    const items = [{ label: `Same as the main agent (${state.model})`, desc: C.gray('shares the loaded model; answers wait for the main agent\'s current step') }].concat(ms.map(m => ({ label: m.name, desc: C.gray([m.size ? (m.size / 1e9).toFixed(1) + 'GB' : '', m.caps?.includes('tools') ? 'tools' : 'no tools'].filter(Boolean).join(' · ')) })));
    const i = await ui.select('  ' + C.bold('Which model answers /btw questions?') + C.gray('  (a different model may make Ollama swap models in VRAM)'), items, { current: side.model ? 1 + ms.findIndex(m => m.name === side.model) : 0 });
    if (i < 0) return;
    side.model = i === 0 ? null : ms[i - 1].name; side.caps = i === 0 ? null : ms[i - 1].caps; side.msgs.length = 0;
    side.setOpen(true); side.log.add(C.gray(`  ⎿  side model: ${side.model || 'same as main'}`)); schedulePaint();
    return;
  }
  askSide(a).catch(e => out(C.red('  ⎿  ' + (e.message || e)))); // runs in the background; the main prompt stays free
}

const SLASH = ['/help', '/clear', '/compact', '/model', '/models', '/provider', '/mode', '/plan', '/yolo', '/ctx', '/fast', '/pin', '/mouse', '/paste', '/btw', '/flaws', '/imagine', '/undo', '/update', '/think', '/init', '/todos', '/cost', '/status', '/resume', '/cd', '/bashes', '/tools', '/memory', '/config', '/exit'];
const ui = {
  ghost: '', skipTab: false, menuLines: null, inSelect: false,
  rl: null, pending: null, queue: [], busy: false, lines: [], timer: null, cont: '', lastSig: 0, abort: null, handler: null,
  init() {
    // our key handler is registered before readline's own, so ghost text and Tab are handled first
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (s, k) => this.onKey(s, k));
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 500, completer: l => this.complete(l), tabSize: 2 });
    try { this.rl.history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { }
    this.rl.on('line', l => this.onLine(l));
    this.rl.on('SIGINT', () => this.onSigint());
    this.rl.on('close', () => shutdown());
  },
  complete(line) {
    if (this.skipTab) { this.skipTab = false; return [[], line]; } // Tab was just used to accept the ghost text
    if (line.startsWith('/') && !line.includes(' ')) { const h = SLASH.filter(c => c.startsWith(line)); return [h.length ? h : SLASH, line]; }
    const m = line.match(/@([^\s]*)$/);
    if (m) {
      const frag = m[1].replace(/\\/g, '/');
      const dirPart = frag.includes('/') ? frag.slice(0, frag.lastIndexOf('/') + 1) : '';
      const base = frag.slice(dirPart.length);
      try {
        const ents = fs.readdirSync(abs(dirPart || '.'), { withFileTypes: true }).filter(e => e.name.toLowerCase().startsWith(base.toLowerCase()) && !SKIP_DIRS.has(e.name));
        const pre = line.slice(0, line.length - m[1].length);
        return [ents.slice(0, 50).map(e => pre + dirPart + e.name + (e.isDirectory() ? '/' : '')), line];
      } catch { }
    }
    return [[], line];
  },
  promptStr() {
    const tag = state.mode === 'acceptEdits' ? C.pink('⏵⏵ edits ') : state.mode === 'plan' ? C.cyan('⏸ plan ') : state.mode === 'bypass' ? C.red('⚠ yolo ') : '';
    return tag + (pendingImages.length ? C.cyan(`📎${pendingImages.length} `) : '') + C.bamboo('❯ ');
  },
  dividerStr() {
    const w = Math.min((process.stdout.columns || 80) - 1, 139);
    const used = session.messages.length ? Math.max(state.lastPrompt, estimateTokens(session.messages)) : 0;
    const pct = Math.min(100, Math.round(100 * used / state.numCtx));
    const info = ` ${state.model} · ${pct}% ctx${state.lastTps ? ` · ${state.lastTps.toFixed(0)} tok/s` : ''} `;
    return C.ink('──') + C.gray(info) + C.ink('─'.repeat(Math.max(0, w - 2 - info.length)));
  },
  prompt() {
    drawHeader();
    if (hdr.on) { this.reprompt(); paint(); return; } // pinned layout: divider + prompt live on the bottom two rows
    process.stdout.write('\n' + this.dividerStr() + '\n');
    this.rl.setPrompt(this.promptStr());
    this.rl.prompt();
  },
  // Redraws the prompt line (on the bottom row in the pinned layout) without touching anything else.
  reprompt(p, inPlace) {
    if (this.pending) return;
    if (!hdr.on && this.busy) return;
    if (inPlace && !hdr.on) process.stdout.write('\x1b[1A\r\x1b[2K'); // empty Enter: undo the line readline just started, so nothing moves
    if (hdr.on) process.stdout.write(`\x1b[${process.stdout.rows || 24};1H\x1b[2K`);
    this.rl.setPrompt(p || this.promptStr());
    this.rl.prompt(true);
  },
  ask(q) { return new Promise(res => { this.pending = res; if (hdr.on) process.stdout.write(`\x1b[${process.stdout.rows || 24};1H\x1b[2K`); this.rl.setPrompt(q); this.rl.prompt(); }); },
  // Arrow-key menu. items: [{label, desc}]. Resolves to the chosen index, or -1 if cancelled (Esc / Ctrl+C).
  // While it is open the normal line editor is detached, so up/down move the highlight instead of scrolling history.
  // One menu at a time: a permission prompt and a /btw menu must not fight over the keyboard.
  select(title, items, o = {}) {
    const run = () => this._select(title, items, o);
    const p = (this._selP || Promise.resolve()).then(run, run);
    this._selP = p.catch(() => { });
    return p;
  },
  _select(title, items, o = {}) {
    return new Promise(resolve => {
      exitView(); ui.inSelect = true; // leave scrolled-back view first so the key handlers we save below are the normal ones
      const so = process.stdout, vlen = s => stripAnsi(s).length;
      let sel = Math.min(Math.max(o.current || 0, 0), items.length - 1), top = 0, drawn = 0;
      const view = Math.max(3, Math.min(items.length, 12, (so.rows || 24) - 6));
      const render = () => {
        const cols = (so.columns || 80) - 2;
        if (sel < top) top = sel;
        if (sel >= top + view) top = sel - view + 1;
        const lines = title ? String(title).split('\n') : [];
        const wN = String(items.length).length;
        for (let i = top; i < Math.min(items.length, top + view); i++) {
          const it = items[i], on = i === sel, n = String(i + 1).padStart(wN);
          const head = on ? C.bamboo('❯ ' + n + '. ') : '  ' + C.gray(n + '. ');
          let label = String(it.label);
          if (vlen(head) + label.length > cols) label = label.slice(0, Math.max(1, cols - vlen(head) - 1)) + '…';
          let line = head + (on ? C.bold(C.bamboo(label)) : label);
          let desc = it.desc || '';
          const room = cols - vlen(line) - 1;
          if (desc) { if (vlen(desc) > room) desc = room > 8 ? C.gray(stripAnsi(desc).slice(0, room - 1) + '…') : ''; if (desc) line += ' ' + (on ? desc : C.dim(desc)); }
          lines.push(line);
        }
        lines.push(C.gray('  ↑/↓ move · enter select · esc cancel' + (items.length > view ? `  (${sel + 1}/${items.length})` : '')));
        if (hdr.on) { ui.menuLines = lines; paint(); }
        else { so.write((drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J' + lines.join('\n') + '\n'); drawn = lines.length; }
      };
      const saved = process.stdin.listeners('keypress');
      const finish = v => {
        ui.inSelect = false;
        process.stdin.removeListener('keypress', onKey);
        for (const l of saved) process.stdin.on('keypress', l);
        if (hdr.on) { ui.menuLines = null; paint(); }
        else so.write((drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J\x1b[?25h');
        resolve(v);
      };
      const onKey = (s, k) => {
        if (!k) return;
        const n = k.name;
        if (n === 'up' || n === 'k') sel = (sel - 1 + items.length) % items.length;
        else if (n === 'down' || n === 'j') sel = (sel + 1) % items.length;
        else if (n === 'pageup') sel = Math.max(0, sel - view);
        else if (n === 'pagedown') sel = Math.min(items.length - 1, sel + view);
        else if (n === 'home') sel = 0;
        else if (n === 'end') sel = items.length - 1;
        else if (n === 'return' || n === 'enter') return finish(sel);
        else if (n === 'escape' || (k.ctrl && n === 'c')) return finish(-1);
        else if (items.length <= 9 && /^[1-9]$/.test(s || '') && +s <= items.length) return finish(+s - 1);
        else return;
        render();
      };
      process.stdin.removeAllListeners('keypress');
      process.stdin.on('keypress', onKey);
      so.write('\x1b[?25l');
      render();
    });
  },
  onLine(l) {
    if (this.pending) { const r = this.pending; this.pending = null; r(l); if (hdr.on) setImmediate(() => this.reprompt()); return; }
    this.lines.push(l); clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 30);
  },
  flush() {
    let text = this.lines.join('\n'); this.lines = [];
    if (text.endsWith('\\')) { this.cont += text.slice(0, -1) + '\n'; this.reprompt(C.gray('  … ')); return; }
    text = this.cont + text; this.cont = '';
    if (!text.trim() && pendingImages.length && !this.busy) text = 'Describe this image.';
    if (!text.trim()) { this.reprompt(null, true); return; }
    // /btw works while Panda is busy: it runs in its own pane next to the main agent
    if (this.busy && /^\/btw(\s|$)/i.test(text.trim())) { handleBtw(text.trim().slice(4).trim()).catch(e => out(C.red('  ⎿  ' + (e.message || e)))); this.reprompt(); return; }
    if (this.busy) { this.queue.push(text); out(C.gray(`  ⎿  queued: ${text.slice(0, 60)}`)); this.reprompt(); return; }
    this.run(text);
  },
  async run(text) {
    const tl = text.split('\n'); slog.add(''); slog.add(C.bamboo('❯ ') + tl[0]); for (const l of tl.slice(1)) slog.add('  ' + l);
    this.busy = true;
    if (hdr.on) { this.reprompt(); paint(); } // fresh prompt row, ready for typing ahead (or /btw) while Panda works
    try { await this.handler(text); } catch (e) { spinner.stop(); out(C.red('  ⎿  Error: ' + (e.message || e))); }
    spinner.stop();
    this.busy = false;
    try { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(HISTORY_PATH, JSON.stringify(this.rl.history.slice(0, 500))); } catch { }
    if (this.queue.length) return this.run(this.queue.shift());
    this.prompt();
  },
  onSigint() {
    if (this.pending) { const r = this.pending; this.pending = null; r('\x03'); return; }
    if (this.busy) { this.abort?.abort(); return; }
    if (side.running) { side.abort?.abort(); return; }
    if (this.rl.line) { this.rl.write(null, { ctrl: true, name: 'u' }); return; }
    if (Date.now() - this.lastSig < 1500) shutdown();
    this.lastSig = Date.now();
    if (hdr.on) { out(C.gray('  (press Ctrl+C again to exit)')); this.reprompt(); return; }
    process.stdout.write('\n' + C.gray('  (press Ctrl+C again to exit)') + '\n');
    this.rl.prompt();
  },
  // The faint "hologram" completion shown after the cursor: slash commands, their arguments, @files, then earlier prompts.
  suggest(line) {
    if (!line) return '';
    const pick = (list, frag) => { const m = list.find(o => o.toLowerCase().startsWith(frag.toLowerCase()) && o.toLowerCase() !== frag.toLowerCase()); return m ? m.slice(frag.length) : ''; };
    if (line.startsWith('/')) {
      const sp = line.indexOf(' ');
      if (sp < 0) return pick(SLASH, line);
      const cmd = line.slice(0, sp).toLowerCase(), arg = line.slice(sp + 1);
      const opts = { '/mode': ['default', 'acceptEdits', 'plan', 'bypass'], '/think': ['on', 'off', 'auto', 'show', 'hide'], '/pin': ['on', 'off'], '/mouse': ['on', 'off'], '/ctx': ['32768', '65536', '131072'], '/btw': ['agent', 'model', 'close', 'clear', 'refresh', 'stop'], '/model': state.modelNames || [] }[cmd];
      if (opts && !arg.includes(' ')) { const r = pick(opts, arg); if (r) return r; }
    }
    const at = line.match(/(^|\s)@([^\s]+)$/);
    if (at) {
      const frag = at[2].replace(/\\/g, '/'), dirPart = frag.includes('/') ? frag.slice(0, frag.lastIndexOf('/') + 1) : '', base = frag.slice(dirPart.length);
      try {
        const e = fs.readdirSync(abs(dirPart || '.'), { withFileTypes: true }).filter(x => x.name.toLowerCase().startsWith(base.toLowerCase()) && !SKIP_DIRS.has(x.name))[0];
        if (e && e.name.length > base.length) return e.name.slice(base.length) + (e.isDirectory() ? '/' : '');
      } catch { }
    }
    for (const h of this.rl.history || []) if (h.length > line.length && h.startsWith(line) && !h.includes('\n')) return h.slice(line.length);
    return '';
  },
  drawGhost() {
    this.ghost = '';
    if (this.pending || this.inSelect || scr.on || !this.rl) return;
    const line = this.rl.line;
    const full = line && this.rl.cursor === line.length ? this.suggest(line) : '';
    this.ghost = full;
    const room = (process.stdout.columns || 80) - this.rl.getCursorPos().cols - 2;
    const g = full.length > room ? full.slice(0, Math.max(0, room)) : full;
    process.stdout.write('\x1b[K' + (g ? '\x1b[2m\x1b[38;2;110;110;120m' + g + '\x1b[0m\x1b[' + g.length + 'D' : ''));
  },
  onKey(s, k) {
    if (!k) return;
    const typing = !this.pending && !this.inSelect && !scr.on;
    if (typing && this.ghost) {
      if (k.name === 'return' || k.name === 'enter') { process.stdout.write('\x1b[K'); this.ghost = ''; }
      else if (k.name === 'tab' && !k.shift && !k.ctrl && !k.meta) { const g = this.ghost; this.ghost = ''; this.skipTab = true; setImmediate(() => { this.skipTab = false; }); this.rl.write(g); }
      else if (k.name === 'right' && this.rl.cursor === this.rl.line.length) { const g = this.ghost; this.ghost = ''; this.rl.write(g); }
    }
    if (k.name === 'tab' && k.shift) { this.skipTab = true; setImmediate(() => { this.skipTab = false; }); }
    this.onKey2(s, k);
    if (typing) setImmediate(() => this.drawGhost());
  },
  onKey2(s, k) {
    if (!k) return;
    if (k.name === 'escape') {
      if (this.pending) { const r = this.pending; this.pending = null; process.stdout.write('\n'); r('\x1b'); return; }
      if (this.busy) this.abort?.abort(); else if (side.running) side.abort?.abort();
      return;
    }
    if (((k.meta && k.name === 'v') || (k.ctrl && k.name === 'v')) && !this.pending && !this.inSelect) { attachClipboard(); return; }
    if (k.name === 'pageup' && !this.pending && !this.inSelect) { scrollView(viewBody() - 2); return; }
    if (k.name === 'tab' && k.shift && !this.busy && !this.pending) {
      const order = ['default', 'acceptEdits', 'plan'];
      if (state.mode === 'bypass') state.mode = 'default';
      else state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
      this.rl.setPrompt(this.promptStr());
      readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0);
      this.rl.prompt(true);
    }
  },
};

function shutdown() {
  spinner.stop();
  unpinHeader();
  for (const sh of state.shells.values()) if (sh.status === 'running') killTree(sh.proc);
  saveSession();
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(ui.rl?.history?.slice(0, 500) || [])); } catch { }
  process.stdout.write('\n' + C.bamboo('🐼 Bye! Back to the bamboo.') + '\n');
  process.exit(0);
}

// ───────────────────────────── input handling ─────────────────────────────
// ── images ──
const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
let pendingImages = []; // images attached (e.g. pasted from the clipboard) and waiting for the next message
const imgKB = i => Math.max(1, Math.round(i.bytes / 1024)) + ' KB';
function loadImage(p) {
  const mime = IMG_EXT[path.extname(p).toLowerCase()];
  if (!mime) throw new Error('Not a supported image (png, jpg, gif, webp): ' + p);
  const st = fs.statSync(p);
  if (st.size > 25 * 1024 * 1024) throw new Error(`Image is too large (${(st.size / 1048576).toFixed(0)} MB, the limit is 25 MB): ${path.basename(p)}`);
  return { name: path.basename(p), mime, bytes: st.size, data: fs.readFileSync(p).toString('base64') };
}
// Grabs an image from the Windows clipboard (a screenshot, "Copy image", or a copied image file).
function clipboardImage() {
  if (!IS_WIN) return null;
  const tmp = path.join(os.tmpdir(), `panda-clip-${process.pid}-${Date.now()}.png`);
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
    `$i = [System.Windows.Forms.Clipboard]::GetImage(); ` +
    `if ($i) { $i.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'IMG' } ` +
    `elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) { 'FILE:' + $f } }`;
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const o = r.stdout || '';
  if (o.includes('IMG') && fs.existsSync(tmp)) { const img = loadImage(tmp); img.name = 'clipboard.png'; try { fs.unlinkSync(tmp); } catch { } return img; }
  const m = o.match(/FILE:(.+)/);
  if (m && IMG_EXT[path.extname(m[1].trim()).toLowerCase()]) return loadImage(m[1].trim());
  return null;
}
function attachClipboard() {
  let img = null, err = '';
  try { img = clipboardImage(); } catch (e) { err = e.message; }
  const idle = !ui.busy && !ui.pending;
  if (idle) process.stdout.write('\r\x1b[2K');
  if (!img) out(C.yellow('  ⎿  ' + (err || (IS_WIN ? 'No image on the clipboard. Copy one first (Win+Shift+S for a screenshot), then press Alt+V.' : 'Clipboard images are only supported on Windows. Use @path/to/image.png instead.'))));
  else { pendingImages.push(img); out(C.gray('  ⎿  ') + '📎 ' + C.bamboo(`Image attached (${img.name}, ${imgKB(img)})`) + C.gray(' — sent with your next message')); }
  if (idle) { ui.rl.setPrompt(ui.promptStr()); ui.rl.prompt(true); }
}
function expandMentions(text) {
  const extra = [], images = [], seen = new Set();
  const addImage = f => { if (seen.has(f)) return; seen.add(f); try { images.push(loadImage(f)); } catch (e) { out(C.yellow('  ⎿  ' + e.message)); } };
  text.replace(/(^|\s)@("[^"]+"|[^\s]+)/g, (m, sp, p) => {
    const f = abs(p.replace(/^"|"$/g, ''));
    try {
      const st = fs.statSync(f);
      if (st.isFile() && IMG_EXT[path.extname(f).toLowerCase()]) addImage(f);
      else if (st.isDirectory()) { extra.push(`<directory path="${f}">\n${fs.readdirSync(f).slice(0, 200).join('\n')}\n</directory>`); out(C.gray(`  ⎿  Listed ${rel(f)}`)); }
      else if (st.size < 300000) {
        const t = fs.readFileSync(f, 'utf8'); markRead(f);
        extra.push(`<file path="${f}">\n${t.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')}\n</file>`);
        out(C.gray(`  ⎿  Read ${rel(f)} (${t.split('\n').length} lines)`));
      }
    } catch { }
    return m;
  });
  // images given as plain or dragged-in paths (dropping a file onto the terminal pastes its path, quoted if it has spaces)
  text.replace(/"([^"]+)"|(\S+)/g, (m, q, b) => {
    const t = (q || b).replace(/^@/, '').replace(/^["']|["']$/g, '');
    if (!IMG_EXT[path.extname(t).toLowerCase()]) return m;
    const f = abs(t);
    try { if (fs.statSync(f).isFile()) addImage(f); } catch { }
    return m;
  });
  return { text: extra.length ? text + '\n\n' + extra.join('\n\n') : text, images };
}
async function runTurn(content, images = []) {
  state.turnId = (state.turnId || 0) + 1; // groups this request's file changes for /undo
  if (pendingContext.length) { content = pendingContext.join('\n\n') + '\n\n' + content; pendingContext = []; }
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === 'user') { last.content += '\n\n' + content; if (images.length) last.images = (last.images || []).concat(images); }
  else session.messages.push(images.length ? { role: 'user', content, images } : { role: 'user', content });
  const ac = new AbortController(); ui.abort = ac;
  const opts = { signal: ac.signal, depth: 0, indent: '', quiet: false };
  const tStart = Date.now(), outStart = state.totalOut;
  out('');
  try {
    await agentLoop(session.messages, opts);
    const secs = Math.round((Date.now() - tStart) / 1000);
    if (secs >= 3 && !ac.signal.aborted) {
      const left = C.gray(`  ✻ Worked for ${secs >= 60 ? Math.floor(secs / 60) + 'm ' + (secs % 60) + 's' : secs + 's'} · ↓ ${fmtK(state.totalOut - outStart)} tokens`);
      out(left + ' '.repeat(Math.max(1, (hdr.on ? geom().leftW : (process.stdout.columns || 80) - 1) - stripAnsi(left).length - 4)) + '🐼🎋');
    }
  }
  catch (e) {
    spinner.stop();
    if (e.name === 'AbortError' || ac.signal.aborted) {
      const l = session.messages[session.messages.length - 1];
      if (l && l.role === 'tool' || (l && l.role === 'assistant' && l.tool_calls)) session.messages.push({ role: 'user', content: '[Request interrupted by user]' });
      else if (l && l.role === 'user') session.messages.push({ role: 'assistant', content: (opts.partial || '') + '\n[interrupted by user]' });
      out(C.gray('  ⎿  ') + C.red('Interrupted') + C.gray(' · What should Panda do instead?'));
    } else {
      const msg = e.cause?.code === 'ECONNREFUSED' ? `Cannot reach ${state.baseUrl} — is your AI server running?` : (e.message || String(e));
      out(C.red('  ⎿  API Error: ' + msg));
      const l = session.messages[session.messages.length - 1];
      if (l && l.role === 'tool') session.messages.push({ role: 'user', content: '[previous request failed with an error]' });
    }
  } finally { ui.abort = null; saveSession(); }
}
// ───────────────────────────── model catalog & picker ─────────────────────────────
// The ranking is Panda's own estimate of how well a model works as a coding AGENT (tool use, multi-step edits), built from published
// benchmarks and hands-on reports - not an independent test. Sizes are the real Ollama download sizes.
// Add or change entries without a new release in ~/.panda/models.json, e.g. [{ "name": "foo:7b", "gb": 4.7, "q": 60, "moe": false, "note": "my pick" }]
const MODEL_CATALOG = [
  { name: 'qwen3-coder:480b', gb: 290.1, q: 95, moe: true, note: 'Qwen3-Coder 480B MoE: the strongest open coder; needs a monster machine' },
  { name: 'qwen3.5:122b', gb: 81.4, q: 88, moe: true, note: 'Qwen3.5 122B MoE: big and very capable' },
  { name: 'qwen3-coder-next:latest', gb: 51.7, q: 86, moe: true, note: 'Qwen3-Coder-Next 80B (3B active): coding specialist, 70%+ SWE-bench Verified reported' },
  { name: 'nemotron-3-super:latest', gb: 86.8, q: 85, moe: true, note: 'NVIDIA Nemotron 3 Super: large MoE' },
  { name: 'qwen3.8:27b', gb: 17.7, q: 84, moe: false, note: 'Qwen3.8 27B dense: best all-round pick for one 24 GB card' },
  { name: 'qwen3.6:35b-a3b', gb: 22.6, q: 82, moe: true, note: 'Qwen3.6 35B MoE (3B active): very fast, ~70% SWE-bench Verified reported' },
  { name: 'gpt-oss:120b', gb: 65.4, q: 80, moe: true, note: 'OpenAI gpt-oss 120B MoE: strong reasoning and tool use' },
  { name: 'qwen3.6:27b', gb: 17.8, q: 80, moe: false, note: 'Qwen3.6 27B dense' },
  { name: 'qwen3-next:80b', gb: 50.4, q: 78, moe: true, note: 'Qwen3-Next 80B MoE' },
  { name: 'qwen3-coder:30b', gb: 18.6, q: 76, moe: true, note: 'Qwen3-Coder 30B MoE: solid coder for 24 GB' },
  { name: 'qwen3.5:27b', gb: 17.5, q: 76, moe: false, note: 'Qwen3.5 27B dense' },
  { name: 'glm-4.7-flash:latest', gb: 19.0, q: 75, moe: true, note: 'GLM 4.7 Flash MoE' },
  { name: 'qwen3.5:35b', gb: 22.1, q: 74, moe: true, note: 'Qwen3.5 35B MoE' },
  { name: 'gemma4:31b', gb: 20.4, q: 74, moe: false, note: 'Google Gemma 4 31B dense' },
  { name: 'devstral-small-2:24b', gb: 15.2, q: 74, moe: false, note: 'Mistral Devstral Small 2: built for coding agents' },
  { name: 'gemma4:26b', gb: 18.7, q: 72, moe: true, note: 'Google Gemma 4 26B MoE' },
  { name: 'devstral:24b', gb: 14.3, q: 68, moe: false, note: 'Mistral Devstral 24B' },
  { name: 'gpt-oss:20b', gb: 13.8, q: 66, moe: true, note: 'gpt-oss 20B: good for 16 GB cards' },
  { name: 'llama4:scout', gb: 67.4, q: 62, moe: true, note: 'Llama 4 Scout MoE' },
  { name: 'nemotron-3.5-lightning:latest', gb: 25.4, q: 62, moe: true, note: 'NVIDIA Nemotron 3.5 Lightning MoE (lower coding scores reported)' },
  { name: 'llama3.3:70b', gb: 42.5, q: 60, moe: false, note: 'Llama 3.3 70B: older, but solid' },
  { name: 'nemotron-3-nano:30b', gb: 24.3, q: 60, moe: true, note: 'NVIDIA Nemotron 3 Nano MoE' },
  { name: 'qwen3.5:9b', gb: 6.6, q: 58, moe: false, note: 'Qwen3.5 9B: the best small model for 8 GB cards' },
  { name: 'gemma4:e4b', gb: 6.6, q: 48, moe: false, note: 'Gemma 4 E4B: small and quick' },
  { name: 'qwen3.5:4b', gb: 3.3, q: 42, moe: false, note: 'Qwen3.5 4B: tiny; fine for simple edits and low-end PCs' },
];
let HW = null;
function detectHardware() {
  if (HW) return HW;
  const ramGB = process.env.PANDA_RAM_GB ? +process.env.PANDA_RAM_GB : os.totalmem() / 1073741824;
  const gpus = [];
  if (process.env.PANDA_VRAM_GB) gpus.push({ name: 'GPU (set by PANDA_VRAM_GB)', gb: +process.env.PANDA_VRAM_GB });
  else {
    try {
      const r = cp.spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status === 0) for (const l of (r.stdout || '').trim().split(/\r?\n/)) { const [n, m] = l.split(',').map(s => s.trim()); if (n && +m) gpus.push({ name: n.replace(/^NVIDIA\s+(GeForce\s+)?/i, ''), gb: +m / 1024 }); }
    } catch { }
    if (!gpus.length && process.platform === 'darwin') gpus.push({ name: 'Apple silicon (unified memory)', gb: ramGB * 0.7 });
  }
  const vram = gpus.reduce((a, g) => a + g.gb, 0);
  const tier = vram < 1 ? 'Entry (CPU only)' : vram < 9 ? 'Compact (up to 8 GB)' : vram < 20 ? 'Mid (12-16 GB)' : vram < 30 ? 'High (24 GB)' : vram < 56 ? 'Workstation (32-48 GB)' : vram < 100 ? 'Server (64-96 GB)' : 'Massive (100 GB+)';
  HW = { ramGB, gpus, vram, tier };
  return HW;
}
const resetHardware = () => { HW = null; };
function describeHardware() {
  const h = detectHardware();
  const g = h.gpus.length ? h.gpus.map(x => `${x.name} ${Math.round(x.gb)} GB`).join(' + ') : 'no GPU found';
  return `${g} · ${Math.round(h.ramGB)} GB RAM → ${h.tier}`;
}
// How well a model of this size runs here: fully on the GPU, split over GPU+RAM, CPU only, or too big.
function modelFit(gb, moe) {
  const h = detectHardware(), need = gb * 1.05 + 1.0, ram = h.ramGB * 0.75; // weights + context cache; leave a quarter of RAM for the OS
  if (h.vram >= need) return { fit: 'gpu', f: 1 };
  if (h.vram < 1) return ram >= need ? { fit: 'cpu', f: moe ? 0.45 : 0.2, tight: need > ram * 0.9 } : { fit: 'big', f: 0.05 };
  if (h.vram + ram >= need) { // the less of it sits on the GPU, the slower it runs (MoE models suffer less: only a few experts are active)
    const frac = Math.min(1, h.vram / need);
    return { fit: 'split', f: moe ? 0.5 + 0.35 * frac : 0.2 + 0.5 * frac, tight: need > (h.vram + ram) * 0.9 };
  }
  return { fit: 'big', f: 0.05 };
}
function userCatalog() { try { const j = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'models.json'), 'utf8')); return Array.isArray(j) ? j.filter(m => m && m.name && m.gb) : []; } catch { return []; } }
const normName = n => String(n).replace(/:latest$/, '');
// Best first, least suitable last. Installed models that aren't in the catalog are included (marked unrated).
function rankModels(installed) {
  const cat = new Map();
  for (const m of MODEL_CATALOG.concat(userCatalog())) cat.set(normName(m.name), m);
  const inst = new Map(installed.map(m => [normName(m.name), m]));
  const rows = [];
  const mk = (c, i) => {
    const gb = i?.size ? i.size / 1e9 : c.gb, moe = !!c.moe, q = c.q;
    const ft = modelFit(gb, moe);
    let f = ft.f; if (i?.caps && !i.caps.includes('tools')) f *= 0.6; // no native tool calling: works, but worse
    return { name: i ? i.name : c.name, gb, q, moe, installed: !!i, caps: i?.caps, ctx: i?.ctx, note: c.note || '', unrated: !!c.unrated, fit: ft.fit, tight: ft.tight, score: q * f + (i ? 2 : 0) };
  };
  for (const [k, c] of cat) rows.push(mk(c, inst.get(k)));
  for (const [k, i] of inst) if (!cat.has(k)) { const gb = (i.size || 4e9) / 1e9; rows.push(mk({ name: i.name, gb, q: Math.min(68, 30 + 14 * Math.log2(Math.max(gb, 1) / 3)), moe: false, unrated: true, note: 'not in the ranking list; score is a size-based guess' }, i)); }
  return rows.sort((a, b) => b.score - a.score || a.gb - b.gb);
}
// Streams an Ollama download and shows the progress in the spinner.
async function pullModel(name, signal) {
  const res = await fetch(state.baseUrl.replace(/\/+$/, '') + '/api/pull', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: name, stream: true }), signal });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const layers = new Map();
  let last = '';
  for await (const line of readLines(res)) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.error) throw new Error(j.error);
    if (j.digest && j.total) layers.set(j.digest, { total: j.total, done: j.completed || 0 });
    let tot = 0, done = 0; for (const l of layers.values()) { tot += l.total; done += l.done; }
    const label = tot ? `Downloading ${name} ${Math.floor(100 * done / tot)}% (${(done / 1e9).toFixed(1)} of ${(tot / 1e9).toFixed(1)} GB)` : `Downloading ${name}: ${j.status || 'starting'}`;
    if (label !== last) { last = label; spinner.set(label); }
    if (j.status === 'success') return true;
  }
  return true;
}
async function pickModel() {
  let models;
  try { models = await listModels(); } catch (e) { out(C.red(`  Could not list models from ${state.baseUrl}: ${e.message}`)); return false; }
  if (state.kind !== 'ollama') { // other servers: only the models they have loaded
    if (!models.length) { out(C.red('  No models found. ') + C.gray('Load a model in your server first.')); return false; }
    const items = models.map(m => ({ label: m.name, desc: C.gray(m.name === state.model ? 'current' : '') }));
    const pi = await ui.select('  ' + C.bold('Choose a model') + C.gray(` (${state.providerName})`), items, { current: Math.max(0, models.findIndex(m => m.name === state.model)) });
    if (!models[pi]) { out(C.gray('  (unchanged)')); return !!state.model; }
    setModel(models[pi]); return true;
  }
  const rows = rankModels(models);
  const FIT = { gpu: C.green('fits your GPU'), split: C.yellow('GPU+RAM, slower'), cpu: C.yellow('CPU only, slow'), big: C.red('too big for this PC') };
  const nameW = Math.min(34, Math.max(...rows.map(r => r.name.length)));
  const items = rows.map((r, i) => {
    const star = i === 0 ? C.bamboo('★ best for your PC · ') : i < 3 ? C.leaf('★ ') : '';
    const fit = r.fit === 'split' && r.moe ? C.yellow('GPU+RAM, MoE: less slowdown') : FIT[r.fit];
    const bits = [fit + (r.tight && r.fit !== 'big' ? C.yellow(' (tight)') : ''), `${r.gb.toFixed(1)} GB`, r.installed ? C.green('installed') : C.cyan('↓ download')];
    if (r.name === state.model) bits.push(C.bamboo('current'));
    if (r.caps && !r.caps.includes('tools')) bits.push(C.yellow('no tools'));
    if (r.caps?.includes('vision')) bits.push(C.cyan('vision'));
    return { label: (r.installed ? '● ' : '○ ') + r.name.padEnd(nameW), desc: star + bits.join(C.gray(' · ')) + (r.note ? C.gray(' · ' + r.note) : '') };
  });
  const remote = !/localhost|127\.0\.0\.1|\[::1\]/.test(state.baseUrl);
  const title = '  ' + C.bold('Choose a model') + C.gray(` (${state.providerName}) · best for your PC first, least suitable last`) +
    '\n  ' + C.gray('Your PC: ') + C.white(describeHardware()) + (remote ? C.yellow('  (this PC; your Ollama server is remote)') : '') +
    '\n  ' + C.gray('● installed   ○ not installed: picking it downloads it · ranking = Panda\'s coding-agent estimate');
  const pi = await ui.select(title, items, { current: Math.max(0, rows.findIndex(r => r.name === state.model)) });
  const row = rows[pi];
  if (!row) { out(C.gray('  (unchanged)')); return !!state.model; }
  if (row.installed) { setModel(models.find(m => m.name === row.name)); return true; }
  return downloadAndSet(row);
}
// Not installed yet: check disk space, confirm, download, then switch to it.
async function downloadAndSet(row) {
  const remote = !/localhost|127\.0\.0\.1|\[::1\]/.test(state.baseUrl);
  let free = Infinity;
  if (!remote && row.gb) { try { const s = fs.statfsSync(fs.existsSync(path.join(os.homedir(), '.ollama')) ? path.join(os.homedir(), '.ollama') : os.homedir()); free = s.bavail * s.bsize / 1e9; } catch { } }
  if (row.gb && free < row.gb * 1.05) { out(C.red(`  ⎿  Not enough free disk space: ${row.name} needs about ${row.gb.toFixed(1)} GB and only ${free.toFixed(1)} GB is free.`)); return false; }
  const warn = row.fit === 'big' ? C.red('  This model is too big for your PC and will be very slow or fail to load.') : row.fit !== 'gpu' ? C.yellow('  It will not fit entirely on your GPU, so it will run slower.') : '';
  const ok = await ui.select('  ' + C.bold(`Download ${row.name}?`) + C.gray(row.gb ? ` ${row.gb.toFixed(1)} GB${free < Infinity ? `, ${free.toFixed(0)} GB free` : ''}` : '') + (warn ? '\n' + warn : ''), [{ label: `Yes, download ${row.name}` }, { label: 'No, go back' }]);
  // (title above shows the size only when it is known)
  if (ok !== 0) { out(C.gray('  (cancelled)')); return !!state.model; }
  const ac = new AbortController(); ui.abort = ac;
  spinner.start(`Downloading ${row.name}`);
  try { await pullModel(row.name, ac.signal); }
  catch (e) { spinner.stop(); ui.abort = null; out(ac.signal.aborted ? C.gray('  ⎿  download stopped (Ollama keeps what it already has; pick the model again to resume)') : C.red('  ⎿  Download failed: ' + (e.message || e))); return !!state.model; }
  spinner.stop(); ui.abort = null;
  let fresh = []; try { fresh = await listModels(); } catch { }
  const m = fresh.find(x => normName(x.name) === normName(row.name));
  if (!m) { out(C.yellow('  ⎿  The download finished but the model is not listed yet. Try /model again.')); return false; }
  out(C.gray('  ⎿  Downloaded ') + C.bamboo(m.name));
  setModel(m);
  return true;
}
function setModel(m) {
  state.model = m.name;
  state.nativeTools = !m.caps || m.caps.includes('tools');
  state.vision = m.caps ? m.caps.includes('vision') : null;
  if (state.vision === false) out(C.yellow('  ⎿  Note: this model cannot see images.'));
  if (state.kind === 'ollama' && m.ctx && state.numCtx > m.ctx) state.numCtx = m.ctx;
  saveConfig();
  drawHeader();
  out(C.gray('  ⎿  Model set to ') + C.bamboo(m.name) + (state.nativeTools ? '' : C.yellow(' (text-based tool calls)')));
}
// ───────────────────────────── updates ─────────────────────────────
// `/update` (or `pandacode update`) asks the GitHub repository that publishes Panda Code releases whether there is a newer version.
const GH_API = process.env.PANDA_GH_API || 'https://api.github.com';
const isStandaloneExe = () => !/(^|[\\/])node(\.exe)?$/i.test(process.execPath);
const cmpVer = (a, b) => { const pa = String(a).split('.').map(n => parseInt(n) || 0), pb = String(b).split('.').map(n => parseInt(n) || 0); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };
async function checkUpdate() {
  const repo = process.env.PANDA_REPO || state.repo || 'adammarosvari01-web/panda-code';
  if (!repo) throw new Error('No update source is set. Tell Panda which GitHub repository publishes its releases:  /update repo <owner/name>');
  const r = await fetch(`${GH_API}/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'panda-code', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) throw new Error(`${repo} has no published release yet.`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${repo}.`);
  const j = await r.json(), latest = String(j.tag_name || '').replace(/^v/i, '');
  const asset = n => (j.assets || []).find(a => a.name.toLowerCase() === n);
  return { repo, latest, newer: cmpVer(latest, VERSION) > 0, exe: asset('panda.exe'), sha: asset('panda.exe.sha256') };
}
// Swaps the running exe for a new one. Windows lets you rename a running exe, so the old copy is moved aside and removed on the next start.
function applyExeUpdate(target, buf) {
  const dir = path.dirname(target), stamp = Date.now();
  fs.writeFileSync(target + '.new', buf);
  fs.renameSync(target, path.join(dir, `${path.basename(target, '.exe')}.old-${stamp}.exe`));
  fs.renameSync(target + '.new', target);
  for (const sib of ['panda.exe', 'pandacode.exe']) { // the other command name is a copy/link of the same exe
    const p = path.join(dir, sib);
    if (p.toLowerCase() === target.toLowerCase() || !fs.existsSync(p)) continue;
    try { fs.renameSync(p, path.join(dir, `${sib.replace(/\.exe$/, '')}.old-${stamp}.exe`)); fs.copyFileSync(target, p); } catch { }
  }
}
async function updateCmd(arg, { headless = false } = {}) {
  const say = s => headless ? console.log(s) : out(s);
  const rm = String(arg || '').trim().match(/^repo\s+([\w.-]+\/[\w.-]+)$/i);
  if (rm) { state.repo = rm[1]; saveConfig(); say(C.gray('  ⎿  updates now come from ') + C.bamboo(state.repo)); }
  let u;
  try { u = await checkUpdate(); } catch (e) { say(C.yellow('  ' + (e.message || e))); return; }
  if (!u.newer) { say(C.gray(`  You are on the latest version (${VERSION}); ${u.repo} publishes ${u.latest || 'nothing newer'}.`)); return; }
  say(C.bold(`  Panda Code ${u.latest} is available`) + C.gray(` (you have ${VERSION}).`));
  if (!isStandaloneExe()) { say(C.gray('  You run Panda from source/npm, so update it the same way you installed it, e.g.:  npm i -g github:' + u.repo)); return; }
  if (!u.exe) { say(C.yellow(`  That release has no panda.exe file attached, so Panda cannot update itself from it.`)); return; }
  if (!headless) {
    const i = await ui.select('  ' + C.bold(`Download panda.exe ${u.latest} from ${u.repo} and replace this one?`) + C.gray(` (${Math.round(u.exe.size / 1e6)} MB)`), [{ label: 'Yes, update now' }, { label: 'No, not now' }]);
    if (i !== 0) { say(C.gray('  (cancelled)')); return; }
  }
  try {
    const r = await fetch(u.exe.browser_download_url, { headers: { 'User-Agent': 'panda-code' }, signal: AbortSignal.timeout(600000) });
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (u.sha) { // verify the download against the published checksum
      const want = (await (await fetch(u.sha.browser_download_url, { headers: { 'User-Agent': 'panda-code' }, signal: AbortSignal.timeout(30000) })).text()).trim().split(/\s+/)[0].toLowerCase();
      const got = require('crypto').createHash('sha256').update(buf).digest('hex');
      if (want !== got) throw new Error('the download does not match the published checksum, so it was NOT installed');
    } else say(C.yellow('  (this release publishes no checksum, so the download could not be verified)'));
    applyExeUpdate(process.execPath, buf);
    say(C.green(`  ✓ Updated to ${u.latest}.`) + C.gray(' Close Panda and start it again to use it.'));
  } catch (e) { say(C.red('  Update failed: ' + (e.message || e))); }
}
async function setupProvider(force) {
  if (!force && state.baseUrl) return true;
  out(C.gray('  Looking for local AI servers…'));
  const found = await detectProviders();
  let choice;
  if (found.length === 1) choice = found[0];
  else if (found.length > 1) {
    const si = await ui.select('  ' + C.bold('Choose an AI server'), found.map(f => ({ label: f.name, desc: C.gray(f.url) })).concat([{ label: 'Custom URL…' }]));
    choice = found[si];
  } else out(C.yellow('  No local AI server found on the usual ports (Ollama, LM Studio, llama.cpp, Jan, vLLM, KoboldCpp).'));
  if (!choice) {
    const url = (await ui.ask(C.bamboo('  OpenAI-compatible base URL (e.g. http://localhost:1234/v1) ❯ '))).trim();
    if (!url) return false;
    const key = (await ui.ask(C.bamboo('  API key (leave empty for none) ❯ '))).trim();
    choice = { name: 'Custom', kind: /11434/.test(url) && !/\/v1/.test(url) ? 'ollama' : 'openai', url };
    state.apiKey = key;
  }
  state.kind = choice.kind; state.baseUrl = choice.url; state.providerName = choice.name;
  out(C.gray('  ⎿  Using ') + C.bamboo(choice.name) + C.gray(' at ' + choice.url));
  saveConfig();
  return true;
}

const HELP = () => `
${C.bold(C.bamboo('Panda Code'))} ${C.gray('— terminal coding agent for local AI')}

${C.bold('Commands')}
  ${C.bamboo('/help')}              Show this help
  ${C.bamboo('/clear')}             Start a fresh conversation
  ${C.bamboo('/compact')} [focus]   Summarize the conversation to free context
  ${C.bamboo('/model')} [name]      Pick or set the model          ${C.bamboo('/models')} list models
  ${C.bamboo('/provider')}          Detect / choose AI server (Ollama, LM Studio, llama.cpp, custom URL)
  ${C.bamboo('/mode')} [m]          default | acceptEdits | plan | bypass   ${C.gray('(shift+tab cycles)')}
  ${C.bamboo('/plan')}  ${C.bamboo('/yolo')}        Plan mode / skip all permission prompts
  ${C.bamboo('/ctx')} [tokens]      Context window size (Ollama num_ctx), now ${state.numCtx}
  ${C.bamboo('/fast')}              Toggle fast mode (turns model thinking off — much quicker replies)
  ${C.bamboo('/pin')} [on|off]      Keep the panda banner pinned to the top of the window
  ${C.bamboo('/mouse')} [on|off]    Mouse-wheel scrolling of the history (on: hold Shift to select text)
  ${C.bamboo('/paste')}             Attach the image on your clipboard ${C.gray('(or press Alt+V)')}
  ${C.bamboo('/btw')} <question>    Ask a read-only side agent in a slide-out pane — works while Panda is busy ${C.gray('(/btw agent · model · close)')}
  ${C.bamboo('/flaws')} <purpose>   Tell Panda what the project is for; it analyses everything and tells you what's wrong or missing
  ${C.bamboo('/imagine')} <prompt>  Generate an image with a local image model ${C.gray('(--size 1024x1024 --steps 30 --seed 7 --neg "blurry" --enhance)')}
  ${C.bamboo('/undo')}              Roll back the file changes Panda made in its last request
  ${C.bamboo('/update')}            Check for a newer Panda Code and install it ${C.gray('(also: pandacode update)')}
  ${C.bamboo('/think')} on|off|auto|show|hide   Model thinking & whether to display it
  ${C.bamboo('/init')}              Create a PANDA.md guide for this project
  ${C.bamboo('/todos')}  ${C.bamboo('/cost')}  ${C.bamboo('/status')}  ${C.bamboo('/tools')}  ${C.bamboo('/bashes')}  ${C.bamboo('/memory')}  ${C.bamboo('/config')}
  ${C.bamboo('/resume')}            Resume a previous conversation
  ${C.bamboo('/cd')} <dir>          Change working directory
  ${C.bamboo('/exit')}              Quit

${C.bold('Input')}
  ${C.bamboo('@path')}              Attach a file, folder or image (tab completes; dropping an image onto the window works too)
  ${C.bamboo('!command')}           Run a shell command yourself; output is shared with Panda
  ${C.bamboo('# note')}             Save a note to ./PANDA.md (project memory)
  ${C.bamboo('line \\')}             Continue on the next line (pasting multi-line text also works)
  ${C.bamboo('Esc')} / ${C.bamboo('Ctrl+C')}       Interrupt Panda · Ctrl+C twice to quit

${C.bold('Tools')} ${C.gray(Object.keys(TOOLS).join(', '))}`;

async function slash(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case '/help': case '/?': out(HELP()); break;
    case '/exit': case '/quit': shutdown(); break;
    case '/clear': case '/new': slog.lines.length = 0; saveSession(); session = newSession(); state.todos = []; state.read.clear(); state.lastPrompt = 0; pendingContext = []; if (hdr.on) { pinHeader(); out(hdr.tip); } else { process.stdout.write('\x1b[2J\x1b[H'); out(banner()); } break;
    case '/paste': attachClipboard(); break;
    case '/btw': await handleBtw(arg); break;
    case '/flaws': await flawsCmd(arg); break;
    case '/update': await updateCmd(arg); break;
    case '/imagine': await imagineCmd(arg); break;
    case '/undo': { const d = undoLast(); out(d && d.length ? d.map(x => C.gray('  ⎿  ') + x).join('\n') + '\n' + C.gray('  (changes made through the shell are not tracked)') : C.gray('  Nothing to undo.')); break; }
    case '/mouse': {
      const a = arg.toLowerCase();
      state.mouse = a === 'on' ? true : a === 'off' ? false : state.mouse === false;
      saveConfig();
      if (hdr.on) setMouse(state.mouse !== false);
      out(state.mouse === false ? C.gray('  ⎿  Mouse wheel scrolling off (PgUp/PgDn still work). Text selection and right-click paste behave normally.') : C.gray('  ⎿  Mouse wheel scrolling on. Hold Shift to select text with the mouse.'));
      break;
    }
    case '/pin': {
      const a = arg.toLowerCase();
      state.pin = a === 'on' ? true : a === 'off' ? false : state.pin === false;
      saveConfig();
      if (state.pin === false) { unpinHeader(); out(C.gray('  ⎿  Banner unpinned — the whole window scrolls normally (and keeps scrollback).')); }
      else if (pinHeader(false)) { drawHeader(); out(C.gray('  ⎿  Banner pinned to the top of the window.')); }
      else out(C.yellow('  Pinning needs a color terminal that is at least 16 rows tall.'));
      break;
    }
    case '/compact': {
      if (!session.messages.length) { out(C.gray('  Nothing to compact.')); break; }
      const ac = new AbortController(); ui.abort = ac;
      try { await compact(arg, ac.signal); } finally { ui.abort = null; }
      saveSession(); break;
    }
    case '/model':
      if (arg) { let m; try { m = (await listModels()).find(x => x.name === arg || x.name === arg + ':latest'); } catch { } 
        if (m || state.kind !== 'ollama') setModel(m || { name: arg });
        else { // not installed: offer to download it
          const c = MODEL_CATALOG.concat(userCatalog()).find(x => normName(x.name) === normName(arg));
          await downloadAndSet({ name: arg, gb: c ? c.gb : 0, fit: c ? modelFit(c.gb, c.moe).fit : 'gpu' });
        }
      }
      else await pickModel();
      break;
    case '/models': { try { (await listModels()).forEach(m => out('  ' + (m.name === state.model ? C.bamboo('● ') : '  ') + m.name)); } catch (e) { out(C.red('  ' + e.message)); } break; }
    case '/provider': case '/setup': if (await setupProvider(true)) await pickModel(); break;
    case '/mode': {
      const map = { default: 'default', normal: 'default', acceptedits: 'acceptEdits', edits: 'acceptEdits', plan: 'plan', bypass: 'bypass', yolo: 'bypass' };
      if (map[arg.toLowerCase()]) state.mode = map[arg.toLowerCase()];
      out(C.gray('  ⎿  Mode: ') + C.bamboo(state.mode)); break;
    }
    case '/plan': state.mode = state.mode === 'plan' ? 'default' : 'plan'; out(C.gray('  ⎿  Mode: ') + C.bamboo(state.mode)); break;
    case '/yolo': state.mode = state.mode === 'bypass' ? 'default' : 'bypass'; out(C.gray('  ⎿  Mode: ') + (state.mode === 'bypass' ? C.red('bypass — Panda will run tools without asking') : C.bamboo('default'))); break;
    case '/ctx': { const n = parseInt(arg.replace(/k$/i, '000'), 10); if (n >= 2048) { state.numCtx = n; saveConfig(); } out(C.gray('  ⎿  Context window: ') + C.bamboo(state.numCtx) + C.gray(' tokens')); break; }
    case '/fast': {
      // Thinking models spend many tokens reasoning before every reply; turning it off is the biggest speed win.
      state.think = state.think === false ? null : false; saveConfig();
      out(C.gray('  ⎿  Fast mode ') + (state.think === false ? C.bamboo('on') + C.gray(' — thinking off, replies start right away') : C.bamboo('off') + C.gray(' — model thinks before answering (smarter, slower)')));
      break;
    }
    case '/think': {
      const a = arg.toLowerCase();
      if (a === 'on') state.think = true; else if (a === 'off') state.think = false; else if (a === 'auto') state.think = null;
      else if (a === 'show') state.showThinking = true; else if (a === 'hide') state.showThinking = false;
      saveConfig();
      out(C.gray(`  ⎿  Thinking: ${state.think === null ? 'model default' : state.think ? 'on' : 'off'} · display: ${state.showThinking ? 'shown' : 'hidden'}`)); break;
    }
    case '/init':
      await runTurn(`Please analyze this codebase and create a PANDA.md file in ${state.cwd}, which will be given to future instances of Panda Code (an AI coding agent) working in this repository.\n\nInclude:\n1. Commands for building, linting, running tests (including a single test), and running the app.\n2. A high-level overview of the architecture and code structure that needs reading several files to understand.\n3. Code style conventions you observe.\n\nKeep it concise. Don't invent anything you didn't see. If a PANDA.md already exists, improve it instead. If there are README.md, CLAUDE.md, AGENTS.md, .cursorrules or similar files, incorporate their important parts.`);
      break;
    case '/todos': out(state.todos.length ? renderTodos().split('\n').map(l => '  ' + l).join('\n') : C.gray('  No todos.')); break;
    case '/cost': case '/usage': out(C.gray(`  Tokens this session: ${fmtK(state.totalIn)} in · ${fmtK(state.totalOut)} out · context ${fmtK(state.lastPrompt)}/${fmtK(state.numCtx)} · last ${state.lastTps.toFixed(1)} tok/s · cost: $0.00 🐼`)); break;
    case '/status': case '/config':
      out(`  ${C.gray('Version')}   ${VERSION}\n  ${C.gray('Server')}    ${state.providerName} (${state.kind}) ${state.baseUrl}\n  ${C.gray('Model')}     ${state.model}${state.nativeTools ? '' : C.yellow(' [text tool calls]')}\n  ${C.gray('Context')}   ${state.numCtx}\n  ${C.gray('Mode')}      ${state.mode}\n  ${C.gray('Cwd')}       ${state.cwd}\n  ${C.gray('Config')}    ${CONFIG_PATH}\n  ${C.gray('Allowed')}   ${[...state.allow].join(', ') || '-'}`);
      break;
    case '/tools': for (const [n, t] of Object.entries(TOOLS)) out(`  ${C.bamboo(n.padEnd(16))} ${C.gray(t.description.split('. ')[0])}`); break;
    case '/bashes': if (!state.shells.size) out(C.gray('  No background shells.')); for (const s of state.shells.values()) out(`  ${C.bamboo(s.id)} ${s.status} ${C.gray(s.command)}`); break;
    case '/memory': { const f = path.join(state.cwd, 'PANDA.md'); out(C.gray('  Project memory: ') + f + (fs.existsSync(f) ? '' : C.gray(' (not created yet — use # note or /init)'))); break; }
    case '/cd': { const d = abs(arg || os.homedir()); if (fs.existsSync(d) && fs.statSync(d).isDirectory()) { state.cwd = d; try { process.chdir(d); } catch { } out(C.gray('  ⎿  ') + d); } else out(C.red('  Not a directory: ' + d)); break; }
    case '/resume': case '/continue': {
      const list = listSessions();
      if (!list.length) { out(C.gray('  No saved conversations.')); break; }
      const ri = await ui.select('  ' + C.bold('Resume a conversation'), list.map(s => { const first = (s.messages || []).find(m => m.role === 'user'); return { label: String(first?.content || s.summary || '(empty)').replace(/\s+/g, ' ').slice(0, 60), desc: C.gray(new Date(s._m).toLocaleString() + ' · ' + shortPath(s.cwd || '')) }; }));
      if (list[ri]) { loadSession(list[ri]); out(C.gray(`  ⎿  Resumed conversation (${session.messages.length} messages) in ${state.cwd}`)); }
      break;
    }
    default: out(C.red(`  Unknown command ${cmd}.`) + C.gray(' Try /help'));
  }
}
async function handleInput(text) {
  const t = text.trim();
  if (t.startsWith('/') && !t.startsWith('//') && !/^\/[^\s]*\//.test(t)) return slash(t);
  if (t.startsWith('!')) {
    const cmd = t.slice(1).trim();
    const ac = new AbortController(); ui.abort = ac;
    spinner.start('Running');
    const r = await runShell(cmd, { signal: ac.signal, timeout: 600000 });
    spinner.stop(); ui.abort = null;
    const o = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trimEnd();
    out(o ? o : C.gray('(no output)'));
    pendingContext.push(`<shell-input>${cmd}</shell-input>\n<shell-output exit="${r.code}">\n${truncateMiddle(o, 20000)}\n</shell-output>\n(The user ran this command themselves; use its output as context.)`);
    return;
  }
  if (t.startsWith('#') && !t.startsWith('##')) {
    const f = path.join(state.cwd, 'PANDA.md');
    fs.appendFileSync(f, (fs.existsSync(f) ? '\n' : '# Project notes\n\n') + '- ' + t.slice(1).trim() + '\n');
    out(C.gray('  ⎿  Saved to ') + C.bamboo(rel(f)));
    return;
  }
  const ex = expandMentions(text);
  let imgs = pendingImages.concat(ex.images); pendingImages = [];
  if (imgs.length && state.vision === false) { out(C.yellow(`  ⎿  ${state.model} can't see images, so they were not sent. Switch to a vision model with /model.`)); imgs = []; }
  for (const i of imgs) out(C.gray('  ⎿  ') + '📎 ' + C.bamboo(`${i.name} (${imgKB(i)})`));
  await runTurn(ex.text, imgs);
}

// ───────────────────────────── main ─────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-m' || a === '--model') o.model = val();
    else if (a === '--url' || a === '--base-url') o.url = val();
    else if (a === '--provider' || a === '--kind') o.kind = val();
    else if (a === '--key' || a === '--api-key') o.key = val();
    else if (a === '--ctx') o.ctx = parseInt(val(), 10);
    else if (a === '--yolo' || a === '--dangerously-skip-permissions') o.yolo = true;
    else if (a === '--plan') o.plan = true;
    else if (a === '--accept-edits') o.acceptEdits = true;
    else if (a === '-c' || a === '--continue') o.cont = true;
    else if (a === '-r' || a === '--resume') o.resume = true;
    else if (a === '--setup') o.setup = true;
    else if (a === '--no-pin') process.env.PANDA_NO_PIN = '1';
    else o._.push(a);
  }
  return o;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isStandaloneExe()) { try { const d = path.dirname(process.execPath); for (const f of fs.readdirSync(d)) if (/\.old-\d+\.exe$/.test(f)) { try { fs.unlinkSync(path.join(d, f)); } catch { } } } catch { } } // leftovers of a previous update
  if (args.version) { console.log(`Panda Code ${VERSION}`); return; }
  if (args.help) {
    console.log(`${C.bamboo('🐼 Panda Code')} ${VERSION} — a terminal coding agent for local AI\n
Usage: pandacode [options] [prompt]      (or: panda)

  -p, --print            Run the prompt once, print the result and exit
  -m, --model <name>     Model to use
  --url <url>            Server URL (Ollama: http://localhost:11434, OpenAI-compatible: http://host:port/v1)
  --provider <kind>      ollama | openai
  --key <key>            API key for OpenAI-compatible servers
  --ctx <tokens>         Context window (Ollama num_ctx)
  --yolo                 Never ask for permission (dangerous)
  --plan                 Start in plan mode
  --accept-edits         Auto-accept file edits
  -c, --continue         Continue the most recent conversation
  -r, --resume           Pick a conversation to resume
  --setup                Re-detect the AI server and pick a model

Env: PANDA_URL, PANDA_MODEL, PANDA_API_KEY, OLLAMA_HOST`);
    return;
  }
  const cfg = loadConfig();
  Object.assign(state, {
    kind: cfg.kind || 'ollama', baseUrl: cfg.baseUrl || '', apiKey: cfg.apiKey || '', model: cfg.model || '', providerName: cfg.providerName || 'Custom',
    numCtx: cfg.numCtx || 32768, think: cfg.think ?? null, showThinking: !!cfg.showThinking, keepAlive: cfg.keepAlive || '30m', pin: cfg.pin, mouse: cfg.mouse, imageUrl: cfg.imageUrl, imageKind: cfg.imageKind, repo: cfg.repo,
  });
  if (args._[0] === 'update') { await updateCmd(args._.slice(1).join(' '), { headless: true }); process.exit(0); }
  if (process.env.PANDA_URL) state.baseUrl = process.env.PANDA_URL;
  if (process.env.PANDA_MODEL) state.model = process.env.PANDA_MODEL;
  if (process.env.PANDA_API_KEY) state.apiKey = process.env.PANDA_API_KEY;
  if (args.url) { state.baseUrl = args.url; state.kind = args.kind || (/\/v1\/?$/.test(args.url) ? 'openai' : 'ollama'); state.providerName = state.kind === 'ollama' ? 'Ollama' : 'Custom'; }
  if (args.kind) state.kind = args.kind === 'ollama' ? 'ollama' : 'openai';
  if (args.key) state.apiKey = args.key;
  if (args.ctx) state.numCtx = args.ctx;
  if (args.model) state.model = args.model;
  if (args.yolo) state.mode = 'bypass'; else if (args.plan) state.mode = 'plan'; else if (args.acceptEdits) state.mode = 'acceptEdits';

  // ── print mode ──
  if (args.print) {
    state.interactive = false;
    let prompt = args._.join(' ');
    if (!process.stdin.isTTY) { const chunks = []; for await (const c of process.stdin) chunks.push(c); const piped = Buffer.concat(chunks).toString('utf8').trim(); if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped; }
    if (!prompt) { console.error('No prompt given.'); process.exit(1); }
    if (!state.baseUrl) { const f = await detectProviders(); if (!f.length) { console.error('No local AI server found. Use --url.'); process.exit(1); } state.kind = f[0].kind; state.baseUrl = f[0].url; state.providerName = f[0].name; }
    if (!state.model) { const ms = await listModels(); if (!ms.length) { console.error('No models available.'); process.exit(1); } state.model = ms[0].name; }
    try { const ms = await listModels(); const m = ms.find(x => x.name === state.model || x.name === state.model + ':latest'); if (m?.caps) { state.nativeTools = m.caps.includes('tools'); state.vision = m.caps.includes('vision'); } if (m?.ctx && state.kind === 'ollama' && state.numCtx > m.ctx) state.numCtx = m.ctx; } catch { }
    if (/^\/flaws\b/i.test(prompt)) { // headless review: panda -p "/flaws <purpose>"
      prompt = flawsPrompt(prompt.replace(/^\/flaws\s*/i, '').trim() || 'general quality and correctness', projectDigest(0).text);
      state.readonlyTurn = true;
    }
    const ex = expandMentions(prompt);
    session.messages.push(ex.images.length && state.vision !== false ? { role: 'user', content: ex.text, images: ex.images } : { role: 'user', content: ex.text });
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    const res = await agentLoop(session.messages, { signal: ac.signal, depth: 0, indent: '', quiet: !process.stdout.isTTY });
    spinner.stop();
    if (!process.stdout.isTTY) { // piped output: print the final answer (for /flaws: the whole report, not just the last message)
      const all = state.readonlyTurn ? session.messages.filter(m => m.role === 'assistant' && m.content).map(m => m.content).join('\n\n') : res;
      if (all) process.stdout.write(all + '\n');
    }
    saveSession();
    process.exit(0);
  }

  if (!process.stdin.isTTY) { console.error('Panda Code needs an interactive terminal. Use -p for non-interactive mode.'); process.exit(1); }
  if (useColor) process.stdout.write('\x1b]0;🐼 Panda Code\x07');
  ui.init();
  ui.handler = handleInput;
  ui.busy = true;
  process.stdout.write('\n');

  if (args.setup || !state.baseUrl) await setupProvider(true);
  let models = [];
  try { models = await listModels(); }
  catch {
    out(C.yellow(`  ⚠ Can't reach ${state.baseUrl}.`));
    if (await setupProvider(true)) { try { models = await listModels(); } catch { } }
  }
  const cur = models.find(m => m.name === state.model || m.name === state.model + ':latest');
  if (cur) { state.model = cur.name; state.nativeTools = !cur.caps || cur.caps.includes('tools'); state.vision = cur.caps ? cur.caps.includes('vision') : null; if (state.kind === 'ollama' && cur.ctx && state.numCtx > cur.ctx) state.numCtx = cur.ctx; }
  else if (models.length) {
    if (models.length === 1) setModel(models[0]);
    else await pickModel();
  }
  else if (state.kind === 'ollama' && !models.length) { // brand-new PC: Ollama is running but has no models yet
    out(C.yellow('  No models are installed yet. Pick one to download; the list is ordered for this PC.'));
    await pickModel();
  }
  saveConfig();
  if (pinHeader()) out(hdr.tip); else out(banner());
  if (args.cont) { const l = listSessions().find(s => s.cwd === state.cwd) || listSessions()[0]; if (l) { loadSession(l); out(C.gray(`  ⎿  Continuing conversation (${session.messages.length} messages)`)); } }
  else if (args.resume) await slash('/resume');
  ui.busy = false;
  if (process.env.PANDA_SELFTEST === 'view') { // developer self-test of the scroll-back view (drives it with synthetic wheel / key events)
    for (let i = 1; i <= 120; i++) out(`selftest line ${i} ` + 'x'.repeat((i % 7) * 12));
    setTimeout(() => process.stdin.emit('data', Buffer.from('\x1b[<64;10;10M')), 1500);
    setTimeout(() => process.stdin.emit('keypress', undefined, { name: 'pageup' }), 3500);
    setTimeout(() => out('selftest: this line arrived while scrolled back'), 4500);
    setTimeout(() => process.stdin.emit('keypress', undefined, { name: 'end' }), 7500);
  }
  if (process.env.PANDA_SELFTEST === 'ghost') { // developer self-test of ghost-text completion
    setTimeout(() => process.stdin.emit('data', Buffer.from('/mo')), 800);
    setTimeout(() => out('selftest typed "/mo": ghost=[' + ui.ghost + '] line=[' + ui.rl.line + ']'), 1500);
    setTimeout(() => process.stdin.emit('data', Buffer.from('\t')), 2000);
    setTimeout(() => out('selftest after Tab: line=[' + ui.rl.line + '] ghost=[' + ui.ghost + ']'), 2700);
    setTimeout(() => process.stdin.emit('data', Buffer.from('\x15/btw ')), 3200); // Ctrl+U then "/btw "
    setTimeout(() => out('selftest "/btw ": ghost=[' + ui.ghost + ']'), 3900);
    setTimeout(() => process.stdin.emit('data', Buffer.from('\x15@pan')), 4400);
    setTimeout(() => out('selftest "@pan": ghost=[' + ui.ghost + ']'), 5100);
  }
  if (process.env.PANDA_SELFTEST === 'flow') { // developer self-test: request -> permission menu -> /undo -> /model menu
    const T = (ms, fn) => setTimeout(fn, ms), type = s => process.stdin.emit('data', Buffer.from(s));
    let step = 0;
    T(1000, () => type('Create a file named hello.txt containing the word hi using the Write tool. Do nothing else.\r'));
    const iv = setInterval(() => {
      if (step === 0 && ui.menuLines) { step = 1; out('selftest: permission menu is showing'); T(12000, () => { type('\r'); step = 2; }); }
      else if (step === 2 && !ui.busy && !ui.menuLines) {
        step = 3; out('selftest: run finished; hello.txt exists=' + fs.existsSync(abs('hello.txt')));
        T(800, () => type('/undo\r'));
        T(3500, () => { out('selftest: after /undo hello.txt exists=' + fs.existsSync(abs('hello.txt'))); type('/model\r'); });
        T(5500, () => type('\x1b[B'));
        T(14000, () => type('\r'));
        T(16500, () => { out('selftest: model is now ' + state.model); clearInterval(iv); });
      }
    }, 300);
  }
  if (process.env.PANDA_SELFTEST === 'flaws') { // developer self-test: /flaws asks for the purpose, then starts the review
    const T = (ms, fn) => setTimeout(fn, ms), type = s => process.stdin.emit('data', Buffer.from(s));
    T(800, () => type('/flaws\r'));
    T(4500, () => { out('selftest: purpose was asked; answering'); type('a tiny todo app that must add and list tasks\r'); });
    T(16000, () => { out('selftest: busy=' + ui.busy + ' readonlyTurn=' + state.readonlyTurn + ' — pressing Ctrl+C'); type('\x03'); });
    T(19000, () => out('selftest: after Ctrl+C busy=' + ui.busy + ' readonlyTurn=' + state.readonlyTurn));
  }
  if (process.env.PANDA_SELFTEST === 'picker') { // developer self-test: open the /model picker, look at it, cancel
    setTimeout(() => process.stdin.emit('data', Buffer.from('/model\r')), 1000);
    setTimeout(() => process.stdin.emit('data', Buffer.from('\x1b[A')), 9000); // wraps to the bottom of the list
    setTimeout(() => process.stdin.emit('data', Buffer.from('\x1b')), 16000);
  }
  if (process.env.PANDA_SELFTEST === 'enter') { // developer self-test: empty Enter presses must not move or stack prompts
    setTimeout(() => process.stdin.emit('data', Buffer.from('\r\r\r\r\r\r')), 1200);
  }
  if (process.env.PANDA_SELFTEST === 'btw') { // developer self-test: types a /btw question while the main agent is busy
    setTimeout(() => process.stdin.emit('data', Buffer.from('/btw what files are in this project? one sentence\r')), 3000);
  }
  if (args._.length) ui.run(args._.join(' '));
  else ui.prompt();
}

process.on('unhandledRejection', e => { spinner.stop(); out(C.red('  Unexpected error: ' + (e?.stack || e))); });
main().catch(e => { spinner.stop(); console.error(C.red('Fatal: ' + (e?.stack || e))); process.exit(1); });
