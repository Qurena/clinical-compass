// Ядро: подсчёт шкал и СППВР, проверка препарата и взаимодействий, правила алертов и маршрутизации.
// Правила и справочники берутся из config/*.json, код ядра при их изменении не трогаем.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');
const load = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));

export const SCALES = load('scales.json');
export const PLANS = load('plans.json');
export const DDI = load('ddi.json');
export const DRUGS = { aviandr: load('drug_aviandr.json') };
export const RULES = load('rules.json');
export const T = RULES.thresholds;

const DAY = 86400000;
const bandOf = (bands, v) => bands.find((b) => v <= b.max) || bands[bands.length - 1];

/** Подсчёт полной шкалы (PHQ-9, GAD-7). answers: массив чисел по пунктам. */
export function scoreScale(scaleId, answers) {
  const def = SCALES[scaleId];
  if (!def) throw new Error('unknown_scale');
  if (!Array.isArray(answers) || answers.length !== def.items.length) throw new Error('bad_answers');
  const maxV = Math.max(...def.options.map((o) => o.v));
  for (const a of answers) {
    if (!Number.isInteger(a) || a < 0 || a > maxV) throw new Error('bad_answers');
  }
  const total = answers.reduce((s, x) => s + x, 0);
  const band = bandOf(def.bands, total);
  return { total, band: band.label, level: band.level };
}

// ---------- СППВР ----------
// СППВР 2.0 по КЛК: полный PHQ-9 (9 пунктов, 0–27) + тревожная субшкала HADS-A (7 пунктов, 0–21), суммы раздельные;
// блок E (внимание, 3 контрольных вопроса) формирует вспомогательный индекс ИКСО; клинический контекст C1–C12 в суммы не входит.
const SPPVR_CFG = load('sppvr.json');
const FREQ = SPPVR_CFG.options;
const PHQ_N = SCALES.phq9.items.length;            // 9
const HADS_N = SPPVR_CFG.hads_a.items.length;      // 7
const PSYCH_N = PHQ_N + HADS_N;                    // 16 основных психометрических пунктов
const QUALITY = SPPVR_CFG.quality;
const hadsLabel = (i) => `Вопрос о тревоге ${i + 1}`;
export const SPPVR = {
  ...SPPVR_CFG,
  psych_count: PSYCH_N,
  questions: [
    ...SCALES.phq9.items.map((text, i) => ({ id: i + 1, kind: 'phq9', n: i + 1, block: 'A', tag: `PHQ-9 / ${i + 1}`, text, options: SCALES.phq9.options })),
    ...SPPVR_CFG.hads_a.items.map((it, i) => ({ id: PHQ_N + i + 1, kind: 'hads', n: it.n, block: 'B', tag: hadsLabel(i), domain: it.domain, text: it.text, reverse: it.reverse, options: FREQ })),
    { id: PSYCH_N + 1, kind: 'attention', block: 'E', tag: 'Проверка внимания', text: SPPVR_CFG.attention.text, options: FREQ },
    ...SPPVR_CFG.anchors.map((an, i) => ({ id: PSYCH_N + 2 + i, kind: 'anchor', block: 'E', tag: `Контрольный вопрос ${i + 1}`, text: an.text, pair: an.pair, options: FREQ }))
  ]
};
export const SPPVR_TOTAL = SPPVR.questions.length;  // 20 экранов
export const T_EXTRA = {};
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const gradeOf = (score) => (score === null ? QUALITY.grade_none : QUALITY.grades.find((g) => score >= g.min));

/** Балл HADS-A по ключу: пункт 7 кодируется обратно (3 − ответ). Принимает «сырые» ответы, возвращает закодированные значения. */
export function hadsKey(raw) {
  return raw.map((v, i) => (v === null || v === undefined ? null : SPPVR_CFG.hads_a.items[i].reverse ? 3 - v : v));
}

/**
 * Подсчёт опросника СППВР. answers: 20 значений 0–3 (PHQ-9 ×9, HADS-A ×7 «сырые», проверка внимания, 3 контрольных вопроса).
 * Пропуск пункта: null. Любой пропуск психометрического пункта: сумма шкалы НЕ считается (пропуск не приравнивается к 0), ИКСО не рассчитывается.
 * timing: число (общее активное время, с) или { elapsed_sec, item_sec: [20 значений активного времени на пункт, с] }.
 */
