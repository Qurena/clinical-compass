import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { doctorSummaryHTML } from '../public/doctor-summary.js';

test('сводка без истории и сообщений не выдумывает данные', () => {
  const html = doctorSummaryHTML({summary:null,visits:[],diary:[],messages:[],recommendation:{drug:{gaps:[]}}});
  assert.match(html, /недостаточно данных/);
  assert.match(html, /Новых сообщений нет/);
  assert.doesNotMatch(html, /PHQ-9.*\d+\/27/);
});
test('сводка экранирует сообщение пациента и показывает фактические пробелы', () => {
  const html=doctorSummaryHTML({summary:{since_ts:10,prev_ts:20,cur_ts:30,items:[],scores:{phq9:{from:8,to:6}}},visits:[],diary:[],messages:[{from_role:'patient',ts:40,text:'<script>тест</script>'}],recommendation:{drug:{gaps:['лекарства не сверены']}}});
  assert.match(html,/лекарства не сверены/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/8\/27/); assert.match(html,/6\/27/);
});

test('Анна: сохранение, SSE, повтор запроса и обновлённая сводка врача', async () => {
  const { server, db } = createApp(':memory:');
  await new Promise((r)=>server.listen(0,r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=async name=>{const r=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({login:name,password:'demo'})});return r.headers.get('set-cookie').split(';')[0];};
  const call=async(cookie,method,path,body)=>{const r=await fetch(base+path,{method,headers:{cookie},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const controller=new AbortController();
  try {
    const [p,d]=await Promise.all([login('anna'),login('doctor')]);
    const list=(await call(d,'GET','/api/doctor/patients')).body;
    const row=list.find(x=>x.name.includes('Соколова'));
    const before=(await call(p,'GET','/api/patient/home')).body;
    assert.equal(before.sppvr.history.length,2);
    const initial=(await call(d,'GET',`/api/doctor/patients/${row.id}`)).body;
    const summary=doctorSummaryHTML(initial);
    assert.match(summary,/хуже сплю/);
    assert.match(summary,/сон 5 ч/);
    assert.match(summary,/PHQ-9/);
    const stream=await fetch(base+'/api/doctor/stream',{headers:{cookie:d},signal:controller.signal});
    const reader=stream.body.getReader(); await reader.read();
    const observed=reader.read().then(x=>new TextDecoder().decode(x.value));
    const answers=[1,1,1,0,1,1,1,0,0,2,2,2,1,2,2,1,1,1,1,2];
    const input={answers,submission_token:'test-full-submit-00001',elapsed_sec:200};
    const first=await call(p,'POST','/api/patient/sppvr',input);
    assert.equal(first.status,200); assert.equal(first.body.ok,true);
    const frame=await Promise.race([observed,new Promise(r=>setTimeout(()=>r('timeout'),1000))]);
    assert.match(frame,/"type":"result"/);
    const replay=await call(p,'POST','/api/patient/sppvr',input);
    assert.deepEqual(replay,first);
    assert.equal((await call(p,'GET','/api/patient/home')).body.sppvr.history.length,3);
    assert.equal((await call(p,'POST','/api/patient/sppvr',{...input,answers:[0,...answers.slice(1)]})).status,400);
    const latest=(await call(d,'GET',`/api/doctor/patients/${row.id}`)).body;
    assert.deepEqual(latest.sppvr[0].answers,answers);
    assert.equal(latest.sppvr[0].phq9,6);
    assert.equal(latest.summary.cur_ts,latest.sppvr[0].ts);
    assert.equal(db.prepare("SELECT count(*) c FROM sppvr_results WHERE patient_id=? AND json_extract(extra,'$.submission_token')=?").get(row.id,input.submission_token).c,1);
    assert.equal((await call(d,'POST',`/api/doctor/patients/${row.id}/advice`,{action:'dismiss',reason:'Обсудить на приёме'})).status,200);
    await call(p,'POST','/api/patient/sos',{});
    const withExistingAlert=await call(p,'POST','/api/patient/sppvr',{...input,submission_token:'test-full-submit-00002'});
    assert.equal(withExistingAlert.body.alert,true);
  } finally {
    controller.abort(); server.closeAllConnections(); await new Promise(r=>server.close(r)); db.close();
  }
});
