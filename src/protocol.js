// Клинический протокол СППВР по КЛК: сигнал для клинической оценки, этап ведения, карточка рекомендации по Авиандру.
// Это поддержка решения: диагноз, назначение, изменение дозы и маршрут подтверждает врач; ничего не назначается автоматически.
import { PLANS, SPPVR, T } from './engine.js';

const DAY = 86400000;
const stageOf = (path, n) => PLANS[path].stages.find((s) => s.n === n);
const mkStage = (path, n, extra = {}) => {
  const s = stageOf(path, n);
  return { n, title: s.title, items: s.items, behavior: s.behavior, ...extra };
};
const pct = (from, to) => (from > 0 ? Math.round(((from - to) / from) * 100) : null);

/** Динамика: изменение исходного PHQ-9 и HADS-A считается отдельно, суммы не складываются. */
export function response(key, cur, history, startedTs) {
  const all = [cur, ...history].filter(Boolean).filter((s) => s[key] !== null && s[key] !== undefined).sort((a, b) => a.ts - b.ts);
  if (all.length < 2) return null;
  const base = all.find((s) => s.ts >= startedTs - 3 * DAY) || all[0];
  if (base.ts >= cur.ts) return null;
  return { key, baseline: base[key], latest: cur[key], reduction_pct: pct(base[key], cur[key]), baseline_ts: base.ts };
}

/**
 * cur: последний результат СППВР (phq9, hads_a, flags, quality, clinical, ts) или null
 * ctx: { profile, history, rx, now }
 */
