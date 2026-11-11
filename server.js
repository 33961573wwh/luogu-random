#!/usr/bin/env node
'use strict';
/* 洛谷模拟卷本地控制台服务（零第三方依赖，仅监听 127.0.0.1）
 *   node server.js                 启动后访问 http://127.0.0.1:8765
 *   node server.js --port 9000     指定端口（被占用时自动顺延）
 *   node server.js --open          启动后自动打开浏览器
 *
 * 网页里的「生成下一套」会通过本服务调用 gen.js，日志实时回传，
 * 生成的 PDF / HTML / Markdown 可直接在网页里预览。
 * 「清空生成记录」通过 POST /api/clear-records 重置 state.json，
 * 清空前会自动备份，默认不删除已有成品文件。
 *
 * 纯在线、无本地题库：题目、难度、题号全部实时取自洛谷在线 P 题库（type=P），
 * 不读取本地题单、不写题面/难度缓存。控制台只展示在线读取的 P 题库规模；
 * state.json 仅记录卷号与生成历史，不参与抽题。
 * 难度既支持整卷统一筛选，也支持「每道题各选一个难度」（perDifficulties）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const D = require('./lib/difficulty');

const BASE = __dirname;
const CONFIG_FILE = path.join(BASE, 'config.json');
const STATE_FILE = path.join(BASE, 'state.json');
const UI_FILE = path.join(BASE, 'ui', 'index.html');
const PAPER_KEYS = ['title', 'subtitle', 'header', 'source'];

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const WANT_PORT = Number(argVal('--port', process.env.LGPDF_PORT || 8765)) || 8765;
const AUTO_OPEN = process.argv.includes('--open');

const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fallback; }
};
const config = () => readJSON(CONFIG_FILE, {});
const state = () => readJSON(STATE_FILE, { papers: 0, used: [], history: [] });
const resolveCfg = p => (path.isAbsolute(p) ? p : path.join(BASE, p || ''));
const outDir = () => resolveCfg(config().outDir || 'out');
const sanitize = s => String(s == null ? '' : s).replace(/[<>\r\n]/g, '').trim().slice(0, 200);

const MIME = {
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

function outputs() {
  const dir = outDir();
  const st = state();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')); }
  catch (_) { return []; }
  const rel = f => '/out/' + encodeURIComponent(f);
  return files.map(f => {
    const stat = fs.statSync(path.join(dir, f));
    const no = Number((f.match(/第(\d+)套/) || [])[1] || 0);
    const history = (st.history || []).find(h => h.no === no) || {};
    const stem = f.replace(/\.pdf$/i, '');
    const has = ext => fs.existsSync(path.join(dir, stem + ext)) ? rel(stem + ext) : null;
    return {
      no, name: stem, pdf: rel(f), html: has('.html'), md: has('.md'),
      sizeKB: Math.round(stat.size / 1024), date: stat.mtime.toISOString(),
      pids: history.pids || []
    };
  }).sort((a, b) => (b.no - a.no) || b.date.localeCompare(a.date));
}

/* ---------------- 洛谷在线 P 题库规模（唯一的数据源，仅用于控制台展示） ---------------- */
let luoguPool = { type: 'P', loading: false, updatedAt: null,
  total: null, levels: {}, error: null };
function refreshPoolCounts() {
  if (luoguPool.loading) return { started: false };
  luoguPool.loading = true;
  luoguPool.error = null;
  D.onlinePoolCounts().then(r => {
    luoguPool = { type: 'P', loading: false, updatedAt: r.updatedAt,
      total: r.total, levels: r.levels, error: null };
    console.log(`洛谷在线 P 题库规模已读取：${r.total} 道`);
  }).catch(e => {
    luoguPool.loading = false;
    luoguPool.error = e.message;
    console.log('洛谷 P 题库规模读取失败：' + e.message);
  });
  return { started: true };
}

// 旧版控制台的「同步难度」入口：现在没有任何本地题库/难度索引可同步，
// 保留为「刷新在线题库规模」的别名，避免旧页面点击后报错。
const syncSummary = () => ({ running: luoguPool.loading, done: 0, total: 0,
  ok: 0, fail: 0, startedAt: null, finishedAt: luoguPool.updatedAt,
  result: null, error: luoguPool.error, auto: false });

