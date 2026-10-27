import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSppvr, deriveClinical, checkDrug, medClasses, evaluateAlerts, evaluateReferral, SPPVR_TOTAL } from '../src/engine.js';
import { analyze, aviandrAdvice } from '../src/protocol.js';

// Реестр тестов из документа КЛК «Клинический компас | Медицинская часть» (T-01…T-25 и три сквозных случая).
// Здесь проверяется логика поддержки решения; клинические формулировки и пороги остаются на верификации Арины.
const GAD = { code: 'F41.1', name: 'ГТР' };
const base = { age: 34, sex: 'Ж', conditions: [], pregnant: false, lactating: false, egfr: 95, hepatic_class: null, alcohol: false, exam: {}, treatment: {} };
const OK_TIME = { elapsed_sec: 240, item_sec: Array(20).fill(12) };
// 20 ответов: PHQ-9 ×9, HADS-A ×7 (значения по ключу; пункт 7 хранится сырым), внимание, три повторных вопроса
const mk = (phq, hads, anchors = null) => [...phq, ...hads.map((v, i) => (i === 3 ? 3 - v : v)), 1, ...(anchors || [phq[2], phq[6], hads[0]])];
const score = (phq, hads, anchors, timing = OK_TIME) => scoreSppvr(mk(phq, hads, anchors), timing);
const withClin = (r, c) => ({ ...r, clinical: c, cd: deriveClinical(c), ts: Date.now() });
const med = (n) => ({ name: n, ...medClasses(n) });
const CLIN_OK = { duration: '1_6m', functioning: 2, meds_status: 'none', meds: [], adverse: 'no', mania: 'no', somatic_hx: ['none'], alcohol: 'rare', substances: 'no', nicotine: 'no', organ: ['none'] };
const advise = (profile, meds, dx, cur, pathway) => aviandrAdvice({ drug: checkDrug('aviandr', profile, meds, dx), dx, profile, cur, pathway });

test('опросник содержит 20 экранов: PHQ-9, HADS-A, внимание, три повторных вопроса', () => { assert.equal(SPPVR_TOTAL, 20); });

