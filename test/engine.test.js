import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreScale, scoreSppvr, checkDrug, medClasses, evaluateAlerts, evaluateReferral, adherence } from '../src/engine.js';
import { analyze } from '../src/protocol.js';
import { gameOf } from '../src/game.js';

const GAD = { code: 'F41.1', name: 'ГТР' };
const base = { age: 34, conditions: [], pregnant: false, lactating: false, egfr: 95, hepatic_class: null, alcohol: false, exam: {}, treatment: {} };
const DAY = 86400000;

const withTs = (r, ts = Date.now()) => ({ ...r, ts });

// ---------- полные шкалы ----------
test('GAD-7: сумма и степень тяжести', () => {
  assert.deepEqual(scoreScale('gad7', [2, 2, 2, 2, 2, 2, 2]), { total: 14, band: 'умеренная', level: 2 });
  assert.equal(scoreScale('gad7', [3, 3, 3, 3, 3, 3, 3]).band, 'тяжёлая');
});
test('PHQ-9: границы степеней', () => {
  assert.equal(scoreScale('phq9', [1, 1, 1, 1, 1, 0, 0, 0, 0]).band, 'лёгкая');
  assert.equal(scoreScale('phq9', [3, 3, 3, 3, 3, 3, 2, 0, 0]).band, 'тяжёлая');
});
test('Шкала отклоняет некорректный ввод', () => {
  assert.throws(() => scoreScale('gad7', [1, 2, 3]));
  assert.throws(() => scoreScale('gad7', [4, 0, 0, 0, 0, 0, 0]));
  assert.throws(() => scoreScale('nope', []));
});

// ---------- СППВР: подсчёт ----------
test('СППВР: отклоняет неверное число ответов и недопустимые значения', () => {
  assert.throws(() => scoreSppvr([1, 2, 3]));
  const bad = Array(20).fill(1); bad[0] = 4;
  assert.throws(() => scoreSppvr(bad, { elapsed_sec: 100 }));
  const frac = Array(20).fill(1); frac[0] = 1.5;
  assert.throws(() => scoreSppvr(frac, { elapsed_sec: 100 }));
});

// ---------- СППВР: протокол ----------
// ---------- препарат и взаимодействия ----------
test('Авиандр: СКФ < 60, беременность, возраст < 18, печёночная недостаточность — противопоказания', () => {
  assert.equal(checkDrug('aviandr', { ...base, egfr: 52 }, [], GAD).status, 'contraindicated');
  assert.equal(checkDrug('aviandr', { ...base, pregnant: true }, [], GAD).status, 'contraindicated');
  assert.equal(checkDrug('aviandr', { ...base, age: 17 }, [], GAD).status, 'contraindicated');
  assert.equal(checkDrug('aviandr', { ...base, hepatic_class: 'A' }, [], GAD).status, 'contraindicated');
});
test('ИМАО: красный статус и жёсткая блокировка', () => {
  const meds = [{ name: 'моклобемид', ...medClasses('моклобемид') }];
  const r = checkDrug('aviandr', base, meds, GAD);
  assert.equal(r.hard_block, true);
  assert.equal(r.ddi_level, 'red');
  assert.equal(r.status, 'contraindicated');
});
test('Бензодиазепин и ингибитор CYP3A4: жёлтые взаимодействия, второе требует проверки по инструкции', () => {
  const r = checkDrug('aviandr', base, [{ name: 'Диазепам', ...medClasses('диазепам') }, { name: 'Кларитромицин', ...medClasses('кларитромицин') }], GAD);
  assert.equal(r.ddi_level, 'yellow');
  assert.equal(r.interactions.filter((i) => i.needs_verification).length, 2);
});
test('Справочник: неизвестный препарат не классифицируется', () => {
  assert.deepEqual(medClasses('неизвестное средство'), { classes: [], known: false });
});