export function scoreSppvr(answers, timing = null) {
  const qs = SPPVR.questions;
  if (!Array.isArray(answers) || answers.length !== qs.length) throw new Error('bad_answers');
  for (const a of answers) if (a !== null && !(Number.isInteger(a) && a >= 0 && a <= 3)) throw new Error('bad_answers');
  const tm = typeof timing === 'number' ? { elapsed_sec: timing } : (timing || {});
  const el = Number.isFinite(Number(tm.elapsed_sec)) && tm.elapsed_sec !== null && tm.elapsed_sec !== undefined ? Number(tm.elapsed_sec) : null;
  const itemSec = Array.isArray(tm.item_sec) && tm.item_sec.length === qs.length ? tm.item_sec.map((x) => (Number.isFinite(Number(x)) && x !== null ? Number(x) : null)) : null;

  const phqRaw = answers.slice(0, PHQ_N);
  const hadsRaw = answers.slice(PHQ_N, PSYCH_N);
  const phqOk = phqRaw.every((v) => v !== null);
  const hadsOk = hadsRaw.every((v) => v !== null);
  const hadsCoded = hadsKey(hadsRaw);
  const phq9 = phqOk ? phqRaw.reduce((s, x) => s + x, 0) : null;
  // В КЛК нет утверждённой формы HADS-A. Демо-вопросы сохраняем как ответы,
  // но не выдаём сумму за шкалу и не используем её клинические пороги.
  const hads_a = null;
  const item9 = phqRaw[PHQ_N - 1];
  const bandOf2 = (bands, v) => (v === null ? null : bandOf(bands, v).label);

  // ---- ИКСО ----
  const att = answers[PSYCH_N];
  const attentionFailed = att !== null && att !== SPPVR_CFG.attention.correct;
  const pairs = SPPVR_CFG.anchors.map((an, i) => {
    const anchor = answers[PSYCH_N + 1 + i];
    const orig = an.pair.scale === 'phq9' ? phqRaw[an.pair.item - 1] : hadsCoded[SPPVR_CFG.hads_a.items.findIndex((h) => h.n === an.pair.item)];
    const gap = anchor === null || orig === null || orig === undefined ? null : Math.abs(anchor - orig);
    return { scale: an.pair.scale, item: an.pair.item, orig: orig ?? null, anchor, gap, flagged: gap !== null && gap >= T.anchor_gap };
  });
  const P_ = QUALITY.penalties;
  const A = attentionFailed ? P_.A : 0;
  const C = Math.min(P_.C_max, pairs.filter((p) => p.flagged).length * P_.C_each);
  const psychSec = itemSec ? itemSec.slice(0, PSYCH_N) : null;
  const known = psychSec && psychSec.every((x) => x !== null);
  const blockSec = known ? psychSec.reduce((s, x) => s + x, 0) : el;
  const fast = (known && median(psychSec) < T.fast_median_seconds) || (blockSec !== null && blockSec < T.fast_block_seconds);
  const slow = (itemSec ? itemSec.some((x) => x !== null && x > T.slow_item_seconds) : false) || (el !== null && el > T.slow_total_seconds);
  const sameAll = (arr) => arr.every((v) => v !== null) && arr.length > 0 && arr.filter((v) => v === arr[0]).length / arr.length >= T.uniform_share;
  const uniform = sameAll(phqRaw) || sameAll(hadsRaw);
  const P = uniform && (fast || attentionFailed) ? P_.P : 0;
  // штраф T не суммируется: один максимальный
  const Tpen = fast ? P_.T_fast : (slow && (A > 0 || C > 0 || P > 0 || uniform) ? P_.T_slow_with_other : 0);
  const complete = phqOk && hadsOk;
  const score = complete ? Math.max(0, 100 - A - C - Tpen - P) : null;
  const components = [];
  if (A) components.push(`проверка внимания не пройдена (−${A})`);
  if (C) components.push(`расхождение в ${pairs.filter((p) => p.flagged).length} контрольн. парах (−${C})`);
  if (fast) components.push(`нетипично быстрое активное время (−${P_.T_fast})`);
  else if (Tpen) components.push(`нетипично долгое активное время вместе с другим сигналом (−${Tpen})`);
  else if (slow) components.push('нетипично долгое активное время (штрафа нет без другого сигнала)');
  if (P) components.push(`одинаковый паттерн ответов вместе с другим сигналом (−${P})`);

  return {
    answers, phq9, hads_a, item9, phq9_items: phqRaw, hads_items: hadsCoded,
    complete,
    bands: { phq9: bandOf2(SCALES.phq9.bands, phq9), hads_a: bandOf2(SPPVR_CFG.hads_a.bands, hads_a) },
    quality: { score, grade: gradeOf(score), penalties: { A, C, T: Tpen, P }, pairs, components, uniform, formula: QUALITY.formula },
    elapsed_sec: el, item_sec: itemSec,
    flags: {
      suicidal: item9 !== null && item9 >= T.phq9_item9,
      severe_dep: phq9 !== null && phq9 >= T.phq9_severe,
      attention_failed: attentionFailed,
      inconsistent: C > 0,
      fast, slow, uniform,
      quality_low: score !== null && score < QUALITY.grades[0].min,
      bar: false, safety_immediate: false, unknown_data: false
    }
  };
}

