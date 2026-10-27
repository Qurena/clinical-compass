import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { verifyAudit } from '../src/db.js';

process.env.LOGIN_LIMIT = '1000';

// Интеграционные тесты: роли, связь врач–пациент, три клинических случая, алерты трёх цветов, блокировки, журнал.
const { server, svc, db } = createApp(':memory:');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const mk = (phq, hads, anchors = null) => [...phq, ...hads.map((v, i) => (i === 3 ? 3 - v : v)), 1, ...(anchors || [phq[2], phq[6], hads[0]])];
const SEC = Array(20).fill(12);
const CASE1 = mk([1, 1, 1, 0, 1, 1, 1, 0, 0], [2, 2, 2, 2, 2, 2, 1]);   // PHQ-9 6, HADS-A 13
const RISK = mk([2, 3, 3, 3, 2, 3, 2, 3, 2], [1, 1, 1, 1, 1, 1, 1]);   // пункт 9 = 2

async function login(l) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ login: l, password: 'demo' }) });
  assert.equal(r.status, 200);
  const sid = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const x = await fetch(base + path, { method, headers: { cookie: sid }, body: body ? JSON.stringify(body) : undefined });
    return { status: x.status, body: await x.json() };
  };
}
const find = async (d, part) => (await d('GET', '/api/doctor/patients')).body.find((x) => x.name.includes(part));
const fill = async (p, answers, sec = 240) => p('POST', '/api/patient/sppvr', { answers, elapsed_sec: sec, item_sec: SEC });

test('без входа API закрыт, неверный пароль отклоняется', async () => {
  assert.equal((await fetch(`${base}/api/doctor/patients`)).status, 401);
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ login: 'doctor', password: 'x' }) });
  assert.equal(r.status, 401);
});

test('роли разделены: пациент без доступа к функциям врача и наоборот', async () => {
  const p = await login('anna');
  assert.equal((await p('GET', '/api/doctor/patients')).status, 403);
  const d = await login('doctor');
  assert.equal((await d('GET', '/api/patient/home')).status, 403);
});

test('врач видит пять пациентов; опросник отдаётся с 20 вопросами без ключей проверки', async () => {
  const d = await login('doctor');
  const list = (await d('GET', '/api/doctor/patients')).body;
  assert.equal(list.length, 5);
  assert.equal(list.find((x) => x.name.includes('Волков')).source, 'Направлен неврологом');
  const p = await login('anna');
  const s = (await p('GET', '/api/scales')).body;
  assert.equal(s.sppvr.questions.length, 20);
  assert.ok(s.sppvr.questions.every((q) => !('correct' in q) && !('pair' in q)));
  assert.ok(!('anchors' in s.sppvr) && !('quality' in s.sppvr));
});

test('старый формат (16 ответов) и недопустимые значения отклоняются', async () => {
  const p = await login('anna');
  assert.equal((await p('POST', '/api/patient/sppvr', { answers: Array(16).fill(1) })).status, 400);
  const bad = [...CASE1]; bad[0] = 7;
  assert.equal((await p('POST', '/api/patient/sppvr', { answers: bad })).status, 400);
});

test('случай 1: Анна заполняет опросник, врач видит PHQ-9 и ответы о тревоге', async () => {
  const p = await login('anna');
  const r = (await fill(p, CASE1)).body;
  assert.equal(r.ok, true); assert.equal(r.alert, false); assert.equal(r.safety_question, false);
  const d = await login('doctor');
  const row = await find(d, 'Соколова');
  assert.equal(row.sppvr.phq9, 6); assert.equal(row.sppvr.hads_a, null);
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.sppvr[0].quality.score, 100);
  assert.ok(!card.alerts.some((a) => a.severity === 'red'));
  assert.ok(!('anx_eq' in card.sppvr[0]));
  // диагноза нет: рекомендации по Авиандру нет
  assert.notEqual(card.recommendation.advice.state, 'consider');
});

test('клинический блок: «не знаю» сохраняется как неизвестное, статус по лекарствам серый, назначение требует обоснования', async () => {
  const p = await login('igor');
  await fill(p, CASE1);
  const c = await p('POST', '/api/patient/sppvr/clinical', { duration: 'gt6m', functioning: 2, meds_status: 'dont_know_name', meds: [{ name: '', purpose: 'для сна' }], mania: 'no', adverse: 'no', somatic_hx: ['none'], alcohol: 'rare', substances: 'no', nicotine: 'no', organ: ['none'] });
  assert.equal(c.status, 200);
  const d = await login('doctor');
  const row = await find(d, 'Волков');
  await d('POST', `/api/doctor/patients/${row.id}/exam`, { dx: 'F41_1' });
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.clinical.derived.unknown_data, true);
  assert.equal(card.recommendation.drug.ddi_level, 'grey');
  assert.equal(card.recommendation.advice.state, 'grey');
  assert.equal(card.alerts.filter((a) => a.rule_id === 'sppvr_unknown_data').length >= 1, true);
  const rx = await d('POST', `/api/doctor/patients/${row.id}/prescribe`, { ddi_ack: true });
  assert.equal(rx.status, 409);
  assert.equal(rx.body.error, 'override_required');
});

test('случай 1 для врача: диагноз и сверка лекарств → «рассмотреть Авиандр», назначение подтверждается без обхода', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Соколова');
  await d('POST', `/api/doctor/patients/${row.id}/exam`, { dx: 'F41_1', meds_reconciled: true });
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.recommendation.advice.state, 'consider');
  const rx = await d('POST', `/api/doctor/patients/${row.id}/prescribe`, { ddi_ack: true });
  assert.equal(rx.status, 200);
  const after = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(after.recommendation.has_active, true);
});

