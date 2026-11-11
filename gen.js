#!/usr/bin/env node
'use strict';
/* 洛谷模拟卷生成器：每次从洛谷在线 P 题库抽 4 道中文题面，
 * 用 A Boat + ext-luogu.mext 渲染洛谷新特性，导出仿 CSP-J 二轮真题的 PDF。
 *
 * 纯在线、无本地题库：题号、难度、题面全部实时取自洛谷，不读取任何本地题单、
 * 不读写题面/难度缓存。抽题范围严格限定 P 题库（type=P），排除 B/CF/AT/SP 等。
 * 抽题默认「完全随机」：直接用洛谷自带的筛选列表页
 * （problem/list?type=P&difficulty=N&page=P，不选难度就是 P 全库），随机一个
 * 全局序号定位到具体题目，等概率抽取；每道题独立起页。
 * state.json 只记录卷号与生成历史（不参与抽题决策，--avoid-used 时除外）。
 *
 * 用法：
 *   node gen.js                         从洛谷在线 P 题库完全随机抽 4 道题
 *   node gen.js --pids P1007,P17171,P1001,P5521   指定 P 题目
 *   node gen.js --count 6             指定每套题数（1–8）
 *   node gen.js --out D:/xxx          指定输出目录
 *   node gen.js --difficulty 2,3,4   整卷只抽指定洛谷难度（0–8，支持 2-5 区间，抓题面后复核）
 *   node gen.js --per-difficulty 2,3,4,5   逐题指定难度：第1题2级、第2题3级…
 *     每题可用 - 表示不限、| 表示允许多档（3|4）、2-5 表示区间；不足的题按「不限」补齐
 *   node gen.js --config-override F   用 JSON 文件覆盖卷头设置（供网页控制台调用）
 *   --candidates P...,P...           兼容旧调用：从给定 P 候选池抽（默认已不走这条路径）
 *   --avoid-used                      可选：跳过历史上抽到过的题（默认关闭）
 *   --allow-repeat / --refresh / --no-cache  仅为兼容旧命令保留，现已是默认行为
 */
const fs = require('fs');
const path = require('path');
const BASE = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));
const resolveCfg = p => (path.isAbsolute(p) ? p : path.join(BASE, p));
config.editorHtml = resolveCfg(config.editorHtml);
config.extensions = config.extensions.map(resolveCfg);

/* 网页控制台可临时覆盖卷头文字，不写坏默认 config.json。
 * 只允许覆盖 paper 下的白名单字段。 */
function applyOverride(file) {
  if (!file) return;
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paper = (o && o.paper) || {};
  const keys = ['title', 'subtitle', 'header', 'source'];
  for (const k of keys) {
    if (typeof paper[k] === 'string' && paper[k].trim()) config.paper[k] = paper[k].trim();
  }
}

const L = require('./lib/luogu');
const D = require('./lib/difficulty');
const { buildPaperMarkdown } = require('./lib/paper');
const { renderPaper } = require('./lib/render');
const C = require('./lib/chrome');

const log = (...a) => console.log(...a);
// 抽题范围严格限定洛谷 P 题库（B/CF/AT/SP 等一律不抽）
const P_PID = /^P\d{4,6}$/;

/* 难度参数：--difficulty 2,3,4 或 --difficulty 2-5，范围 0–8 */
function parseDifficulty(s) {
  if (!s) return null;
  const set = new Set();
  for (const part of String(s).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (m) {
      const lo = Math.min(Number(m[1]), Number(m[2])), hi = Math.max(Number(m[1]), Number(m[2]));
      for (let i = lo; i <= hi; i++) if (i >= 0 && i <= 8) set.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 0 && n <= 8) set.add(n);
    }
  }
  return set.size ? set : null;
}

/* 逐题难度：--per-difficulty 2,3,4,5 / 2,-,3|4,5-7
 * 逗号分隔对应第 1、2、3… 题；每题：
 *   -  / * / any / 留空     → 不限难度
 *   3|4                    → 该题允许 3 或 4 级
 *   2-5 / 2~5              → 该题允许 2–5 级
 *   3                      → 只允许 3 级
 * 不足 count 的题按「不限」补齐，超出部分忽略。
 * @returns {Array<Set<number>|null>|null} 每项 null 表示不限难度
 */