/** Клинический контекст C1–C12 → производные признаки. Никогда не превращает «не знаю» в отрицательный ответ. */
export function deriveClinical(c = {}) {
  const cl = SPPVR.clinical;
  const org = Array.isArray(c.organ) ? c.organ : [];
  const hx = Array.isArray(c.somatic_hx) ? c.somatic_hx : [];
  const meds = Array.isArray(c.meds) ? c.meds : [];
  const medUnknownStatus = ['dont_know_name', 'dont_remember', 'discuss'].includes(c.meds_status);
  const medNoName = meds.some((m) => !String(m.name || '').trim());
  const preg = c.pregnancy || null;
  const grp = cl.organ.groups;
  const groups = Object.keys(grp).filter((g) => grp[g].some((v) => org.includes(v)));
  const somatic_red = org.includes('chest_pain') && (org.includes('dyspnea') || org.includes('syncope'));
  const unknown_data = medUnknownStatus || medNoName || ['unsure', 'discuss', 'planning'].includes(preg) || org.includes('unknown') || hx.includes('unknown');
  return {
    bar: c.mania === 'yes' || c.mania === 'unsure',
    safety_immediate: cl.safety.immediate.includes(c.safety),
    unknown_data,
    meds_unknown: medUnknownStatus || medNoName,
    somatic_red,
    organ_groups: groups,
    substances: c.substances === 'yes',
    alcohol_regular: cl.alcohol.regular.includes(c.alcohol),
    pregnant: preg === 'pregnant', lactating: preg === 'lactating', pregnancy_unknown: ['unsure', 'discuss', 'planning'].includes(preg),
    conditions: [
      ...(hx.includes('cardiovascular') ? ['cardiovascular'] : []),
      ...(hx.includes('thyroid') || hx.includes('endocrine') ? ['endocrine'] : []),
      ...(hx.includes('epilepsy') ? ['epilepsy'] : []),
      ...(hx.includes('gastro') ? ['gastro'] : [])
    ]
  };
}

// ---------- взаимодействия и препарат ----------

/** Определяет классы препарата по названию (справочник ddi.json). Неизвестные: classes = [], known = false. */
export function medClasses(name) {
  const n = String(name || '').toLowerCase();
  for (const [k, classes] of Object.entries(DDI.dictionary)) {
    if (n.includes(k)) return { classes, known: true };
  }
  return { classes: [], known: false };
}

function matches(check, p, meds) {
  switch (check.type) {
    case 'age_lt': return p.age < check.value;
    case 'age_gt': return p.age > check.value;
    case 'flag': return !!p[check.key];
    case 'condition': return (p.conditions || []).includes(check.key);
    case 'med_class': return meds.some((m) => (m.classes || []).includes(check.key));
    case 'egfr_lt': return typeof p.egfr === 'number' && p.egfr < check.value;
    case 'hepatic_any': return !!p.hepatic_class;
    default: return false;
  }
}

