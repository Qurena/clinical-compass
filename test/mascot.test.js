import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createApp} from '../server.js';
import {POSES, SIZES, poseOf, srcOf, sheepHTML} from '../public/mascot/sheep.js';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('овечка: известные позы сохраняются, неизвестные безопасно заменяются', () => {
  assert.deepEqual([...POSES].sort(), ['care', 'cheer', 'happy', 'wave']);
  for (const p of POSES) assert.equal(poseOf(p), p);
  for (const p of ['unknown', '__proto__', 'constructor', 'toString', null, undefined, 5]) assert.equal(poseOf(p), 'wave');
});

test('овечка: разметка — picture с WebP 1x/2x и PNG-запасом, класс размера фильтруется', () => {
  const h = sheepHTML('happy', 'lg');
  assert.match(h, /<picture>/); assert.match(h, /type="image\/webp"/);
  assert.match(h, /happy-sm\.webp\?v=\d+ 1x, \/mascot\/sheep\/happy-sm@2x\.webp\?v=\d+ 2x/);
  assert.match(h, /<img src="\/mascot\/sheep\/happy-sm\.png/);
  assert.match(h, /class="sheep lg"/); assert.match(h, /alt=""/); assert.match(h, /aria-label="Добрая овечка"/);
  assert.doesNotMatch(sheepHTML('wave', '"><script>'), /script/);
  assert.equal(srcOf('nope', 'png'), '/mascot/sheep/wave-sm.png?v=1');
});

test('овечка: care — спокойная поза без анимации (data-calm), остальные покачиваются', async () => {
  assert.match(sheepHTML('care', 'lg'), /data-calm/);
  for (const p of ['wave', 'happy', 'cheer']) assert.doesNotMatch(sheepHTML(p), /data-calm/);
  const css = await read('../public/mascot/sheep.css');
  assert.match(css, /\.sheep\[data-calm\] img \{ animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\.sheep img \{ animation: none/);
  assert.doesNotMatch(css, /translateY|bounce|jump/i);
});

test('овечка: app.js сохраняет MASCOT(pose, cls), нет остатков 3D и cloud-lamb', async () => {
  const app = await read('../public/app.js'), html = await read('../public/index.html');
  assert.match(app, /const MASCOT = \(pose, cls = ''\) => sheepHTML\(pose, cls\)/);
  assert.doesNotMatch(app, /cloud-lamb|lamb-|three|\.glb|Облачко/i);
  assert.match(html, /\/mascot\/sheep\.css/);
  const files = await readdir(new URL('../public/mascot/', import.meta.url));
  assert.deepEqual(files.sort(), ['sheep', 'sheep.css', 'sheep.js']);
});

test('овечка: спрайты поз и index.json согласованы с SIZES', async () => {
  const files = new Set(await readdir(new URL('../public/mascot/sheep/', import.meta.url)));
  const idx = JSON.parse(await read('../public/mascot/sheep/index.json'));
  for (const p of POSES) {
    for (const f of [`${p}-sm.webp`, `${p}-sm@2x.webp`, `${p}-sm.png`, `${p}-sm@2x.png`]) assert.ok(files.has(f), f);
    assert.ok(idx.sprites[p], p);
    const png = Buffer.from(await readFile(new URL(`../public/mascot/sheep/${p}-sm.png`, import.meta.url)));
    assert.equal(png.readUInt32BE(0), 0x89504E47); assert.equal(png[25], 6); // RGBA
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], SIZES[p]);
  }
});

const {server} = createApp(':memory:'); await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
test('овечка: сервер отдаёт WebP, PNG, JS и CSS с корректными типами', async () => {
  for (const p of POSES) {
    const w = await fetch(base + `/mascot/sheep/${p}-sm.webp`); assert.equal(w.status, 200); assert.equal(w.headers.get('content-type'), 'image/webp');
    const b = Buffer.from(await w.arrayBuffer()); assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.toString('ascii', 8, 12), 'WEBP');
    const r = await fetch(base + `/mascot/sheep/${p}-sm@2x.png`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  }
  assert.match((await fetch(base + '/mascot/sheep.js')).headers.get('content-type'), /javascript/);
  assert.match((await fetch(base + '/mascot/sheep.css')).headers.get('content-type'), /text\/css/);
  assert.equal((await fetch(base + '/mascot/cloud_lamb_blue.glb')).status, 404);
});