function parsePerDifficulty(s, count) {
  if (s == null || String(s).trim() === '') return null;
  const raw = String(s).split(',');
  const slots = [];
  for (let i = 0; i < count; i++) {
    const token = (raw[i] == null ? '' : raw[i]).trim();
    if (!token || token === '-' || token === '*' || /^any$/i.test(token)) { slots.push(null); continue; }
    const set = new Set();
    for (const seg of token.split('|')) {
      const t = seg.trim();
      const m = t.match(/^(\d+)\s*[-~]\s*(\d+)$/);
      if (m) {
        const lo = Math.min(Number(m[1]), Number(m[2])), hi = Math.max(Number(m[1]), Number(m[2]));
        for (let d = lo; d <= hi; d++) if (d >= 0 && d <= 8) set.add(d);
      } else if (/^\d+$/.test(t)) {
        const d = Number(t);
        if (d >= 0 && d <= 8) set.add(d);
      }
    }
    slots.push(set.size ? set : null);
  }
  return slots;
}

function parseArgs(argv) {
  const a = { pids: null, candidates: null, count: 4, out: null, help: false,
    avoidUsed: false, override: null, difficulties: null,
    perDifficultyRaw: null, perDifficulties: null };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--pids') a.pids = argv[++i].split(/[\s,]+/).filter(Boolean).map(x => x.toUpperCase());
    else if (s === '--count') a.count = Math.max(1, Math.min(8, Number(argv[++i]) || 4));
    else if (s === '--out') a.out = argv[++i];
    // 现在默认就是「实时联网 + 完全随机」，下面两个旧参数仅作兼容
    else if (s === '--refresh' || s === '--no-cache' || s === '--allow-repeat') { /* no-op */ }
    else if (s === '--avoid-used') a.avoidUsed = true;
    else if (s === '--difficulty') a.difficulties = parseDifficulty(argv[++i]);
    else if (s === '--per-difficulty') a.perDifficultyRaw = argv[++i];
    else if (s === '--candidates') a.candidates = String(argv[++i] || '')
      .split(/[\s,]+/).filter(x => /^P\d{4,6}$/i.test(x)).map(x => x.toUpperCase());
    else if (s === '--config-override') a.override = argv[++i];
    else if (s === '--help' || s === '-h') a.help = true;
  }
  // --count 可能出现在 --per-difficulty 之后，因此放到最后再按题数展开
  if (a.perDifficultyRaw != null) a.perDifficulties = parsePerDifficulty(a.perDifficultyRaw, a.count);
  return a;
}

