// Замеры для презентации: сквозное время доставки красного алерта врачу (HTTP + SSE),
// время формирования карточки с рекомендацией и быстродействие приёма шкалы.
// Запуск: npm run measure
import { createApp } from '../server.js';

const { server, svc } = createApp(':memory:');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

async function login(l) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ login: l, password: 'demo' }) });
  const sid = r.headers.get('set-cookie').split(';')[0];
  return { sid, call: (m, p, b) => fetch(base + p, { method: m, headers: { cookie: sid }, body: b ? JSON.stringify(b) : undefined }).then((x) => x.json()) };
}
const doctor = await login('doctor');
const daria = await login('daria');
// 20 ответов: PHQ-9 с пунктом 9 > 0, HADS-A, проверка внимания, три повторных
const CASE3 = [2, 3, 3, 3, 2, 3, 2, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 1];

// doctor SSE-поток
const events = [];
let waiter = null;
const res = await fetch(`${base}/api/doctor/stream`, { headers: { cookie: doctor.sid } });
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      if (frame.startsWith('data: ')) {
        const ev = JSON.parse(frame.slice(6));
        if (ev.type === 'alert' && ev.alert.severity === 'red' && waiter) { const w = waiter; waiter = null; w(performance.now()); }
        events.push(ev);
      }
    }
  }
})();
await new Promise((r) => setTimeout(r, 300));

const e2e = [];
const N = 40;
for (let i = 0; i < N; i++) {
  const got = new Promise((r) => { waiter = r; });
  const t0 = performance.now();
  await daria.call('POST', '/api/patient/sppvr', { answers: CASE3, elapsed_sec: 190, item_sec: Array(20).fill(9.5) });
  const t1 = await got;
  e2e.push(t1 - t0);
  // врач подтверждает, чтобы следующий алерт не считался дублем
  const list = await doctor.call('GET', '/api/doctor/patients');
  for (const a of list.find((p) => p.name.includes('Орлова')).open_alerts) await doctor.call('POST', `/api/doctor/alerts/${a.id}/ack`, { note: 'замер' });
}
const q = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const r1 = (x) => Math.round(x * 10) / 10;
console.log(`Сквозная доставка красного алерта (отправка СППВР пациентом → событие у врача), n=${N}: p50 ${r1(q(e2e, 0.5))} мс, p95 ${r1(q(e2e, 0.95))} мс, max ${r1(Math.max(...e2e))} мс`);

const card = [];
for (let i = 0; i < 100; i++) { const t = performance.now(); await doctor.call('GET', '/api/doctor/patients/5'); card.push(performance.now() - t); }
console.log(`Открытие карточки пациента с рекомендацией (HTTP), n=100: p50 ${r1(q(card, 0.5))} мс, p95 ${r1(q(card, 0.95))} мс`);
const m = svc.metrics();
console.log('Серверные замеры:', JSON.stringify({ recommendation: m.recommendation, alert_delivery: m.alert_delivery, scale_submit: m.scale_submit }));
process.exit(0);