// ---------- алерты ----------
test('Оранжевый алерт: соматика (ТТГ > 10) и красный: психотические симптомы по осмотру', () => {
  const hits = evaluateAlerts({ scales: { phq9: [], gad7: [] }, sppvr: null, profile: { exam: { somatic: true, tsh: 12, psychotic: true } }, fresh: 'exam', events: {} });
  assert.equal(hits.find((h) => h.rule_id === 'somatic_severe').severity, 'orange');
  assert.equal(hits.find((h) => h.rule_id === 'psychotic').severity, 'red');
});
test('Алерт: PHQ-9 пункт 9 и PHQ-9 ≥ 20', () => {
  const answers = [0, 0, 0, 0, 0, 0, 0, 0, 2];
  assert.ok(evaluateAlerts({ scales: { phq9: [{ ts: 1, total: 2, answers }], gad7: [] }, fresh: 'phq9', events: {} }).some((h) => h.rule_id === 'phq9_item9' && h.severity === 'red'));
  const sev = [3, 3, 3, 3, 3, 3, 2, 0, 0];
  assert.ok(evaluateAlerts({ scales: { phq9: [{ ts: 1, total: 20, answers: sev }], gad7: [] }, fresh: 'phq9', events: {} }).some((h) => h.rule_id === 'phq9_severe'));
});
test('Алерт: SOS и тяжёлое нежелательное явление', () => {
  assert.ok(evaluateAlerts({ scales: { phq9: [], gad7: [] }, events: { sos: true } }).some((h) => h.rule_id === 'sos'));
  assert.ok(evaluateAlerts({ scales: { phq9: [], gad7: [] }, events: { adverse: ['судорожный приступ', 'сонливость'] } }).some((h) => h.rule_id === 'severe_adverse_event'));
  assert.equal(evaluateAlerts({ scales: { phq9: [], gad7: [] }, events: { adverse: ['сонливость'] } }).length, 0);
});
test('Алерт: рост GAD-7 на ≥ 5 при значении ≥ 15 и 3 пропуска подряд', () => {
  const sc = { phq9: [], gad7: [{ ts: 2, total: 17, answers: [] }, { ts: 1, total: 11, answers: [] }] };
  assert.ok(evaluateAlerts({ scales: sc, fresh: 'gad7', events: {} }).some((h) => h.rule_id === 'gad7_jump'));
  const now = Date.now();
  const diary = [0, 1, 2].map((d) => ({ ts: now - d * DAY, doses_taken: 0, doses_planned: 2 }));
  assert.ok(evaluateAlerts({ scales: { phq9: [], gad7: [] }, diary, events: { diary: true }, activeRx: true }).some((h) => h.rule_id === 'missed_doses'));
});
test('Приверженность и серия пропусков', () => {
  const now = Date.now();
  const rows = [0, 1, 2, 3, 4].map((d) => ({ ts: now - d * DAY, doses_taken: d < 3 ? 0 : 2, doses_planned: 2 }));
  const a = adherence(rows, 14, now);
  assert.equal(a.missed_streak, 3);
  assert.equal(a.pct, 40);
});

// ---------- маршрутизация ----------
const rctx = (sp, extra = {}) => ({ profile: { conditions: [], exam: {}, treatment: {}, ...extra.profile }, scales: { phq9: [], gad7: [] }, sppvrList: sp ? [withTs(scoreSppvr(sp, 150))] : [], activeRx: null, ...extra.rest });
test('Маршрут: нет ответа по GAD-7 через 4 недели', () => {
  const now = Date.now();
  const scales = { phq9: [], gad7: [{ ts: now - 1 * DAY, total: 16, answers: [] }, { ts: now - 28 * DAY, total: 15, answers: [] }] };
  const r = evaluateReferral({ profile: { conditions: [], exam: {}, treatment: {} }, scales, sppvrList: [], activeRx: { started_ts: now - 28 * DAY } }, now);
  assert.ok(r.reasons.some((x) => x.id === 'ref_no_response'));
});

test('Геймификация: искры, уровни и серия дней без штрафов', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const g0 = gameOf({ sppvr: 0, scale: 0 }, [], now);
  assert.equal(g0.points, 0); assert.equal(g0.level.name, 'Росток'); assert.equal(g0.streak, 0);
  const g = gameOf({ sppvr: 1, scale: 1 }, [now, now - 86400000, now - 2 * 86400000], now);
  assert.equal(g.points, 50 + 30 + 3 * 20); assert.equal(g.level.name, 'Овечка'); assert.equal(g.streak, 3); assert.equal(g.diary_today, true);
  // серия не обнуляется до конца сегодняшнего дня
  assert.equal(gameOf({ sppvr: 0, scale: 0 }, [now - 86400000, now - 2 * 86400000], now).streak, 2);
  // пропуск дня обнуляет только серию, но не очки
  const gap = gameOf({ sppvr: 0, scale: 0 }, [now - 3 * 86400000], now); assert.equal(gap.streak, 0); assert.equal(gap.points, 20);
});