/* ---------------- 生成任务（同一时刻只允许一个） ---------------- */
let task = {
  running: false, startedAt: null, finishedAt: null, exitCode: null,
  logs: [], result: null, error: null, options: null
};
let child = null;
let killTimer = null;

function taskSummary() {
  return {
    running: task.running, startedAt: task.startedAt, finishedAt: task.finishedAt,
    exitCode: task.exitCode, result: task.result, error: task.error,
    options: task.options, logs: task.logs.slice(-300)
  };
}

function startGenerate(body) {
  if (task.running) return { status: 409, body: { error: '已有生成任务正在运行，请稍候或先停止。' } };
  const count = Math.max(1, Math.min(8, Number(body.count) || 4));
  // 只接受洛谷 P 题库题号；指定题号模式也严格限定在 P 题库内
  const pids = Array.isArray(body.pids)
    ? [...new Set(body.pids.map(String).map(s => s.trim().toUpperCase()).filter(s => /^P\d{4,6}$/.test(s)))].slice(0, 8)
    : [];
  // 默认完全随机：只有在网页明确勾选时才优先避开已抽过的题
  const avoidUsed = body.avoidUsed === true;
  const difficulties = Array.isArray(body.difficulties)
    ? [...new Set(body.difficulties.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 8))]
    : [];
  // 逐题难度：长度为 count 的数组，每项是该题允许的难度档数组；空数组 = 不限。
  // 9 档全选也等价于不限，避免为「不限」额外构造题库池。
  let perDifficulties = null;
  if (Array.isArray(body.perDifficulties)) {
    perDifficulties = [];
    for (let i = 0; i < count; i++) {
      const item = body.perDifficulties[i];
      const arr = Array.isArray(item) ? item : (item == null || item === '' ? [] : [item]);
      const levels = [...new Set(arr.map(Number)
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 8))].sort((a, b) => a - b);
      perDifficulties.push(levels.length === 9 ? [] : levels);
    }
  }
  const usePer = !!perDifficulties && !pids.length && perDifficulties.some(a => a.length);
  const paper = {};
  for (const k of PAPER_KEYS) {
    if (body.paper && typeof body.paper[k] === 'string' && body.paper[k].trim()) paper[k] = sanitize(body.paper[k]);
  }

  const work = path.join(outDir(), '.work');
  fs.mkdirSync(work, { recursive: true });
  const overrideFile = path.join(work, 'ui-override.json');
  fs.writeFileSync(overrideFile, JSON.stringify({ paper }, null, 2), 'utf8');

  const argv = [path.join(BASE, 'gen.js'), '--config-override', overrideFile, '--count', String(count)];
  if (pids.length) argv.push('--pids', pids.join(','));
  if (avoidUsed) argv.push('--avoid-used');
  // 逐题难度优先：逐题模式开启时不再传整卷 --difficulty（避免两种筛选互相冲突）。
  // 指定题号模式不使用任何难度筛选。
  if (usePer) {
    argv.push('--per-difficulty', perDifficulties.map(a => a.length ? a.join('|') : '-').join(','));
  } else if (difficulties.length && difficulties.length < 9) {
    argv.push('--difficulty', difficulties.join(','));
  }

  task = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    logs: [], result: null, error: null,
    options: { count, pids, online: true, avoidUsed,
      difficulties: usePer ? [] : difficulties,
      perDifficulties: usePer ? perDifficulties : null,
      difficultyMode: usePer ? 'per-problem' : (difficulties.length && difficulties.length < 9 ? 'global' : 'none'),
      paper }
  };
  const dec = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  const feed = (chunk, kind) => {
    const text = dec[kind].write(chunk);
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      // 机器可读的结果行只用于解析，不显示在网页日志里
      if (line.includes('LGPDF_RESULT=')) { task._resultLine = line; continue; }
      task.logs.push(line);
      if (task.logs.length > 800) task.logs.shift();
    }
  };

  child = spawn(process.execPath, argv, {
    cwd: BASE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LGPDF_FROM_UI: '1' }
  });
  child.stdout.on('data', d => feed(d, 'out'));
  child.stderr.on('data', d => feed(d, 'err'));
  child.on('error', e => {
    task.logs.push('启动生成器失败：' + e.message);
    task.error = e.message;
  });
  child.on('close', code => {
    clearTimeout(killTimer);
    child = null;
    task.running = false;
    task.exitCode = code;
    task.finishedAt = new Date().toISOString();
    const line = task._resultLine || [...task.logs].reverse().find(l => l.includes('LGPDF_RESULT='));
    if (code === 0 && line) {
      try {
        const r = JSON.parse(line.slice(line.indexOf('LGPDF_RESULT=') + 'LGPDF_RESULT='.length));
        const rel = p => p ? '/out/' + encodeURIComponent(path.basename(p)) : null;
        task.result = {
          no: r.no, pids: r.pids, names: r.names,
          pdf: rel(r.pdf), html: rel(r.html), md: rel(r.md)
        };
      } catch (e) { task.error = '结果解析失败：' + e.message; }
    } else {
      task.error = task.logs.slice(-12).join('\n') || ('生成器退出码 ' + code);
    }
  });
  // 防止异常卡死：15 分钟后强制结束
  killTimer = setTimeout(() => {
    if (child) { task.logs.push('生成超时（15 分钟），已终止。'); try { child.kill(); } catch (_) { } }
  }, 15 * 60 * 1000);

  return { status: 200, body: { started: true, argv: argv.slice(1), task: taskSummary() } };
}