/** Проверка препарата по профилю пациента. Ничего не назначает, только информирует врача. */
export function checkDrug(drugId, profile, meds = [], dx = null) {
  const d = DRUGS[drugId];
  const contraindications = d.contraindications.filter((c) => matches(c.check, profile, meds)).map((c) => c.label);
  const cautions = d.cautions.filter((c) => matches(c.check, profile, meds)).map((c) => c.label);
  const interactions = DDI.entries
    .map((e) => ({ e, hit: meds.filter((m) => (m.classes || []).includes(e.class)) }))
    .filter((x) => x.hit.length)
    .map(({ e, hit }) => ({
      status: e.status, text: e.label, action: e.action, source: e.source,
      hard_block: !!e.hard_block, needs_verification: !!e.needs_verification,
      team_status: e.team_status || null, team_note: e.team_note || null,
      meds: hit.map((m) => m.name)
    }));
  if (profile.alcohol) {
    const e = DDI.entries.find((x) => x.class === 'cns_depressant');
    interactions.push({ status: e.status, text: e.label, action: e.action, source: e.source, hard_block: false, needs_verification: false, meds: ['алкоголь (отмечено в профиле)'] });
  }
  const unknownMeds = meds.filter((m) => m.known === false).map((m) => m.name);
  const code = dx && dx.code;
  const ind = d.indications.find((i) => code && i.codes.includes(code) && (!i.requires_condition || (profile.conditions || []).includes(i.requires_condition)));
  const needsCovid = !ind && d.indications.find((i) => code && i.codes.includes(code) && i.requires_condition);
  const indication = ind
    ? { match: true, label: ind.label, course: d.dosing.courses[ind.id] }
    : { match: false, label: needsCovid ? 'Показание по инструкции относится к состояниям после COVID-19; в профиле отметки нет' : 'Диагноз не входит в зарегистрированные показания' };

  const hard = interactions.some((i) => i.hard_block);
  // пробелы данных: при них «совместимо» не выводится (серый статус)
  const ex = profile.exam || {};
  const gaps = [];
  if (unknownMeds.length) gaps.push('есть препараты без названия или вне справочника: ' + unknownMeds.join(', '));
  if (!ex.meds_reconciled) gaps.push('полный список лекарств (включая безрецептурные, БАДы, травы) не сверён с пациентом; статус ИМАО и последняя доза не подтверждены');
  if (profile.pregnancy_unknown) gaps.push('статус беременности/лактации не уточнён');
  let status = 'ok';
  if (cautions.length || interactions.length) status = 'caution';
  if (gaps.length) status = 'unverified';
  if (!indication.match) status = 'off_label';
  if (contraindications.length || hard) status = 'contraindicated';
  const has = (x) => interactions.some((i) => i.status === x);
  const ddi_level = has('red') ? 'red' : has('orange') ? 'orange' : has('yellow') ? 'yellow' : gaps.length ? 'grey' : 'green';
  return {
    drug: { id: d.id, name: d.name, inn: d.inn, form: d.form, source: d.source, verify: d.verify },
    status, hard_block: hard, ddi_level, gaps,
    contraindications, cautions, interactions, unknown_meds: unknownMeds,
    indication, dosing: d.dosing, adverse_events: d.adverse_events, monitoring: d.monitoring
  };
}

// ---------- приверженность ----------

/** diary: записи с полями ts, doses_taken, doses_planned. */
export function adherence(diary, days = 14, now = Date.now()) {
  const from = now - days * DAY;
  const rows = diary.filter((r) => r.ts >= from && r.doses_planned > 0);
  if (!rows.length) return { pct: null, days: 0, missed_streak: 0 };
  const planned = rows.reduce((s, r) => s + r.doses_planned, 0);
  const taken = rows.reduce((s, r) => s + Math.min(r.doses_taken, r.doses_planned), 0);
  const sorted = [...rows].sort((a, b) => b.ts - a.ts);
  let streak = 0;
  for (const r of sorted) {
    if (r.doses_taken === 0) streak++;
    else break;
  }
  return { pct: Math.round((taken / planned) * 100), days: rows.length, missed_streak: streak };
}

