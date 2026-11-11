#!/usr/bin/env node
'use strict';
/* 在线读取洛谷 P 题库规模与各难度档题目数（纯在线，不读取任何本地题单）。
 *   node sync-difficulty.js               打印 P 题库难度分布
 *   node sync-difficulty.js --json FILE   额外把本次在线报告写到用户指定的文件
 *
 * 生成器本身不需要运行本脚本：抽题时直接实时访问洛谷在线 P 题库。
 */
const fs = require('fs');
const path = require('path');
const D = require('./lib/difficulty');

D.onlinePoolCounts().then(r => {
  console.log(`洛谷在线 P 题库（type=P）共 ${r.total} 道，实时读取时间 ${r.updatedAt}`);
  for (const lv of D.LEVELS) {
    console.log(`  ${lv.value} · ${lv.label}：${r.levels[lv.value] || 0} 道`);
  }
  const report = { ...r, levels: r.levels };
  const ji = process.argv.indexOf('--json');
  if (ji >= 0 && process.argv[ji + 1]) {
    const out = path.resolve(process.argv[ji + 1]);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('报告已写入：' + out);
  } else {
    console.log('本次结果未写入任何缓存文件；项目内不存在本地题库。');
  }
}).catch(e => { console.error('在线读取失败：' + e.stack); process.exit(1); });