function stopGenerate() {
  if (!task.running || !child) return { status: 409, body: { error: '当前没有运行中的任务。' } };
  task.logs.push('用户请求停止生成…');
  try { child.kill(); } catch (_) { }
  return { status: 200, body: { stopped: true } };
}

/* ---------------- 清空生成记录（默认只清记录，不动成品文件） ---------------- */
const OUTPUT_RE = /_第\d+套_\d{8}\.(pdf|html|md)$/i;

function clearRecords(body) {
  if (task.running) {
    return { status: 409, body: { error: '生成任务正在运行，请等待完成或先停止后再清空记录。' } };
  }
  const st = state();
  const cleared = {
    papers: Number(st.papers) || 0,
    used: Array.isArray(st.used) ? st.used.length : 0,
    history: Array.isArray(st.history) ? st.history.length : 0,
    logs: task.logs.length
  };
  const dir = outDir();
  const work = path.join(dir, '.work');
  fs.mkdirSync(work, { recursive: true });

  // 先备份再清空：万一误点，可从备份文件手工恢复
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(work, `state-backup-${ts}.json`);
  const raw = fs.existsSync(STATE_FILE)
    ? fs.readFileSync(STATE_FILE, 'utf8')
    : JSON.stringify({ papers: 0, used: [], history: [] }, null, 2);
  fs.writeFileSync(backup, raw, 'utf8');

  fs.writeFileSync(STATE_FILE, JSON.stringify({ papers: 0, used: [], history: [] }, null, 2) + '\n', 'utf8');

  const deleted = [];
  if (body && body.deleteFiles === true) {
    for (const f of fs.readdirSync(dir)) {
      if (!OUTPUT_RE.test(f)) continue;                 // 只删生成器按「第N套」命名的成品
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      fs.unlinkSync(full);
      deleted.push(f);
    }
  }

  // 进度面板一并归零，避免网页还显示上一次「第 N 套已生成」
  clearTimeout(killTimer);
  task = { running: false, startedAt: null, finishedAt: null, exitCode: null,
    logs: [], result: null, error: null, options: null };

  return { status: 200, body: {
    cleared, filesDeleted: deleted.length,
    backup: path.relative(BASE, backup).split(path.sep).join('/'),
    nextNo: 1
  } };
}

function status() {
  const cfg = config();
  const st = state();
  return {
    config: { paper: cfg.paper || {}, outDir: cfg.outDir || 'out' },
    state: { papers: st.papers, used: st.used, history: st.history },
    nextNo: st.papers + 1,
    outputs: outputs(), task: taskSummary(), syncJob: syncSummary(),
    levels: D.LEVELS,
    luoguPool: { ...luoguPool },
    mode: { statementCache: false, localProblemData: false, pool: 'luogu-online-P',
      difficultyDefault: 'per-problem',
      note: '题号、难度、题面全部实时取自洛谷在线 P 题库（type=P）；项目内没有任何本地题单或题面/难度缓存。控制台默认按逐题难度设置，每题独立起页。' },
    server: { base: BASE, node: process.version, pid: process.pid }
  };
}