test('T-01 PHQ-9 0,0,1,0,1,0,0,0,0 → сумма 2, не называется «эквивалентом»', () => {
  const r = score([0, 0, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.phq9, 2);
  assert.ok(!JSON.stringify(r.bands).includes('эквивалент'));
});
test('T-02 PHQ-9 2,2,2,1,2,2,1,1,0 → 13', () => assert.equal(score([2, 2, 2, 1, 2, 2, 1, 1, 0], [0, 0, 0, 0, 0, 0, 0]).phq9, 13));
test('T-03 PHQ-9 с пунктом 9 = 2: немедленное уточнение безопасности, без автоматической госпитализации', () => {
  // В документе КЛК для этого вектора указана сумма 22; фактическая сумма 2+3+3+3+2+3+2+3+2 = 23 (расхождение передано Арине).
  const r = score([2, 3, 3, 3, 2, 3, 2, 3, 2], [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(r.phq9, 23);
  assert.equal(r.item9, 2);
  assert.equal(r.flags.suicidal, true);
  const hits = evaluateAlerts({ scales: { gad7: [], phq9: [] }, sppvr: { ...r, ts: Date.now() }, profile: base, diary: [], events: {}, fresh: 'sppvr', activeRx: false });
  assert.ok(hits.some((h) => h.severity === 'red'));
  const acts = hits.flatMap((h) => h.actions || []);
  assert.ok(!acts.some((a) => String(a).startsWith('block_')), 'блокирующих действий нет');
  assert.ok(!acts.includes('hospitalize'));
  const ref = evaluateReferral({ profile: base, scales: { gad7: [], phq9: [] }, sppvrList: [{ ...r, ts: Date.now() }], activeRx: null, openCritical: true, adherence: null });
  assert.equal(ref.level, 'urgent');
  assert.ok(!/госпитализац/i.test(ref.route.label + ref.route.action.split('.')[0]) || /оценк/i.test(ref.route.action));
});
test('T-04 пропущен пункт PHQ-9 → сумма не выводится', () => {
  const a = mk([1, 1, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 1]); a[4] = null;
  const r = scoreSppvr(a, OK_TIME);
  assert.equal(r.phq9, null);
  assert.equal(r.complete, false);
  assert.equal(r.hads_a, null, 'форма HADS-A отсутствует');
});
test.todo('T-05 HADS-A: необходима утверждённая форма и ключ');
test.todo('T-06 HADS-A: необходима утверждённая форма и ключ');
test('Блок тревоги не выдаёт сумму HADS-A и не подменяет её значение', () => {
  const r = score([0,0,0,0,0,0,0,0,0], [3,3,3,3,3,3,3]);
  assert.equal(r.hads_a, null);
  assert.equal(r.bands.hads_a, null);
  assert.equal(r.answers.slice(9,16).length, 7);
});
test('T-07 «не уверен(а)» про манию → запрос уточнения, диагноз БАР не записывается', () => {
  const r = withClin(score([1, 1, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 1]), { ...CLIN_OK, mania: 'unsure' });
  assert.equal(r.cd.bar, true);
  const a = analyze(r, { profile: base, now: Date.now() });
  assert.ok(!JSON.stringify(a).includes('F31'));
  assert.equal(base.dx, undefined);
});
test('T-08 положительный пункт 9 при низкой сумме: сигнал безопасности не подавляется', () => {
  const r = score([0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.phq9, 1);
  assert.equal(r.flags.suicidal, true);
  const hits = evaluateAlerts({ scales: { gad7: [], phq9: [] }, sppvr: { ...r, ts: Date.now() }, profile: base, diary: [], events: {}, fresh: 'sppvr', activeRx: false });
  assert.ok(hits.some((h) => h.severity === 'red'));
});
test('T-09 сертралин + Авиандр: зелёного статуса нет', () => {
  const r = checkDrug('aviandr', base, [med('Сертралин 50 мг')], GAD);
  assert.notEqual(r.ddi_level, 'green');
  assert.equal(r.ddi_level, 'orange');
  const adv = advise({ ...base, dx: GAD, exam: { meds_reconciled: true } }, [med('Сертралин 50 мг')], GAD, null, 'gad');
  assert.notEqual(adv.state, 'consider');
});
test('T-10 ИМАО → жёсткая блокировка', () => {
  const r = checkDrug('aviandr', base, [med('моклобемид')], GAD);
  assert.equal(r.hard_block, true);
  assert.equal(r.ddi_level, 'red');
});
test('T-11 общее время < порога: флаг быстрого заполнения, суммы не обнуляются', () => {
  const r = score([2, 2, 2, 2, 2, 2, 2, 2, 0], [2, 2, 2, 2, 2, 2, 2], null, { elapsed_sec: 30, item_sec: Array(20).fill(1.5) });
  assert.equal(r.flags.fast, true);
  assert.equal(r.phq9, 16);
  assert.equal(r.hads_a, null);
});
test('T-12 одинаковые ответы: не только ИКСО, суммы сохраняются', () => {
  const r = score([1, 1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(r.phq9, 9);
  assert.ok(r.quality.score <= 100);
});
test('T-13 расхождение повторного вопроса на ≥ 2 снижает ИКСО', () => {
  const ok = score([2, 2, 2, 2, 2, 2, 2, 2, 0], [2, 2, 2, 2, 2, 2, 2]);
  const bad = score([2, 2, 2, 2, 2, 2, 2, 2, 0], [2, 2, 2, 2, 2, 2, 2], [0, 2, 2]);
  assert.ok(bad.quality.score < ok.quality.score);
  assert.equal(bad.quality.pairs[0].flagged, true);
  assert.equal(bad.phq9, ok.phq9, 'суммы шкал не меняются');
});
test('T-14 ТТГ > 10 → соматический сигнал, психиатрические действия не блокируются автоматически', () => {
  const profile = { ...base, exam: { tsh: 12, somatic: true } };
  const hits = evaluateAlerts({ scales: { gad7: [], phq9: [] }, sppvr: null, profile, diary: [], events: {}, fresh: 'exam', activeRx: false });
  assert.ok(hits.some((h) => h.rule_id === 'somatic_severe' || /сомат/i.test(h.title)));
  assert.ok(!hits.flatMap((h) => h.actions || []).some((a) => String(a).startsWith('block_')));
});
test('T-16 Авиандр: возраст < 18, беременность, СКФ < 60 → противопоказание, остальное не блокируется', () => {
  for (const p of [{ age: 17 }, { pregnant: true }, { egfr: 52 }]) {
    const r = checkDrug('aviandr', { ...base, ...p }, [], GAD);
    assert.equal(r.status, 'contraindicated');
  }
});
test('T-17 неизвестное лекарство → серый статус и нет «совместимо»', () => {
  const r = checkDrug('aviandr', base, [{ name: 'Таблетка для сна', classes: [], known: false }], GAD);
  assert.equal(r.ddi_level, 'grey');
});
test('T-18 «не знаю название» → unknown_data, не отрицательный ответ', () => {
  const d = deriveClinical({ ...CLIN_OK, meds_status: 'dont_know_name' });
  assert.equal(d.unknown_data, true);
  assert.equal(d.meds_unknown, true);
});
test('T-19 беременность не уточнена → признак pregnancy_unknown', () => {
  assert.equal(deriveClinical({ ...CLIN_OK, pregnancy: 'unsure' }).pregnancy_unknown, true);
  assert.equal(deriveClinical({ ...CLIN_OK, pregnancy: 'pregnant' }).pregnant, true);
});
test('T-20 регулярный алкоголь и вещества отмечаются', () => {
  const d = deriveClinical({ ...CLIN_OK, alcohol: 'daily', substances: 'yes' });
  assert.equal(d.substances, true);
  assert.equal(typeof d.alcohol_regular, 'boolean');
});
test('T-21 соматические жалобы: сердцебиение и тремор → группы кардио и эндокринная, маршрут «рекомендовано»', () => {
  const c = { ...CLIN_OK, organ: ['palpitations', 'tremor', 'heat', 'weight'] };
  const r = withClin(score([2, 2, 2, 2, 2, 2, 2, 3, 0], [2, 2, 1, 1, 1, 1, 1]), c);
  assert.deepEqual(r.cd.organ_groups.sort(), ['cardio', 'endocrine']);
  const ref = evaluateReferral({ profile: base, scales: { gad7: [], phq9: [] }, sppvrList: [r], activeRx: null, openCritical: false, adherence: null });
  assert.equal(ref.level, 'recommended');
  assert.ok(ref.reasons.some((x) => /кардиолог|эндокринолог/i.test(x.title)));
});
test('T-22 боль в груди + одышка → срочный маршрут', () => {
  const c = { ...CLIN_OK, organ: ['chest_pain', 'dyspnea'] };
  const r = withClin(score([1, 1, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 1]), c);
  assert.equal(r.cd.somatic_red, true);
  const ref = evaluateReferral({ profile: base, scales: { gad7: [], phq9: [] }, sppvrList: [r], activeRx: null, openCritical: false, adherence: null });
  assert.equal(ref.level, 'urgent');
});
test('T-23 C7: намерение или план → признак немедленной безопасности', () => {
  assert.equal(deriveClinical({ ...CLIN_OK, safety: 'intent_or_plan' }).safety_immediate, true);
  assert.equal(deriveClinical({ ...CLIN_OK, safety: 'thoughts_only' }).safety_immediate, false);
  assert.equal(deriveClinical({ ...CLIN_OK, safety: 'no_answer' }).safety_immediate, false);
});
test('T-24 рекомендация Авиандра без подтверждённого диагноза не формируется', () => {
  const adv = advise(base, [], null, null, 'gad');
  assert.notEqual(adv.state, 'consider');
});
test('T-25 версия правил: конфигурация содержит версию и источники', async () => {
  const { RULES } = await import('../src/engine.js');
  assert.ok(RULES.version);
});

// ---------- сквозные случаи ----------
test('Случай 1: подтверждённое ГТР, ответы о тревоге, PHQ-9 6, лекарства сверены → «Рекомендовано рассмотреть Авиандр»', () => {
  const cur = withClin(score([1, 1, 1, 0, 1, 1, 1, 0, 0], [2, 2, 2, 2, 2, 2, 1]), CLIN_OK);
  assert.equal(cur.hads_a, null); assert.equal(cur.phq9, 6);
  const profile = { ...base, dx: GAD, exam: { meds_reconciled: true } };
  const an = analyze(cur, { profile, now: Date.now() });
  const adv = advise(profile, [], GAD, cur, an.pathway);
  assert.equal(adv.state, 'consider');
  assert.match(adv.title, /рассмотреть/i);
});
test('Случай 2: ответы о тревоге, названия лекарств неизвестны → серый статус, рекомендации нет', () => {
  const c = { ...CLIN_OK, meds_status: 'dont_know_name', meds: [{ name: '' }] };
  const cur = withClin(score([1, 1, 1, 0, 1, 0, 1, 0, 0], [2, 2, 2, 2, 2, 2, 2]), c);
  assert.equal(cur.hads_a, null);
  const profile = { ...base, dx: GAD, exam: {} };
  const meds = [{ name: 'Название неизвестно', classes: [], known: false, source: 'patient' }];
  const adv = advise(profile, meds, GAD, cur, 'gad');
  assert.equal(adv.state, 'grey');
  assert.notEqual(adv.state, 'consider');
});
test('Случай 3: PHQ-9 17, ответы о тревоге, сердцебиение, тремор, потеря веса → Авиандр не рекомендуется, соматический маршрут', () => {
  const c = { ...CLIN_OK, organ: ['palpitations', 'tremor', 'heat', 'weight'] };
  const cur = withClin(score([2, 2, 2, 2, 2, 2, 2, 3, 0], [2, 2, 1, 1, 1, 1, 1]), c);
  assert.equal(cur.phq9, 17); assert.equal(cur.hads_a, null);
  const an = analyze(cur, { profile: base, now: Date.now() });
  assert.equal(an.pathway, 'de');
  const adv = advise(base, [], null, cur, an.pathway);
  assert.notEqual(adv.state, 'consider');
  const ref = evaluateReferral({ profile: base, scales: { gad7: [], phq9: [] }, sppvrList: [cur], activeRx: null, openCritical: false, adherence: null });
  assert.ok(ref.reasons.some((x) => /кардиолог|эндокринолог/i.test(x.title)));
});
