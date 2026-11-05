import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// パスはこのファイルの位置から求める（環境ごとの絶対パスを書かない）
const HTML = new URL('../image-compressor.html', import.meta.url).href;
const OUT = fileURLToPath(new URL('./output/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('pageerror:', e.message));

// テスト画像をブラウザのCanvasで生成（写真調とスクショ調）
await page.goto('about:blank');
const imgs = await page.evaluate(async () => {
  async function make(w, h, kind, type) {
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    if (kind === 'photo') {
      const d = g.createImageData(w, h);
      for (let i = 0; i < d.data.length; i += 4) { const p = i / 4, x = p % w, y = (p / w) | 0;
        d.data[i] = (x * 255 / w + Math.random() * 40) | 0; d.data[i + 1] = (y * 255 / h + Math.random() * 40) | 0; d.data[i + 2] = (Math.random() * 255) | 0; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
    } else {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#1f5bd6'; g.fillRect(20, 20, w / 2, 60);
      g.fillStyle = '#222'; g.font = '28px sans-serif'; g.fillText('screenshot sample', 30, 160);
    }
    const b = await c.convertToBlob({ type, quality: 0.95 });
    const u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const v of u8) s += String.fromCharCode(v);
    return btoa(s);
  }
  return {
    a: await make(1600, 1200, 'photo', 'image/jpeg'),
    b: await make(800, 400, 'shot', 'image/png'),
    c: await make(1200, 900, 'photo', 'image/png'),
  };
});
const files = [
  { name: '20261105.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgs.a, 'base64') },
  { name: '20261106.png', mimeType: 'image/png', buffer: Buffer.from(imgs.b, 'base64') },
  { name: '20261105.png', mimeType: 'image/png', buffer: Buffer.from(imgs.c, 'base64') }, // 同名ベース→連番
];

await page.goto(HTML);
await page.locator('#fileInput').setInputFiles(files);
await page.waitForFunction(() => window.__imgTool.items().length === 3 && !window.__imgTool.isRunning(), null, { timeout: 120000 });

// CSVボタンは処理完了後に有効
assert.equal(await page.locator('#saveCsv').isDisabled(), false);

// プレフィックス入力
await page.locator('#csvPrefix').fill('img/');
const names = await page.evaluate(() => window.__imgTool.outputs().map(o => o.name));
const lines = await page.evaluate(() => window.__imgTool.csvLines());
assert.deepEqual(lines, names.map(n => 'img/' + n));
assert.equal(await page.locator('#csvEg').textContent(), '→ img/' + names[0]);

// ダウンロードされたCSVの中身
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#saveCsv').click()]);
assert.match(dl.suggestedFilename(), /^filenames-\d{8}-\d{4}\.csv$/);
const csvPath = OUT + 'out.csv';
await dl.saveAs(csvPath);
const raw = fs.readFileSync(csvPath, 'utf8');
assert.ok(raw.startsWith('﻿'), 'BOMあり');
assert.equal(raw, '﻿' + names.map(n => 'img/' + n).join('\r\n') + '\r\n');
console.log('CSV:\n' + raw.slice(1));

// プレフィックスはリロード後も残る
await page.reload();
assert.equal(await page.locator('#csvPrefix').inputValue(), 'img/');

// カンマ・引用符を含むプレフィックスはCSVとして正しくクォートされる
await page.locator('#fileInput').setInputFiles(files.slice(0, 1));
await page.waitForFunction(() => window.__imgTool.items().length === 1 && !window.__imgTool.isRunning(), null, { timeout: 120000 });
await page.locator('#csvPrefix').fill('a,"b"/');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#saveCsv').click()]);
await dl2.saveAs(OUT + 'out2.csv');
assert.equal(fs.readFileSync(OUT + 'out2.csv', 'utf8'), '﻿"a,""b""/20261105.jpg"\r\n');

// スクショ用に3件の状態へ戻す
await page.locator('#csvPrefix').fill('img/');
await page.reload();
await page.locator('#fileInput').setInputFiles(files);
await page.waitForFunction(() => window.__imgTool.items().length === 3 && !window.__imgTool.isRunning(), null, { timeout: 120000 });
await page.waitForTimeout(3500); // トーストが消えるのを待つ
await page.screenshot({ path: OUT + 'desktop.png' });

// スマホ幅
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + 'mobile.png' });
// ページ全体の横はみ出しは既存の設定パネル由来のため、追加した保存バー内だけを確認
const overflow = await page.evaluate(() => [...document.querySelectorAll('#savebar *')].some(e => e.getBoundingClientRect().right > innerWidth + 1));
assert.equal(overflow, false, '保存バーが画面幅に収まる');

console.log('ALL PASSED');
await browser.close();