/* ---------------- HTTP ---------------- */
function send(res, code, data, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('请求不是合法 JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}
function serveFile(res, file, download) {
  let name, dir;
  try { name = decodeURIComponent(file); } catch (_) { return send(res, 400, { error: '文件名编码错误' }); }
  if (/[\\/]/.test(name) || name.includes('..') || path.basename(name) !== name) {
    return send(res, 400, { error: '非法文件名' });
  }
  dir = outDir();
  const full = path.join(dir, name);
  if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, { error: '文件不存在：' + name });
  }
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type, 'Content-Length': fs.statSync(full).size, 'Cache-Control': 'no-store'
  };
  if (download) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(name);
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); }
  catch (_) { return send(res, 400, { error: '非法请求' }); }
  const pathname = u.pathname;
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!fs.existsSync(UI_FILE)) return send(res, 500, { error: '缺少 ui/index.html' });
      return send(res, 200, fs.readFileSync(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (pathname.startsWith('/out/')) {
      return serveFile(res, pathname.slice('/out/'.length), u.searchParams.has('download'));
    }
    if (req.method === 'GET' && pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'GET' && pathname === '/api/task') return send(res, 200, taskSummary());
    if (req.method === 'GET' && pathname === '/api/sync-status') return send(res, 200, syncSummary());
    // 兼容旧版控制台：没有本地题库可同步，等价为「刷新在线 P 题库规模」
    if (req.method === 'POST' && pathname === '/api/sync-difficulty') {
      await readBody(req);
      return send(res, 200, { ...refreshPoolCounts(), online: true, localProblemData: false });
    }
    if (req.method === 'POST' && pathname === '/api/refresh-pool-counts') {
      return send(res, 200, refreshPoolCounts());
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      const body = await readBody(req);
      const r = startGenerate(body);
      return send(res, r.status, r.body);
    }
    if (req.method === 'POST' && pathname === '/api/stop') {
      const r = stopGenerate();
      return send(res, r.status, r.body);
    }
    if (req.method === 'POST' && pathname === '/api/clear-records') {
      const body = await readBody(req);
      const r = clearRecords(body);
      return send(res, r.status, r.body);
    }
    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readBody(req);
      const cfg = config();
      cfg.paper = cfg.paper || {};
      for (const k of PAPER_KEYS) {
        if (body.paper && typeof body.paper[k] === 'string' && body.paper[k].trim()) {
          cfg.paper[k] = sanitize(body.paper[k]);
        }
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      return send(res, 200, { saved: true, paper: cfg.paper });
    }
    if (req.method === 'POST' && pathname === '/api/reveal') {
      const dir = outDir();
      if (process.platform === 'win32') {
        const p = spawn('explorer.exe', [dir], { stdio: 'ignore', windowsHide: true });
        p.on('error', () => { });
      }
      return send(res, 200, { opened: dir });
    }
    return send(res, 404, { error: '未找到：' + pathname });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

function listen(port, left) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && left > 0) { console.log(`端口 ${port} 被占用，尝试 ${port + 1}…`); listen(port + 1, left - 1); }
    else { console.error('服务启动失败：', e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('洛谷模拟卷控制台已启动：' + url);
    console.log('工作目录：' + BASE);
    console.log('按 Ctrl+C 结束服务。');
    if (AUTO_OPEN && process.platform === 'win32') {
      const p = spawn('cmd', ['/c', 'start', url], { stdio: 'ignore', windowsHide: true });
      p.on('error', () => { });
    }
  });
}
// 服务启动后在后台在线读取一次洛谷 P 题库规模（仅用于控制台展示）。
// 这里没有任何本地题库文件需要读取或同步；失败不影响生成。
setTimeout(() => {
  try { refreshPoolCounts(); }
  catch (e) { console.log('P 题库规模读取未能启动：' + e.message); }
}, 800);
listen(WANT_PORT, 10);
