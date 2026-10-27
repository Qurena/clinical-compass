import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

// Раздача статики: каталоги и выход за public не должны давать 500 или отдавать исходники сервера.
const { server } = createApp(':memory:');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('статика: главная и скрипты отдаются с верным типом', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('статика: каталог вместо файла даёт 404, а не 500', async () => {
  for (const p of ['/mascot', '/mascot/sheep', '/mascot/']) assert.equal((await fetch(base + p)).status, 404, p);
});

test('статика: выход за public не отдаёт исходники', async () => {
  const r = await fetch(base + '/..%2fserver.js');
  assert.ok([403, 404].includes(r.status));
  const r2 = await fetch(base + '/../package.json');
  assert.ok([403, 404].includes(r2.status) || !(await r2.text()).includes('"clinical-compass"'));
});