function loadState() {
  const f = path.join(BASE, 'state.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return { papers: 0, used: [], history: [] };
}
function saveState(s) {
  fs.writeFileSync(path.join(BASE, 'state.json'), JSON.stringify(s, null, 2), 'utf8');
}

function dateCN(d) {
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function featureTags(p) {
  const all = Object.values(p.sections).join('\n');
  const f = [];
  if (/::cute-table|:::info|:::warning|:::success|:::error|:::align|:::epigraph|^:::/m.test(all)) f.push('容器/折叠框');
  if (/^\s*\|\s*\^|\^\s*\|/m.test(all)) f.push('合并单元格');
  if (/line-numbers|lines=/.test(all)) f.push('行号代码');
  if (/\$[^$]+\$|\\\(/.test(all)) f.push('KaTeX');
  return f.join('、') || '常规 Markdown';
}

async function pickProblems(args, state) {
  const chosen = [];
  const cache = new Map();       // pid -> 已抓到的题面（同一题只联网一次）
  const accepted = new Set();    // 已选入试卷的题，保证不重复
  const reported = new Set();    // 同一题的跳过原因只打印一次
  let skippedByDiff = 0;
  let pool = null;

  // 三种模式优先级：指定题号 > 逐题难度 > 整卷统一难度。
  // 指定题号时不加任何难度限制（用户明确选了题，尊重选择）。
  // 全部题目都填「不限」时等价于默认的整卷随机，复用默认分支可少发请求
  const perMode = !args.pids && !!args.perDifficulties && args.perDifficulties.some(s => s);
  if (perMode && args.difficulties) log('同时给了 --difficulty 与 --per-difficulty，以逐题难度为准。');
  const diffSet = args.pids ? null : (perMode ? null : args.difficulties);
  const desc = s => s
    ? [...s].sort((a, b) => a - b).map(d => `${d} ${D.label(d)}`).join(' / ')
    : '不限难度';

  // 同一题的跳过原因只打印一次，避免逐题模式下反复刷日志
  const note = (pid, text) => {
    if (reported.has(pid)) return false;
    reported.add(pid);
    log(`  · ${pid} ${text}`);
    return true;
  };
  // 抓取并核验单题；返回 problem 或 null。
  // 详情页一次请求同时返回题面原文与 difficulty，抓到后按实时难度复核。
  // 逐题难度下，某题不符第 N 题的难度仍可能符合第 M 题：缓存题面供其它题位复用，
  // 既不重复联网，也不会把可用题目误拉黑。
  const attempt = async (pid, want) => {
    if (!P_PID.test(pid)) { note(pid, '不属于 P 题库，跳过'); return null; }
    if (accepted.has(pid)) return null;
    if (args.avoidUsed && state.used.includes(pid)) {
      note(pid, '历史上抽到过，按 --avoid-used 跳过');
      return null;
    }
    let p;
    if (cache.has(pid)) p = cache.get(pid);
    else {
      try {
        p = L.fetchProblem(pid);   // 首次遇到该题时实时联网
        await C.sleep(350);        // 联网抓题后限速，避免触发风控
      } catch (e) {
        note(pid, `抓取失败: ${e.message}`);
        await C.sleep(350);
        p = null;
      }
      cache.set(pid, p);
    }
    if (!p) return null;
    if (!L.isChinese(p)) { note(pid, '非中文题面，跳过'); return null; }
    if (want && (p.difficulty == null || !want.has(Number(p.difficulty)))) {
      if (note(pid, `难度 ${p.difficulty == null ? '未评定' : p.difficulty + ' ' + D.label(p.difficulty)} 不符合要求（需 ${desc(want)}），跳过`)) skippedByDiff++;
      return null;
    }
    accepted.add(pid);
    return p;
  };
  const take = (p, slot) => {
    log(`  ✓ ${slot ? `第 ${slot} 题 · ` : ''}${p.pid} ${p.name}（在线 ${p.elapsedMs}ms） · ` +
      `难度 ${p.difficulty} ${D.label(p.difficulty)} · 样例 ${p.samples.length} 组 · ${featureTags(p)}`);
    return p;
  };

  log('抽题数据：题号 / 难度 / 题面全部实时取自洛谷，不读取本地题库，不写任何缓存。');

  // 指定题号 / 兼容的候选池参数：仍按给定的题目列表抽，但仅限 P 题库
  let fixed = null;
  if (args.pids) {
    const bad = args.pids.filter(pid => !P_PID.test(pid));
    if (bad.length) throw new Error('只允许指定洛谷 P 题库题号，以下题号不合法：' + bad.join('、'));
    fixed = args.pids.slice();
    if (args.difficulties || args.perDifficulties) log('已指定题号，难度筛选不生效。');
  } else if (args.candidates && args.candidates.length) {
    fixed = args.candidates.slice();
    log(`已给定 ${fixed.length} 道候选题（兼容参数），从中完全随机抽取。`);
    if (args.perDifficulties) log('已给定候选池，逐题难度筛选不生效。');
  }

  if (fixed) {
    let candidates;
    if (args.pids) {
      candidates = fixed;
      log(`指定题号 ${fixed.length} 道，按给定顺序抓取。`);
    } else if (args.avoidUsed) {
      const unused = fixed.filter(id => !state.used.includes(id));
      candidates = L.shuffle(unused).concat(L.shuffle(fixed.filter(id => state.used.includes(id))));
      log(`候选池 ${fixed.length} 道，已用 ${state.used.length} 道；按 --avoid-used 优先抽未用过的题。`);
    } else {
      candidates = L.shuffle(fixed);
      log(`候选池 ${fixed.length} 道，完全随机抽取（不避开已抽过的 ${state.used.length} 道题）。`);
    }
    for (const pid of candidates) {
      if (chosen.length >= args.count) break;
      const p = await attempt(pid, null);
      if (p) chosen.push(take(p));
    }
  } else if (perMode) {
    // 逐题难度：每道题各自从对应难度范围的在线 P 题库随机抽，结果严格按题号顺序返回
    const slots = args.perDifficulties;
    const poolCache = new Map();
    const poolKey = s => s ? [...s].sort((a, b) => a - b).join('-') : 'all';
    const getPool = async s => {
      const key = poolKey(s);
      if (!poolCache.has(key)) {
        const po = await D.onlinePool(s ? [...s] : null);
        poolCache.set(key, po);
        log(`  · 在线题库池 ${desc(s)}：${po.total} 道 P 题`);
      }
      return poolCache.get(key);
    };
    log('逐题难度（按顺序对应每道题）：' + slots.map((s, i) => `第 ${i + 1} 题 ${desc(s)}`).join('；'));
    log('每题各自在线随机定位题号，抓到题面后以详情页 difficulty 复核；互不重复，且不改变题目顺序。');
    // 相同难度组合只在线读一次规模，先依次建池（单个池内多档并发）
    for (const s of slots) await getPool(s);
    const result = new Array(slots.length).fill(null);
    for (let i = 0; i < slots.length; i++) {
      const want = slots[i];
      const po = await getPool(want);
      let round = 0;
      while (!result[i] && round < 4) {
        const batch = await D.randomPoolPids(po, 3);
        log(`  · 第 ${i + 1} 题 · 第 ${round + 1} 轮在线定位 ${batch.pids.length} 道候选（${batch.pages} 页 / ${batch.ms}ms）`);
        for (const pid of batch.pids) {
          if (result[i]) break;
          const p = await attempt(pid, want);
          if (p) result[i] = take(p, i + 1);
        }
        round++;
      }
      if (!result[i]) {
        throw new Error(`第 ${i + 1} 题（需 ${desc(want)}）未能抽到可用中文题面，可放宽该题难度或改用 --pids`);
      }
    }
    return result;
  } else {
    // 默认：整卷统一难度范围，用洛谷自带筛选按全局序号等概率随机定位
    pool = await D.onlinePool(diffSet ? [...diffSet] : null);
    const scope = diffSet ? '难度 ' + desc(diffSet) : '全部难度';
    log(`洛谷在线 P 题库（type=P）：${scope} 共 ${pool.total} 道，完全随机抽 ${args.count} 道中文题面，题号全部实时来自洛谷。`);
    if (diffSet) log('抓到题面后会以详情页 difficulty 实时复核，确保难度准确。');
    let round = 0;
    while (chosen.length < args.count && round < 4) {
      const batch = await D.randomPoolPids(pool, args.count - chosen.length + 2);
      log(`  · 第 ${round + 1} 轮在线定位 ${batch.pids.length} 道候选（${batch.pages} 页 / ${batch.ms}ms）`);
      for (const pid of batch.pids) {
        if (chosen.length >= args.count) break;
        const p = await attempt(pid, diffSet);
        if (p) chosen.push(take(p));
      }
      round++;
    }
  }

  if (chosen.length < args.count) {
    throw new Error(`只凑到 ${chosen.length}/${args.count} 道可用中文题面` +
      (pool ? `（洛谷在线 P 题库 ${pool.total} 道，因难度/语言不符或抓取失败跳过 ${skippedByDiff} 道，可放宽难度范围或改用 --pids）`
        : '，请检查网络或换 --pids'));
  }
  return chosen;
}

function pdfParams(cfg) {
  const font = 'font-family:SimSun,Songti SC,serif;';
  return {
    landscape: false,
    displayHeaderFooter: true,
    printBackground: true,
    scale: 1,
    paperWidth: 8.27, paperHeight: 11.69,
    marginTop: 0.78, marginBottom: 0.72, marginLeft: 0.85, marginRight: 0.85,
    preferCSSPageSize: false,
    headerTemplate: `<div style="${font}font-size:9px;color:#666;width:100%;text-align:center;border-bottom:1px solid #ddd;padding-bottom:3px;">${cfg.paper.header}</div>`,
    footerTemplate: `<div style="${font}font-size:9px;color:#666;width:100%;text-align:center;">第 <span class="pageNumber"></span> 页 共 <span class="totalPages"></span> 页</div>`
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(fs.readFileSync(path.join(BASE, 'gen.js'), 'utf8').split('*/')[0]);
    return;
  }
  applyOverride(args.override);
  const outDir = args.out ? path.resolve(args.out) : path.join(BASE, config.outDir);
  const workDir = path.join(outDir, '.work');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const state = loadState();
  const paperNo = state.papers + 1;
  const now = new Date();
  log(`\n=== 洛谷题面模拟训练卷 · 第 ${paperNo} 套 ===`);
  log('抽取题面…');
  const problems = await pickProblems(args, state);

  const md = buildPaperMarkdown(problems, config, { date: dateCN(now), paperNo });
  const base = `${config.paper.title}_第${paperNo}套_${stamp(now)}`;
  const mdPath = path.join(outDir, base + '.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  log(`试卷 Markdown：${mdPath}（${(md.length / 1024).toFixed(1)} KB）`);

  let session;
  try {
    log('启动本机 Chrome 渲染引擎…');
    session = await C.launch(config.chrome);
    const htmlWork = await renderPaper(md, config, session, workDir, log);
    const htmlPath = path.join(outDir, base + '.html');
    fs.copyFileSync(htmlWork, htmlPath);
    log('  · 生成打印 HTML：' + htmlPath);

    // 图片已内嵌为 data URI；懒加载图片不在视口内时 complete 会一直为 false，
    // 因此只等文档就绪，再留一点时间给 KaTeX 字体与 base64 图片解码。
    await C.navigate(session.cdp, C.toFileUrl(htmlPath), 'document.readyState==="complete"', 30000);
    await C.sleep(1200);
    const paging = JSON.parse(await session.cdp.evaluate(
      'JSON.stringify({starts:document.querySelectorAll(".problem-start").length,' +
      'breaks:document.querySelectorAll(".page-break").length,' +
      'leftovers:(document.body.innerText.match(/\\[\\[PAGEBREAK\\]\\]/g)||[]).length})'));
    log(`  · 每题独立起页：${paging.starts} 处（备用硬分页 ${paging.breaks} 处，残留标记 ${paging.leftovers} 处）`);
    if (paging.starts < problems.length) {
      throw new Error(`分页标记不足：应为 ${problems.length} 处，实际 ${paging.starts} 处`);
    }

    const pdf = await C.printToPDF(session.cdp, pdfParams(config));
    const pdfPath = path.join(outDir, base + '.pdf');
    fs.writeFileSync(pdfPath, pdf);
    log(`\n✓ PDF 已生成：${pdfPath}（${(pdf.length / 1024).toFixed(0)} KB）`);

    state.papers = paperNo;
    state.used = [...new Set([...state.used, ...problems.map(p => p.pid)])];
    state.history.push({ no: paperNo, date: now.toISOString(), pids: problems.map(p => p.pid), pdf: pdfPath });
    saveState(state);
    log(`题目：${problems.map(p => p.pid + ' ' + p.name).join(' | ')}`);
    log(`提示：再次运行 node gen.js 会从洛谷在线 P 题库完全随机抽题（已记录 ${state.used.length} 道历史题号，仅作参考）。`);
    // 供本地网页控制台解析的机器可读结果行（不影响命令行阅读）
    log('LGPDF_RESULT=' + JSON.stringify({
      no: paperNo, pdf: pdfPath, html: htmlPath, md: mdPath,
      pids: problems.map(p => p.pid), names: problems.map(p => p.name)
    }));
  } finally {
    if (session) await C.shutdown(session);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('\n生成失败：' + e.stack); process.exit(1); });
}
// 便于测试脚本单独验证抽题/难度筛选链路，不会触发 PDF 生成或写 state.json
module.exports = { parseArgs, parseDifficulty, parsePerDifficulty, pickProblems, config };
