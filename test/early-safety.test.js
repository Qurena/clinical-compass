import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { scoreSppvr, evaluateReferral } from '../src/engine.js';

test('демо-ответы о тревоге не активируют пороги HADS-A', () => {
  const answers = [0,0,0,0,0,0,0,0,0,3,3,3,0,3,3,3,1,0,0,3];
  const scored = scoreSppvr(answers, { elapsed_sec: 220 });
  assert.equal(scored.hads_a, null);
  const ctx = { profile:{conditions:[],exam:{},treatment:{}}, scales:{phq9:[],gad7:[]}, sppvrList:[{...scored,ts:Date.now()}], activeRx:null };
  const ref = evaluateReferral(ctx);
  assert.ok(!ref.reasons.some((reason) => /HADS-A/.test(reason.basis || '')));
});

test('пункт 9: частичный ответ сохраняется, сигнал виден врачу, повтор не создаёт дубликат', async () => {
  const { server, db } = createApp(':memory:');
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (name) => {
    const r = await fetch(base + '/api/login', { method:'POST', body:JSON.stringify({login:name,password:'demo'}) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, method, path, body) => {
    const r = await fetch(base + path,{method,headers:{cookie},body:body && JSON.stringify(body)});
    return {status:r.status, body:await r.json()};
  };
  try {
    const [p,d] = await Promise.all([login('anna'),login('doctor')]);
    const before = (await call(p,'GET','/api/patient/home')).body;
    const list = (await call(d,'GET','/api/doctor/patients')).body;
    const pid = list.find(x => x.name.includes('Соколова')).id;
    const controller = new AbortController();
    const stream = await fetch(base + '/api/doctor/stream', {headers:{cookie:d},signal:controller.signal});
    const reader = stream.body.getReader();
    await reader.read();
    const event = reader.read().then((r) => new TextDecoder().decode(r.value));
    const answers = [1,null,1,0,1,1,1,0,2,...Array(11).fill(null)];
    const input = {token:'early-safety-test-0001',answers,item_sec:Array(20).fill(null),elapsed_sec:22};
    assert.equal((await call(p,'POST','/api/patient/sppvr/early-safety',{...input,answers:[...answers.slice(0,8),0,...answers.slice(9)]})).status,400);
    const first = await call(p,'POST','/api/patient/sppvr/early-safety',input);
    assert.equal(first.status,200); assert.equal(first.body.safety_question,true);
    const frame = await Promise.race([event,new Promise(r=>setTimeout(()=>r('timeout'),1000))]);
    assert.match(frame, /"type":"alert"/); assert.match(frame, /"severity":"red"/);
    assert.equal((await call(p,'POST','/api/patient/sppvr/early-safety',input)).status,200);
    assert.equal((await call(p,'POST','/api/patient/sppvr/early-safety',{...input,answers:[0,...answers.slice(1)]})).status,400);
    const after = (await call(p,'GET','/api/patient/home')).body;
    assert.equal(after.sppvr.early_pending,true);
    assert.equal(after.sppvr.history.length,before.sppvr.history.length);
    assert.equal(after.game.points,before.game.points);
    const card = (await call(d,'GET',`/api/doctor/patients/${pid}`)).body;
    assert.equal(card.sppvr[0].partial,true);
    assert.deepEqual(card.sppvr[0].answers,answers);
    assert.ok(card.alerts.some(a=>a.severity==='red'));
    assert.equal(db.prepare("SELECT count(*) c FROM sppvr_results WHERE patient_id=? AND json_extract(extra,'$.early_token')=?").get(pid,input.token).c,1);
    assert.equal((await call(p,'POST','/api/patient/sppvr/clinical',{safety:'wrong'})).status,400);
    assert.equal((await call(p,'POST','/api/patient/sppvr/clinical',{safety:'thoughts_only'})).status,200);
    const completed = (await call(p,'GET','/api/patient/home')).body;
    // Клинический ответ сохраняется вместе с частичной анкетой.
    assert.equal(completed.sppvr.early_pending,false);
    controller.abort();
  } finally {
    server.closeAllConnections(); await new Promise(r=>server.close(r)); db.close();
  }
});