// ---------- алертинг ----------

const CLIN_FLAGS = new Set(['bar', 'safety_immediate', 'unknown_data']);
const lbl = (opts, v) => ((opts || []).find((o) => o.v === v) || {}).t || v;
const FLAG_TEXT = {
  suicidal: (s) => `PHQ-9, пункт 9: «${lbl(SCALES.phq9.options, s.item9)}»`,
  severe_dep: (s) => `PHQ-9 = ${s.phq9} из 27. Сигнал приоритетной оценки, не диагноз и не основание для автоматической госпитализации`,
  bar: (s) => `Клинический блок, C5: «${lbl(SPPVR.clinical.mania.options, (s.clinical || {}).mania)}»`,
  safety_immediate: (s) => `Клинический блок, C7: «${lbl(SPPVR.clinical.safety.options, (s.clinical || {}).safety)}»`,
  quality_low: (s) => `ИКСО ${s.quality.score}: ${s.quality.components.join('; ') || 'есть отдельные признаки'}. Сигнал для уточнения, а не вывод о достоверности или мотиве`,
  unknown_data: (s) => 'Часть сведений неизвестна или не указана (лекарства, беременность/лактация, соматический анамнез). «Не знаю» не считается отрицательным ответом'
};

/**
 * ctx: { scales: {phq9:[...], gad7:[...]} (по убыванию ts), sppvr: последний результат СППВР | null,
 *        diary: [...], profile, events: {sos?, adverse?, diary?}, fresh: 'phq9'|'gad7'|'sppvr'|'exam', activeRx: bool }
 * Возвращает список сработавших правил. Правила, привязанные к новому вводу, срабатывают только при fresh.
 */
export function evaluateAlerts(ctx) {
  const out = [];
  for (const r of RULES.alert_rules) {
    const p = r.params;
    let hit = null;
    if (r.type === 'sppvr_flag') {
      const s = ctx.sppvr;
      const ok = CLIN_FLAGS.has(p.flag) ? (ctx.fresh === 'sppvr' || ctx.fresh === 'clinical') : ctx.fresh === 'sppvr';
      if (ok && s && s.flags[p.flag]) hit = FLAG_TEXT[p.flag](s);
    } else if (r.type === 'exam_flag') {
      const ex = (ctx.profile && ctx.profile.exam) || {};
      if (ctx.fresh === 'exam' && ex[p.key]) hit = p.key === 'somatic' ? `ТТГ: ${ex.tsh ?? '–'}; аритмия: ${ex.arrhythmia ? 'да' : 'нет'}` : 'Отмечено врачом при осмотре';
    } else if (r.type === 'scale_item_gte') {
      const last = (ctx.scales[p.scale] || [])[0];
      if (ctx.fresh === p.scale && last && last.answers[p.item - 1] >= p.value) {
        hit = `Пункт ${p.item}: ответ «${SCALES[p.scale].options[last.answers[p.item - 1]].t}»`;
      }
    } else if (r.type === 'scale_total_gte') {
      const last = (ctx.scales[p.scale] || [])[0];
      if (ctx.fresh === p.scale && last && last.total >= p.value) hit = `${SCALES[p.scale].name} = ${last.total}`;
    } else if (r.type === 'scale_jump') {
      const [last, prev] = ctx.scales[p.scale] || [];
      if (ctx.fresh === p.scale && last && prev && last.total >= p.min_score && last.total - prev.total >= p.delta) {
        hit = `${SCALES[p.scale].name}: ${prev.total} → ${last.total}`;
      }
    } else if (r.type === 'sos') {
      if (ctx.events && ctx.events.sos) hit = 'Сигнал от пациента';
    } else if (r.type === 'adverse_event_any') {
      const found = ((ctx.events && ctx.events.adverse) || []).filter((e) => p.events.includes(e));
      if (found.length) hit = found.join('; ');
    } else if (r.type === 'missed_doses') {
      if (ctx.activeRx && ctx.events && ctx.events.diary) {
        const a = adherence(ctx.diary);
        if (a.missed_streak >= p.days) hit = `Пропусков подряд: ${a.missed_streak}`;
      }
    }
    if (hit) out.push({ rule_id: r.id, severity: r.severity, title: r.title, details: hit, actions: r.actions });
  }
  return out;
}