export function analyze(cur, ctx) {
  if (!cur) return { state: 'no_data', pathway: null, hypothesis: null, stage: null, blocks: [], notes: [], non_drug: [] };
  const prof = ctx.profile || {};
  const ex = prof.exam || {};
  const f = cur.flags;
  const cl = cur.clinical || {};
  const now = ctx.now || Date.now();
  const barActive = f.bar && !ex.bar_excluded;
  const red = f.suicidal || f.severe_dep || f.safety_immediate || !!ex.psychotic;
  const q = cur.quality || {};
  const lowQuality = q.score !== null && q.score !== undefined && q.score < 50;
  const incomplete = !cur.complete;
  const blocks = [];
  const notes = [];

  if (red) notes.push('Сначала отдельная оценка безопасности: уточнить мысли, намерение, план, доступ к средствам и недавние попытки. Балл не является основанием для автоматической госпитализации; решение о маршруте принимает специалист с учётом состояния и юридических оснований.');
  if (barActive) blocks.push({ id: 'ad_monotherapy', soft: true, text: 'Возможная мания/гипомания или смешанные симптомы: до решения об антидепрессивной монотерапии нужна клиническая оценка. Диагноз БАР не ставится и нормотимик автоматически не предлагается.' });
  if (incomplete) blocks.push({ id: 'withheld', text: 'Анкета заполнена не полностью: пропуск не приравнивается к нулю. Завершить анкету или обсудить ответы с врачом.' });
  else if (lowQuality) blocks.push({ id: 'withheld', text: 'ИКСО ниже 50: данные требуют повторного уточнения. Не использовать как достоверный количественный профиль без разбора; предложить повторное заполнение с доступной помощью или клиническое интервью.' });
  if (f.fast) notes.push(`Нетипичное время: уточнить ответы. Активное время заполнения ниже стартового порога гипотезы (${T.fast_block_seconds} с на блок или медиана менее ${T.fast_median_seconds} с на пункт); это не доказывает недостоверность.`);
  if (f.slow && !f.fast) notes.push('Нетипичное время: уточнить ответы. Долгий ответ может быть связан с чтением, тревогой, паузой, отвлечением или затруднениями интерфейса; вывода о мотиве не делается.');

  const est = prof.dx && prof.dx.code ? prof.dx : null;
  const phq = cur.phq9, hads = cur.hads_a;
  const longEnough = cl.duration === 'gte6m';
  let pathway = null, hypothesis = null;

  if (red) {
    pathway = 'de';
    hypothesis = {
      code: null,
      name: f.severe_dep || f.suicidal
        ? 'Сигнал высокой выраженности депрессивной симптоматики и/или сигнал безопасности: нужна очная оценка. Критерии F32/F33 проверяются врачом, диагноз по сумме не ставится.'
        : 'Сигнал клинической безопасности: нужна очная оценка специалистом.',
      note: 'Сигнал для клинической оценки, не диагноз.'
    };
  } else if (incomplete) {
    pathway = null;
  } else if (est) {
    pathway = est.code.startsWith('F41') || est.code.startsWith('F43') ? 'gad' : /^F3[23]/.test(est.code) ? 'de' : null;
    hypothesis = { code: est.code, name: est.name, note: 'Диагноз установлен врачом.', established: true };
    if (pathway === 'gad' && phq >= T.phq9_screen) notes.push(`Сопутствующая депрессивная симптоматика (PHQ-9 ${phq}): оценить критерии депрессивного эпизода.`);
  } else if (phq >= T.phq9_screen) {
    pathway = 'de';
    hypothesis = { code: null, name: `Депрессивная симптоматика (PHQ-9 ${phq} из 27): оценить критерии депрессивного эпизода`, note: 'Сигнал для клинической оценки, не диагноз и не степень тяжести эпизода.' };
  } else if (hads !== null && hads >= T.hads_a_clinical) {
    pathway = 'gad';
    hypothesis = {
      code: null,
      name: `Клинически значимый сигнал тревоги (HADS-A ${hads} из 21): оценить критерии тревожного расстройства`,
      note: longEnough ? 'Длительность не менее 6 месяцев (по ответу пациента): один из критериев ГТР, остальные проверяет врач.' : 'Длительность не менее 6 месяцев не подтверждена: ГТР по одной сумме не выставляется.'
    };
  } else if ((hads !== null && hads >= T.hads_a_borderline) || phq >= 5) {
    pathway = hads !== null && hads >= T.hads_a_borderline ? 'gad' : 'de';
    hypothesis = { code: null, name: pathway === 'gad' ? `Пограничный/повышенный сигнал тревоги (HADS-A ${hads})` : `Лёгкие симптомы (PHQ-9 ${phq})`, note: 'Сопоставить с функционированием, динамикой, соматикой и интервью.' };
  } else {
    hypothesis = { code: null, name: 'Низкое значение PHQ-9 не исключает клиническую проблему', note: 'Ответы о тревоге доступны врачу для обсуждения.' };
  }

  // ---- этап ведения (КЛК) ----
  let stage = null;
  const rx = ctx.rx || null;
  const ad = prof.treatment && prof.treatment.ad ? prof.treatment.ad : null;
  const failed = Number(prof.treatment && prof.treatment.failed_ad_courses) || 0;
  const key = pathway === 'gad' ? 'hads_a' : 'phq9';

  if (!pathway || (red && !est) || (lowQuality && !est)) {
    stage = null;
  } else if (!est) {
    stage = mkStage(pathway, 0, { reason: 'Диагноз ещё не подтверждён врачом.' });
  } else if (failed >= 2) {
    stage = mkStage(pathway, 4, { reason: `В профиле отмечено ${failed} последовательных курса без эффекта. Подтвердить адекватность каждого по карте или интервью.` });
  } else if (rx) {
    const weeks = (now - rx.started_ts) / (7 * DAY);
    const resp = response(key, cur, ctx.history || [], rx.started_ts);
    if (weeks < T.ad_min_weeks) stage = mkStage(pathway, 1, { title: `Этап 1. Курс Авиандра: ${Math.max(1, Math.ceil(weeks))}-я неделя`, reason: 'Оценка ответа возможна после 4 недель лечения. Контроль приверженности и нежелательных явлений по дневнику.', resp });
    else if (!resp) { stage = null; notes.push('Недостаточно данных для оценки динамики лечения.'); }
    else if (resp.reduction_pct >= T.response_full_pct) stage = mkStage(pathway, 2, { reason: `${key === 'hads_a' ? 'HADS-A' : 'PHQ-9'} снизился на ${resp.reduction_pct}% от исходного (${resp.baseline} → ${resp.latest}). Решение о продолжении принимает врач.`, resp });
    else stage = mkStage(pathway, 3, { reason: resp ? `${key === 'hads_a' ? 'HADS-A' : 'PHQ-9'} ${resp.reduction_pct > 0 ? 'снизился на ' + resp.reduction_pct + '%' : 'не снизился (' + (resp.reduction_pct < 0 ? '+' + Math.abs(resp.reduction_pct) + '%' : '0%') + ')'} от исходного (${resp.baseline} → ${resp.latest}). Проверить диагноз, дозу, длительность, приверженность, переносимость.` : 'Недостаточно данных для оценки динамики.', resp });
  } else if (ad) {
    if (ad.weeks < T.ad_min_weeks) stage = mkStage(pathway, 2, { reason: `${ad.name}: приём менее 4 недель, оценка ответа преждевременна.` });
    else if (ad.response === 'full') stage = mkStage(pathway, 2, { reason: `${ad.name}: ответ достаточный по оценке врача.` });
    else stage = mkStage(pathway, 3, { reason: `${ad.name} ${ad.dose_mg} мг, ${ad.weeks} нед.: ${ad.response === 'intolerant' ? 'непереносимость' : ad.response === 'none' ? 'ответа нет' : 'частичный ответ'}. Остаточные симптомы и переносимость оценивает врач.` });
  } else {
    stage = mkStage(pathway, 1, { reason: 'Диагноз подтверждён, активной лекарственной терапии нет: врач определяет план по актуальной КР.' });
  }

  const non_drug = red || !pathway ? [] : (pathway === 'de' ? PLANS.non_drug.de : PLANS.non_drug.gad);
  return {
    state: red ? 'red' : (incomplete || lowQuality) ? 'invalid' : 'ok',
    pathway, hypothesis, stage, blocks, notes, non_drug,
    scores: { phq9: cur.phq9, hads_a: cur.hads_a, item9: cur.item9, bands: cur.bands, quality: cur.quality }
  };
}

