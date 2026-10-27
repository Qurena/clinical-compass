import test from 'node:test';
import assert from 'node:assert/strict';
import { patientMetricsHTML, shouldShowMetrics } from '../public/patient-metrics.js';
import { createApp } from '../server.js';
import { hashPassword } from '../src/db.js';
import { SCALES } from '../src/engine.js';

test('PHQ-9: первый вопрос включает интерес и удовольствие', () => {
  assert.match(SCALES.phq9.items[0], /интерес/);
  assert.match(SCALES.phq9.items[0], /удовольств/);
});

test('метрики: PHQ-9, нулевой балл и первая точка', () => {
  const html = patientMetricsHTML([{ ts: Date.UTC(2026, 9, 26), phq9: 0, hads_a: 13 }]);
  assert.match(html, /PHQ-9/); assert.match(html, /ответы о тревоге/); assert.doesNotMatch(html, /HADS-A/);
  assert.match(html, /0 из 27/); assert.doesNotMatch(html, /13 из 21/);
  assert.match(html, /Первая точка/);
  assert.doesNotMatch(html, /ИКСО|диагноз|тяжест|риск|суицид|достоверност/i);
});
test('метрики: история и пропуск без подстановки нуля', () => {
  const html = patientMetricsHTML([{ts: 100000000, phq9: 6, hads_a: 13}, {ts: 200000000, phq9: null, hads_a: 8}]);
  assert.match(html, /Первая точка/); assert.match(html, /нет суммы/);
  assert.match(html, /6 из 27/); assert.doesNotMatch(html, /8 из 21/);
  assert.doesNotMatch(html, /Последний ответ: 0 из 27/);
});
test('экран безопасности: нет метрик при alert, C7 или активном сигнале', () => {
  assert.equal(shouldShowMetrics({alert:false, safety_question:false}, null), true);
  assert.equal(shouldShowMetrics({alert:true}, null), false);
  assert.equal(shouldShowMetrics({safety_question:true}, null), false);
  assert.equal(shouldShowMetrics({}, {status:'delivered'}), false);
  assert.equal(shouldShowMetrics(null, null), false);
});
test('данные графиков берутся из ответов, неполные суммы не показываются', async () => {
  const {server, db} = createApp(':memory:'); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({login:'anna',password:'demo'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = () => fetch(base+'/api/patient/home',{headers:{cookie}}).then(r=>r.json());
    const post = (answers) => fetch(base+'/api/patient/sppvr',{method:'POST',headers:{cookie},body:JSON.stringify({answers})});
    const answers = [1,1,1,0,1,1,1,0,0,2,2,2,1,2,2,1,1,1,1,2];
    assert.equal((await get()).sppvr.history.length, 2);
    assert.equal((await post(answers)).status,200);
    let history = (await get()).sppvr.history;
    assert.equal(history.at(-1).phq9, 6);
    assert.deepEqual(Object.keys(history.at(-1)).sort(), ['phq9','ts']);
    answers[0]=null;
    assert.equal((await post(answers)).status,200);
    history=(await get()).sppvr.history;
    assert.equal(history.at(-1).phq9,null);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); db.close(); }
});
test('CT12: свой врач видит обновление, чужой не видит карточку и не получает SSE', async () => {
  const {server, db} = createApp(':memory:');
  const pw=hashPassword('demo');
  db.prepare("INSERT INTO users(role,login,name,specialty,salt,hash) VALUES ('doctor',?,?,?,?,?)").run('doctor2','Тестовый врач','врач',pw.salt,pw.hash);
  await new Promise(r=>server.listen(0,r)); const base=`http://127.0.0.1:${server.address().port}`;
  const login=async name=>{const r=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({login:name,password:'demo'})}); return r.headers.get('set-cookie').split(';')[0];};
  const get=(cookie,path)=>fetch(base+path,{headers:{cookie}});
  try {
    const [own,other,patient]=await Promise.all(['doctor','doctor2','anna'].map(login));
    const list=await (await get(own,'/api/doctor/patients')).json(); const anna=list.find(x=>x.name.includes('Соколова'));
    const controller = new AbortController();
    const stream = await fetch(base+'/api/doctor/stream',{headers:{cookie:other},signal:controller.signal});
    const reader=stream.body.getReader(); await reader.read();
    const pending=reader.read().then(x=>x.value ? new TextDecoder().decode(x.value) : '').catch(()=> '');
    const answers=[1,1,1,0,1,1,1,0,0,2,2,2,1,2,2,1,1,1,1,2];
    await fetch(base+'/api/patient/sppvr',{method:'POST',headers:{cookie:patient},body:JSON.stringify({answers})});
    const card=await (await get(own,`/api/doctor/patients/${anna.id}`)).json();
    assert.equal(card.sppvr[0].phq9,6);
    assert.equal((await get(other,`/api/doctor/patients/${anna.id}`)).status,404);
    assert.deepEqual(await (await get(other,'/api/doctor/patients')).json(),[]);
    assert.equal(await Promise.race([pending,new Promise(r=>setTimeout(()=>r('no-event'),200))]),'no-event');
    controller.abort();
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); db.close(); }
});