// ---------- маршрутизация ----------

/**
 * ctx: { profile, scales, sppvrList (по убыванию ts), activeRx: {started_ts}|null, openCritical: bool, adherence, medsUnverified: bool }
 * Возвращает { level: 'urgent'|'mandatory'|'recommended'|'none', reasons: [...], route }
 */
export function evaluateReferral(ctx, now = Date.now()) {
  const reasons = [];
  const ex = ctx.profile.exam || {};
  const last = (ctx.sppvrList || [])[0] || null;
  // флаги БАР снимаются, если врач очно исключил биполярное расстройство
  const flag = (k) => !!last && last.flags[k] && !(k === 'bar' && ex.bar_excluded);
  for (const r of RULES.referral_rules) {
    const p = r.params;
    let hit = false;
    if (r.type === 'sppvr_flag') hit = flag(p.flag);
    else if (r.type === 'exam_flag') hit = !!ex[p.key];
    else if (r.type === 'sppvr_scores_gte') hit = !!last && ((last.phq9 !== null && last.phq9 >= p.phq9) || (last.hads_a !== null && last.hads_a >= p.hads_a));
    else if (r.type === 'sppvr_mixed') hit = !!last && !ctx.profile.dx && last.hads_a !== null && last.phq9 !== null && last.hads_a >= T.hads_a_clinical && last.phq9 >= T.phq9_screen && last.phq9 < T.phq9_severe;
    else if (r.type === 'clinical_flag') hit = !!last && !!(last.cd || {})[p.key] || (p.key === 'substances' && (ctx.profile.conditions || []).includes('substance_misuse'));
    else if (r.type === 'clinical_group') hit = !!last && ((last.cd || {}).organ_groups || []).includes(p.group) && !(last.cd || {}).somatic_red;
    else if (r.type === 'meds_unverified') hit = !!ctx.medsUnverified;
    else if (r.type === 'low_adherence') hit = !!ctx.activeRx && ctx.adherence && ctx.adherence.pct != null && ctx.adherence.pct < T.low_adherence_pct;
    else if (r.type === 'profile_number_gte') hit = Number(ctx.profile.treatment && ctx.profile.treatment[p.key]) >= p.value;
    else if (r.type === 'somatic_any') hit = !!ex.somatic || (ctx.profile.conditions || []).some((c) => p.keys.includes(c));
    else if (r.type === 'scale_item_gte') {
      const l = (ctx.scales[p.scale] || [])[0];
      hit = !!l && l.answers[p.item - 1] >= p.value;
    } else if (r.type === 'scale_total_gte') {
      const l = (ctx.scales[p.scale] || [])[0];
      hit = !!l && l.total >= p.value;
    } else if (r.type === 'condition_any') {
      hit = (ctx.profile.conditions || []).some((c) => p.keys.includes(c));
    } else if (r.type === 'critical_alert_open') {
      hit = !!ctx.openCritical;
    } else if (r.type === 'no_response') {
      const rx = ctx.activeRx;
      const list = ctx.scales[p.scale] || [];
      if (rx && now - rx.started_ts >= p.weeks * 7 * DAY && list.length >= 2) {
        const chrono = [...list].reverse();
        const baseline = chrono.find((s) => s.ts >= rx.started_ts - 3 * DAY) || chrono[0];
        const latest = list[0];
        if (baseline.total > 0 && latest.ts > baseline.ts) {
          const red = ((baseline.total - latest.total) / baseline.total) * 100;
          hit = red < p.min_reduction_pct;
        }
      }
    }
    if (hit) reasons.push({ id: r.id, level: r.level, title: r.title, basis: r.basis, action: r.action });
  }
  const level = ['urgent', 'mandatory', 'recommended'].find((l) => reasons.some((x) => x.level === l)) || 'none';
  return { level, reasons, route: RULES.routes[level] };
}
