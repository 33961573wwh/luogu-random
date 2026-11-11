'use strict';
/* 调试用：把生成好的打印 HTML 截几屏图，便于目视检查版式。
 * 用法: node preview.js out/xxx.html [_ref/shots] */
const fs = require('fs');
const path = require('path');
const C = require('./lib/chrome');

(async () => {
  const html = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3] || '_ref/shots');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const s = await C.launch(cfg.chrome);
  try {
    await C.navigate(s.cdp, C.toFileUrl(html), 'document.readyState==="complete"', 25000);
    await C.sleep(900);
    const info = await s.cdp.evaluate(`JSON.stringify({
      height: document.body.scrollHeight,
      tables: document.querySelectorAll('table').length,
      rowspan: document.querySelectorAll('[rowspan]').length,
      colspan: document.querySelectorAll('[colspan]').length,
      cute: document.querySelectorAll('.lg-cute').length,
      folds: document.querySelectorAll('details').length,
      linenum: document.querySelectorAll('.lg-hasinum').length,
      katex: document.querySelectorAll('.katex').length,
      breaks: document.querySelectorAll('.page-break').length,
      images: document.querySelectorAll('img').length
    })`);
    console.log('DOM:', info);
    const positions = [0, 1500, 4200];
    for (let i = 0; i < positions.length; i++) {
      await s.cdp.evaluate(`window.scrollTo(0, ${positions[i]})`);
      await C.sleep(250);
      const r = await s.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const f = path.join(outDir, `shot${i + 1}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('saved', f);
    }
  } finally {
    await C.shutdown(s);
  }
})().catch(e => { console.error(e); process.exit(1); });