test('сигнал безопасности: пункт 9 > 0, уточнение C7, красный алерт без блокировок, статусы алерта до действия', async () => {
  const p = await login('daria');
  const r = (await fill(p, RISK)).body;
  assert.equal(r.safety_question, true);
  assert.equal(r.alert, true);
  const c = await p('POST', '/api/patient/sppvr/clinical', { safety: 'intent_or_plan' });
  assert.equal(c.status, 200);
  const home = (await p('GET', '/api/patient/home')).body;
  assert.ok(home.safety);
  assert.ok(home.safety.emergency.phone);
  const d = await login('doctor');
  const row = await find(d, 'Орлова');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  const reds = card.alerts.filter((a) => a.severity === 'red');
  assert.ok(reds.length >= 1);
  assert.ok(reds.every((a) => !JSON.parse(a.actions).some((x) => x.startsWith('block_'))), 'алерт ничего не блокирует автоматически');
  assert.equal(card.referral.level, 'urgent');
  assert.equal(card.recommendation.prescribe_blocked, null);
  const a = reds[0];
  assert.ok(a.created_ts && a.delivered_ts);
  const card2 = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.ok(card2.alerts.find((x) => x.id === a.id).read_ts, 'открыт при просмотре карточки');
  const ack = await d('POST', `/api/doctor/alerts/${a.id}/ack`, { note: 'позвонила пациентке' });
  assert.equal(ack.status, 200);
  const card3 = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  const done = card3.alerts.find((x) => x.id === a.id);
  assert.ok(done.ack_ts); assert.ok(done.action_ts);
});

test('оценка показаний к госпитализации: недобровольная форма требует основания ст. 29', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Орлова');
  const bad = await d('POST', `/api/doctor/patients/${row.id}/protocol`, { consent: 'involuntary' });
  assert.equal(bad.status, 409);
  const ok = await d('POST', `/api/doctor/patients/${row.id}/protocol`, { consent: 'voluntary', comment: 'согласие получено' });
  assert.equal(ok.status, 200);
});

test('случай 3: Павел, соматический маршрут, Авиандр автоматически не рекомендуется', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Беляев');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.sppvr[0].phq9, 17);
  assert.equal(card.sppvr[0].hads_a, null);
  assert.notEqual(card.recommendation.advice.state, 'consider');
  assert.ok(card.referral.reasons.some((x) => /кардиолог|эндокринолог/i.test(x.title)));
});

test('ИМАО: красный статус, назначение блокируется без обхода', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Беляев');
  await d('POST', `/api/doctor/patients/${row.id}/exam`, { dx: 'F41_1', meds_reconciled: true });
  await d('POST', `/api/doctor/patients/${row.id}/meds`, { name: 'моклобемид' });
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.recommendation.prescribe_blocked, 'ddi');
  const rx = await d('POST', `/api/doctor/patients/${row.id}/prescribe`, { ddi_ack: true, override_reason: 'очень нужно, обоснование длинное' });
  assert.equal(rx.status, 409);
});

test('SOS пациента — красный алерт; некорректный ответ шкалы отклоняется', async () => {
  const p = await login('anna');
  assert.equal((await p('POST', '/api/patient/scales/gad7', { answers: [1, 2] })).status, 400);
  await p('POST', '/api/patient/sos');
  const d = await login('doctor');
  const row = await find(d, 'Соколова');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.ok(card.alerts.some((a) => a.severity === 'red' && /SOS|помощь/i.test(a.title)));
});

test('повторный приём: сводка изменений с прошлого визита и закрытие визита', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Кузнецова');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.ok(card.summary.scores.phq9); assert.equal(card.summary.scores.hads_a, null);
  assert.ok(card.summary.items.length >= 1);
  assert.equal((await d('POST', `/api/doctor/patients/${row.id}/visit`, { note: 'контроль через 2 недели' })).status, 200);
});

test('журнал решений хранит автора и защищён цепочкой хэшей', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Соколова');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.ok(card.decisions.some((x) => x.action === 'prescription_confirmed' && x.name));
  assert.equal((await d('GET', '/api/doctor/audit/verify')).body.ok, true);
  assert.equal(verifyAudit(db).ok, true);
});

test('метрики: время заполнения опросника фиксируется', () => {
  const m = svc.metrics();
  assert.ok(m.sppvr_fill && m.sppvr_fill.n >= 1);
});

test('время заполнения измеряется на сервере: мгновенное заполнение после старта даёт флаг «нетипичное время»', async () => {
  const p = await login('maria');
  await p('POST', '/api/patient/sppvr/start');
  const r = (await fill(p, CASE1, 400)).body;
  assert.ok(r.elapsed_sec < 5);
  const d = await login('doctor');
  const row = await find(d, 'Кузнецова');
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.equal(card.sppvr[0].flags.fast, true);
  assert.ok(card.sppvr[0].phq9 === 6, 'суммы шкал не обнуляются');
});

test('решение по рекомендации Авиандра пишется в журнал, отклонение требует причину, рецепт не создаётся', async () => {
  const d = await login('doctor');
  const row = await find(d, 'Беляев');
  assert.equal((await d('POST', `/api/doctor/patients/${row.id}/advice`, { action: 'dismiss' })).status, 400);
  assert.equal((await d('POST', `/api/doctor/patients/${row.id}/advice`, { action: 'dismiss', reason: 'выбрана другая тактика' })).status, 200);
  const card = (await d('GET', `/api/doctor/patients/${row.id}`)).body;
  assert.ok(card.decisions.some((x) => x.action === 'advice_dismissed'));
  assert.equal(card.recommendation.has_active, false);
});
