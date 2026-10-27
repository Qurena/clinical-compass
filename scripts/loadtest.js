// Простой нагрузочный тест: N одновременных пользователей-врачей открывают список и карточку.
// Запуск: PORT=3100 node scripts/loadtest.js [параллельных=50] [запросов на пользователя=20]
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const users = Number(process.argv[2]) || 50;
const reqs = Number(process.argv[3]) || 20;

async function login() {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ login: 'doctor', password: 'demo' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const times = [];
let errors = 0;
async function worker(sid) {
  for (let i = 0; i < reqs; i++) {
    const path = i % 2 ? '/api/doctor/patients/5' : '/api/doctor/patients';
    const t = performance.now();
    try {
      const r = await fetch(base + path, { headers: { cookie: sid } });
      await r.arrayBuffer();
      if (!r.ok) errors++;
    } catch { errors++; }
    times.push(performance.now() - t);
  }
}
const sid = await login();
const t0 = performance.now();
await Promise.all(Array.from({ length: users }, () => worker(sid)));
const total = performance.now() - t0;
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1);
console.log(`Параллельных пользователей: ${users}, запросов: ${times.length}, ошибок: ${errors}`);
console.log(`p50 ${q(0.5)} мс · p95 ${q(0.95)} мс · max ${times[times.length - 1].toFixed(1)} мс · ${(times.length / (total / 1000)).toFixed(0)} запросов/с`);