/**
 * Карточка рекомендации по Авиандру для врача (КЛК, модуль лекарственных рекомендаций).
 * Всегда с основанием, источником, статусом и вариантами «подтвердить / изменить / отклонить».
 * state: consider | grey | orange | not_recommended | none
 */
export function aviandrAdvice({ drug, dx, profile, cur, pathway }) {
  const S = PLANS.aviandr_situations;
  const src = `${drug.drug.source} Справочная информация: Vidal (23.07.2026), обязательная сверка с инструкцией ГРЛС.`;
  const base = { source: src, options: [], variants: ['подтвердить', 'изменить', 'отклонить'] };
  const code = dx && dx.code ? dx.code : null;
  const established = !!(profile.dx && profile.dx.code);

  if (drug.contraindications.length || drug.hard_block) {
    const why = [...drug.contraindications, ...drug.interactions.filter((i) => i.hard_block).map((i) => i.text)];
    return { ...base, state: 'not_recommended', key: 'contraindication', title: 'Не рекомендовать Авиандр', text: S.contraindication, basis: why };
  }
  if (!established) {
    if (pathway === 'de') return { ...base, state: 'none', key: 'de_no_anxiety', title: 'Авиандр не рекомендуется автоматически', text: S.de_no_anxiety, basis: ['Преобладает депрессивная симптоматика без подтверждённого тревожного показания'], options: [PLANS.drug_options.de] };
    return { ...base, state: 'grey', key: 'no_dx', title: 'Рекомендация не формируется', text: S.no_dx, basis: [] };
  }
  const isDepr = /^F3[23]/.test(code || '');
  if (isDepr || !drug.indication.match) {
    return { ...base, state: 'none', key: 'de_no_anxiety', title: 'Авиандр не рекомендуется автоматически', text: isDepr ? S.de_no_anxiety : `${S.de_no_anxiety.split(':')[0]}: диагноз не входит в зарегистрированные показания (${drug.indication.label}).`, basis: [drug.indication.label], options: [PLANS.drug_options.de] };
  }
  const ser = drug.interactions.find((i) => i.status === 'orange' && /серотонин/i.test(i.text));
  if (ser) return { ...base, state: 'orange', key: 'serotonergic', title: 'Не рекомендовать автоматически: взаимодействие', text: S.serotonergic, basis: [ser.text, `Препараты пациента: ${ser.meds.join(', ')}`], options: [PLANS.drug_options.gad] };
  if (drug.gaps.length) return { ...base, state: 'grey', key: 'unknown', title: 'Данных недостаточно', text: S.unknown, basis: drug.gaps, options: [PLANS.drug_options.gad] };
  const orange = drug.interactions.find((i) => i.status === 'orange');
  if (orange) return { ...base, state: 'orange', key: 'serotonergic', title: 'Не рекомендовать автоматически: взаимодействие', text: `${orange.text}. ${orange.action}`, basis: [orange.text, `Препараты пациента: ${orange.meds.join(', ')}`] };
  const postCovid = drug.indication.label.includes('COVID');
  return {
    ...base, state: 'consider', key: postCovid ? 'stress_postcovid' : 'gad_confirmed',
    title: 'Рекомендовано рассмотреть Авиандр',
    text: postCovid ? S.stress_postcovid : S.gad_confirmed,
    basis: [`Показание: ${drug.indication.label}`, 'Противопоказания и значимые DDI не выявлены по сведениям, сверенным врачом', 'Решение, подтверждение, изменение или отклонение — за врачом; рецепт не создаётся автоматически'],
    options: [PLANS.drug_options.aviandr, PLANS.drug_options.gad],
    regimen: drug.indication.course || drug.dosing.courses.gad
  };
}
