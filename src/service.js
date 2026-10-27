import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { audit, insertSppvr } from './db.js';
import { SCALES, SPPVR, SPPVR_TOTAL, DRUGS, RULES, T, scoreScale, scoreSppvr, deriveClinical, checkDrug, medClasses, adherence, evaluateAlerts, evaluateReferral } from './engine.js';
import { analyze, aviandrAdvice } from './protocol.js';

import { gameOf } from './game.js';
const DAY = 86400000;
const j = (s) => JSON.parse(s);
const RANK = { red: 3, orange: 2, yellow: 1 };
const CONFIG_FILES = ['sppvr.json', 'plans.json', 'ddi.json', 'drug_aviandr.json', 'rules.json', 'scales.json'];
const confDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');

// Версия конфигурации: хэш справочников (КР, инструкция, взаимодействия, правила). Пишется в журнал решений.
export function configHashes() {
  const out = {};
  for (const f of CONFIG_FILES) out[f] = createHash('sha256').update(readFileSync(join(confDir, f))).digest('hex').slice(0, 12);
  return out;
}

const DECISION_ACTIONS = ['prescription_confirmed', 'prescription_stopped', 'referral_confirmed', 'referral_dismissed', 'protocol_recorded', 'exam_saved', 'med_added', 'med_removed', 'visit_closed', 'alert_ack', 'advice_confirmed', 'advice_dismissed', 'advice_changed'];

export function makeService(db) {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const hashes = configHashes();
  const configVersion = createHash('sha256').update(Object.values(hashes).join('')).digest('hex').slice(0, 10);
  const timings = { recommendation: [], alert_delivery: [], scale_submit: [], sppvr_fill: [] };
  const rec = (k, v) => { timings[k].push(v); if (timings[k].length > 500) timings[k].shift(); };
  const starts = new Map(); // pid -> время начала заполнения СППВР (серверное)

  const patientRow = (pid) => db.prepare('SELECT p.*, u.name, u.login FROM patients p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?').get(pid);

  function bootstrapAlerts() {
    audit(db, null, 'config_loaded', 'system', JSON.stringify({ version: configVersion, ...hashes }));
    const ids = db.prepare('SELECT user_id FROM patients').all().map((r) => r.user_id);
    for (const pid of ids) {
      const rx = activeRx(pid);
      if (!rx) continue;
      const hits = evaluateAlerts({ scales: { phq9: [], gad7: [] }, diary: diaryOf(pid, 30), events: { diary: true }, activeRx: true });
      raiseAlerts(pid, hits);
    }
  }

  function scalesOf(pid) {
    const out = { phq9: [], gad7: [] };
    const rows = db.prepare('SELECT * FROM scale_results WHERE patient_id = ? ORDER BY ts DESC').all(pid);
    for (const r of rows) out[r.scale].push({ id: r.id, ts: r.ts, total: r.total, band: r.band, answers: j(r.answers) });
    return out;
  }
  // Результаты СППВР 2.0: суммы, ИКСО и признаки пересчитываются из сохранённых исходных ответов и времени (исходные ответы не теряются).
  const hydrate = (r) => {
    let answers;
    try { answers = j(r.answers); } catch { return null; }
    if (!Array.isArray(answers) || answers.length !== SPPVR_TOTAL) return null;   // записи старого формата (16 вопросов) не используются
    const extra = r.extra ? j(r.extra) : {};
    const sc = scoreSppvr(answers, { elapsed_sec: r.elapsed_sec, item_sec: extra.item_sec });
    const clinical = extra.clinical || null;
    const cd = clinical ? deriveClinical(clinical) : null;
    const flags = { ...sc.flags, bar: !!(cd && cd.bar), safety_immediate: !!(cd && cd.safety_immediate), unknown_data: !!(cd && cd.unknown_data) };
    return { id: r.id, ts: r.ts, ...sc, flags, clinical, cd, partial: !!extra.partial };
  };
  const sppvrOf = (pid, limit = 50) =>
    db.prepare('SELECT * FROM sppvr_results WHERE patient_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(pid, limit * 2).map(hydrate).filter(Boolean).slice(0, limit);
  const diaryOf = (pid, limit = 60) =>
    db.prepare('SELECT * FROM diary WHERE patient_id = ? ORDER BY ts DESC LIMIT ?').all(pid, limit).map((r) => ({ ...r, side_effects: j(r.side_effects) }));
  const activeRx = (pid) => db.prepare("SELECT * FROM prescriptions WHERE patient_id = ? AND status = 'active' ORDER BY started_ts DESC LIMIT 1").get(pid) || null;
  const openAlerts = (pid) => db.prepare('SELECT * FROM alerts WHERE patient_id = ? AND ack_ts IS NULL ORDER BY created_ts DESC').all(pid);
  const profileOf = (pid) => j(patientRow(pid).profile);
  const adhOf = (diary) => adherence(diary.map((r) => ({ ts: r.ts, doses_taken: r.doses_taken, doses_planned: r.doses_planned })));

  function analysisOf(pid, sppvrList = sppvrOf(pid), profile = profileOf(pid), rx = activeRx(pid)) {
    return analyze(sppvrList[0] || null, { profile, history: sppvrList.slice(1), rx });
  }

  // ---------- алерты ----------
  function raiseAlerts(pid, hits) {
    const created = [];
    const p = patientRow(pid);
    for (const h of hits) {
      const dup = db.prepare('SELECT id FROM alerts WHERE patient_id=? AND rule_id=? AND ack_ts IS NULL').get(pid, h.rule_id);
      if (dup) continue;
      const t0 = Date.now();
      const info = db.prepare('INSERT INTO alerts(patient_id,rule_id,severity,title,details,actions,created_ts) VALUES (?,?,?,?,?,?,?)')
        .run(pid, h.rule_id, h.severity, h.title, h.details, JSON.stringify(h.actions), t0);
      const id = Number(info.lastInsertRowid);
      audit(db, null, 'alert_created', `patient:${pid}`, `alert:${id} ${h.severity} ${h.rule_id}: ${h.details}`);
      if (h.actions.includes('draft_referral')) draftReferral(pid, h);
      const payload = { id, patient_id: pid, patient_name: p.name, severity: h.severity, title: h.title, details: h.details, actions: h.actions, created_ts: t0 };
      const delivered = bus.emit(`doctor:${p.doctor_id}`, { type: 'alert', alert: payload });
      if (delivered) {
        const td = Date.now();
        db.prepare('UPDATE alerts SET delivered_ts=? WHERE id=?').run(td, id);
        rec('alert_delivery', td - t0);
      }
      created.push(id);
    }
    return created;
  }

  function draftReferral(pid, h) {
    const open = db.prepare("SELECT id FROM referrals WHERE patient_id=? AND status='suggested'").get(pid);
    if (open) return;
    const ref = evaluateReferral(referralCtx(pid));
    let reasons = ref.reasons.filter((r) => r.level === 'urgent' || r.level === 'mandatory');
    if (!reasons.length) reasons = [{ id: h.rule_id, level: 'urgent', title: h.title, basis: h.details, action: RULES.routes.urgent.action }];
    const lvl = reasons.some((r) => r.level === 'urgent') ? 'urgent' : 'mandatory';
    db.prepare('INSERT INTO referrals(patient_id,level,status,reasons,created_ts) VALUES (?,?,?,?,?)')
      .run(pid, lvl, 'suggested', JSON.stringify(reasons), Date.now());
  }

  // Статусы алерта: создан → доставлен → прочитан (врач открыл карточку) → действие (взят в работу)
  function markRead(pid, doctorId) {
    const rows = db.prepare('SELECT id FROM alerts WHERE patient_id=? AND read_ts IS NULL').all(pid);
    if (!rows.length) return 0;
    const t = Date.now();
    for (const r of rows) db.prepare('UPDATE alerts SET read_ts=?, delivered_ts=COALESCE(delivered_ts, ?) WHERE id=?').run(t, t, r.id);
    audit(db, doctorId, 'alert_read', `patient:${pid}`, `alerts: ${rows.map((r) => r.id).join(',')}`);
    return rows.length;
  }

  function ackAlert(alertId, doctorId, note) {
    const a = db.prepare('SELECT a.*, p.doctor_id FROM alerts a JOIN patients p ON p.user_id=a.patient_id WHERE a.id=?').get(alertId);
    if (!a || a.doctor_id !== doctorId) return null;
    if (a.ack_ts) return a;
    const t = Date.now();
    db.prepare('UPDATE alerts SET ack_ts=?, ack_by=?, ack_note=?, read_ts=COALESCE(read_ts, ?), action_ts=?, action_note=? WHERE id=?').run(t, doctorId, note || null, t, note ? t : null, note || null, alertId);
    audit(db, doctorId, 'alert_ack', `patient:${a.patient_id}`, `alert:${alertId}${note ? ' / ' + note : ''}`);
    if (a.severity === 'red') {
      db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,1)')
        .run(a.patient_id, 'doctor', 'Врач получил сигнал и свяжется с вами. Если стало хуже, звоните 112.', Date.now());
    }
    return db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
  }

  // Эскалация: красный алерт без подтверждения дольше дедлайна
  function checkEscalation(now = Date.now()) {
    const limit = (Number(process.env.ESCALATE_SEC) || RULES.escalation.ack_deadline_sec) * 1000;
    const rows = db.prepare("SELECT a.*, p.doctor_id FROM alerts a JOIN patients p ON p.user_id=a.patient_id WHERE a.severity='red' AND a.ack_ts IS NULL AND a.escalated=0 AND a.created_ts < ?").all(now - limit);
    for (const a of rows) {
      db.prepare('UPDATE alerts SET escalated=1 WHERE id=?').run(a.id);
      audit(db, null, 'alert_escalated', `patient:${a.patient_id}`, `alert:${a.id} не подтверждён врачом в срок`);
      bus.emit(`doctor:${a.doctor_id}`, { type: 'escalation', alert_id: a.id, title: a.title, patient_id: a.patient_id });
    }
    return rows.length;
  }

  // ---------- контексты ----------
  // Данные для рекомендации по лекарству не сверены: неполный список лекарств, неизвестные сведения или подтверждённый диагноз без сверки списка
  function medsUnverified(profile, last) {
    const ex = profile.exam || {};
    if (ex.meds_reconciled) return false;
    const aviCodes = DRUGS.aviandr.indications.flatMap((i) => i.codes);
    return !!(last && last.cd && last.cd.unknown_data) || !!(profile.dx && profile.dx.code && aviCodes.includes(profile.dx.code));
  }
  function referralCtx(pid, over = {}) {
    const diary = diaryOf(pid, 30);
    const profile = over.profile || profileOf(pid);
    const sppvrList = over.sppvrList || sppvrOf(pid, 10);
    return { profile, scales: over.scales || scalesOf(pid), sppvrList, activeRx: over.rx !== undefined ? over.rx : activeRx(pid), adherence: adhOf(diary),
      openCritical: openAlerts(pid).some((a) => a.severity === 'red'), medsUnverified: medsUnverified(profile, sppvrList[0]) };
  }

  // ---------- сводка изменений с прошлого визита ----------
  function summaryOf(pid, sppvrList, scales, diary) {
    const cur = sppvrList[0];
    if (!cur) return null;
    const lastVisit = db.prepare('SELECT * FROM visits WHERE patient_id=? ORDER BY ts DESC LIMIT 1').get(pid) || null;
    const prev = lastVisit ? sppvrList.find((s) => s.ts <= lastVisit.ts + 60000) : sppvrList[1];
    const since = lastVisit ? lastVisit.ts : (prev ? prev.ts : 0);
    if (!prev || prev.id === cur.id) return { since_ts: since || null, prev: null, cur_ts: cur.ts, note: 'Первичное заполнение: сравнивать пока не с чем.' };
    const d = (a, b) => ({ from: a, to: b, delta: b - a });
    const items = [];
    SPPVR.questions.forEach((q, i) => {
      if (q.kind === 'attention' || q.kind === 'anchor') return;
      if (prev.answers[i] !== cur.answers[i] && prev.answers[i] !== null && cur.answers[i] !== null) {
        const label = q.options;
        const t = (v) => (label.find((o) => o.v === v) || {}).t;
        const hv = (k, v) => (q.reverse ? 3 - v : v);
        items.push({ id: q.id, dir: q.kind === 'hads' ? q.domain : q.text, tag: q.tag, from: t(prev.answers[i]), to: t(cur.answers[i]), delta: hv(0, cur.answers[i]) - hv(0, prev.answers[i]), block: q.block });
      }
    });
    const g = scales.gad7;
    const gCur = g[0] || null;
    const gPrev = g.find((s) => s.ts <= since + 60000) || null;
    const dsince = diary.filter((r) => r.ts > since);
    const se = {};
    for (const r of dsince) for (const e of r.side_effects) se[e] = (se[e] || 0) + 1;
    const prevAdv = {};
    for (const r of diary.filter((x) => x.ts <= since)) for (const e of r.side_effects) prevAdv[e] = 1;
    const alertsSince = db.prepare('SELECT severity, COUNT(*) c FROM alerts WHERE patient_id=? AND created_ts > ? GROUP BY severity').all(pid, since);
    const msgs = db.prepare("SELECT COUNT(*) c FROM messages WHERE patient_id=? AND from_role='patient' AND ts > ?").get(pid, since).c;
    return {
      since_ts: since, last_visit: lastVisit, prev_ts: prev.ts, cur_ts: cur.ts,
      scores: { hads_a: prev.hads_a !== null && cur.hads_a !== null ? d(prev.hads_a, cur.hads_a) : null, phq9: prev.phq9 !== null && cur.phq9 !== null ? d(prev.phq9, cur.phq9) : null },
      gad7: gCur && gPrev && gCur.id !== gPrev.id ? d(gPrev.total, gCur.total) : null,
      items, prev_answers: prev.answers, cur_answers: cur.answers,
      adherence_since: dsince.length ? adhOf(dsince.map((r) => ({ ...r, doses_planned: r.doses_planned }))) : null,
      new_side_effects: Object.entries(se).filter(([n]) => !prevAdv[n]).map(([name, count]) => ({ name, count })),
      side_effects_since: Object.entries(se).map(([name, count]) => ({ name, count })),
      alerts_since: alertsSince, messages_since: msgs
    };
  }

  // ---------- карточка врача ----------
  function buildCard(pid) {
    const t0 = performance.now();
    const p = patientRow(pid);
    const profile = j(p.profile);
    const meds = j(p.meds);
    const scales = scalesOf(pid);
    const sppvrList = sppvrOf(pid);
    const diary = diaryOf(pid);
    const rx = activeRx(pid);
    const an = analysisOf(pid, sppvrList, profile, rx);
    const dx = profile.dx && profile.dx.code ? profile.dx : null;   // только диагноз, установленный врачом
    const drug = checkDrug('aviandr', profile, meds, dx);
    const advice = aviandrAdvice({ drug, dx, profile, cur: sppvrList[0] || null, pathway: an.pathway });
    const ex = profile.exam || {};
    // Жёсткий стоп только по проверенному ИМАО-противопоказанию; остальное — предупреждения, решение врача с обоснованием
    const prescribe_blocked = drug.hard_block ? 'ddi' : null;
    const holds = [];
    if (an.blocks.some((b) => b.id === 'ad_monotherapy')) holds.push('Возможная мания/гипомания (C5): до решения об антидепрессивной монотерапии нужна клиническая оценка.');
    if (openAlerts(pid).some((a) => a.severity === 'red')) holds.push('Открыт красный алерт: сначала оценка безопасности и действие по сигналу.');
    if (ex.somatic) holds.push('Выраженная соматическая патология: сначала оценка соматической причины и консультация профильного специалиста.');
    if (['orange', 'grey', 'none'].includes(advice.state)) holds.push(advice.title + '.');
    const soft_hold = holds.length ? holds.join(' ') + ' Подтверждение возможно только с письменным обоснованием врача.' : null;
    const ref = evaluateReferral(referralCtx(pid, { profile, scales, sppvrList, rx }));
    const decided = db.prepare('SELECT * FROM referrals WHERE patient_id=? ORDER BY created_ts DESC LIMIT 1').get(pid);
    const adverse = {};
    for (const r of diary) for (const e of r.side_effects) adverse[e] = (adverse[e] || 0) + 1;
    const alerts = db.prepare('SELECT a.*, u.name AS ack_name FROM alerts a LEFT JOIN users u ON u.id=a.ack_by WHERE a.patient_id=? ORDER BY a.created_ts DESC LIMIT 30').all(pid);
    const decisions = db.prepare(`SELECT a.ts, a.action, a.detail, u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity=? AND a.action IN (${DECISION_ACTIONS.map(() => '?').join(',')}) ORDER BY a.id DESC LIMIT 40`).all(`patient:${pid}`, ...DECISION_ACTIONS);
    const card = {
      patient: { id: pid, name: p.name, source: p.source, profile, meds },
      scales, sppvr: sppvrList.slice(0, 12), analysis: an, clinical: sppvrList[0] && sppvrList[0].clinical ? { raw: sppvrList[0].clinical, derived: sppvrList[0].cd, ts: sppvrList[0].ts } : null,
      summary: summaryOf(pid, sppvrList, scales, diary),
      diary,
      adherence: adhOf(diary),
      adverse_events: Object.entries(adverse).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      prescriptions: db.prepare('SELECT * FROM prescriptions WHERE patient_id=? ORDER BY started_ts DESC').all(pid),
      recommendation: {
        drug, advice, has_active: !!rx, prescribe_blocked, soft_hold,
        recommended: advice.state === 'consider' && !prescribe_blocked && !an.blocks.some((b) => b.id === 'withheld'),
        dx_used: dx
      },
      referral: { ...ref, record: decided || null },
      alerts, decisions, protocols: db.prepare('SELECT pr.*, u.name FROM protocols pr JOIN users u ON u.id=pr.doctor_id WHERE pr.patient_id=? ORDER BY pr.ts DESC').all(pid).map((r) => ({ ...r, criteria: j(r.criteria) })),
      visits: db.prepare('SELECT v.*, u.name FROM visits v JOIN users u ON u.id=v.doctor_id WHERE v.patient_id=? ORDER BY v.ts DESC LIMIT 10').all(pid),
      messages: db.prepare('SELECT * FROM messages WHERE patient_id=? ORDER BY ts ASC').all(pid),
      config_version: configVersion
    };
    rec('recommendation', Math.round((performance.now() - t0) * 10) / 10);
    return card;
  }

  function listForDoctor(doctorId) {
    const ids = db.prepare('SELECT user_id FROM patients WHERE doctor_id=?').all(doctorId).map((r) => r.user_id);
    return ids.map((pid) => {
      const p = patientRow(pid);
      const profile = j(p.profile);
      const scales = scalesOf(pid);
      const sp = sppvrOf(pid, 10);
      const oa = openAlerts(pid);
      const diary = diaryOf(pid, 30);
      const rx = activeRx(pid);
      const an = analysisOf(pid, sp, profile, rx);
      const ref = evaluateReferral(referralCtx(pid, { profile, scales, sppvrList: sp, rx }));
      const worst = oa.reduce((m, a) => Math.max(m, RANK[a.severity] || 0), 0);
      const state = an.state === 'red' ? 3 : worst;
      return {
        id: pid, name: p.name, age: profile.age, sex: profile.sex, source: p.source,
        dx: profile.dx && profile.dx.code ? profile.dx : null,
        hypothesis: an.hypothesis ? { code: an.hypothesis.code, name: an.hypothesis.name } : null,
        sppvr: sp[0] ? { ts: sp[0].ts, phq9: sp[0].phq9, hads_a: sp[0].hads_a, ikso: sp[0].quality.score } : null,
        gad7: scales.gad7[0] ? scales.gad7[0].total : null,
        on_therapy: !!rx, adherence: adhOf(diary).pct, referral: ref.level,
        color: ['none', 'yellow', 'orange', 'red'][state],
        open_alerts: oa.map((a) => ({ id: a.id, severity: a.severity, title: a.title, created_ts: a.created_ts, escalated: !!a.escalated }))
      };
    }).sort((a, b) => (RANK[b.color] || 0) - (RANK[a.color] || 0) || b.open_alerts.length - a.open_alerts.length);
  }

  // ---------- действия врача (только по подтверждению) ----------
  function confirmPrescription(pid, doctorId, b = {}) {
    const card = buildCard(pid);
    const r = card.recommendation;
    const st = r.drug.status;
    if (r.has_active) return { error: 'already_active' };
    if (r.prescribe_blocked) return { error: 'blocked_' + r.prescribe_blocked };
    if (r.drug.ddi_level === 'yellow' && !b.ddi_ack) return { error: 'ddi_ack_required' };
    const need = st === 'contraindicated' || st === 'off_label' || st === 'unverified' || !!r.soft_hold || ['orange', 'grey'].includes(r.drug.ddi_level) || r.advice.state !== 'consider';
    if (need && !(b.override_reason && String(b.override_reason).trim().length >= 10)) return { error: 'override_required' };
    const id = Number(db.prepare('INSERT INTO prescriptions(patient_id,drug,status,started_ts,confirmed_by,override_reason) VALUES (?,?,?,?,?,?)')
      .run(pid, 'aviandr', 'active', Date.now(), doctorId, b.override_reason || null).lastInsertRowid);
    audit(db, doctorId, 'prescription_confirmed', `patient:${pid}`, `Авиандр; статус ${st}; DDI ${r.drug.ddi_level}; рекомендация СППВР: ${r.advice.state}/${r.advice.key}${b.override_reason ? '; обоснование: ' + b.override_reason : ''}; конфигурация ${configVersion}`);
    return { id };
  }
  function stopPrescription(pid, rid, doctorId) {
    const r = db.prepare("UPDATE prescriptions SET status='stopped', stopped_ts=? WHERE id=? AND patient_id=? AND status='active'").run(Date.now(), rid, pid);
    if (r.changes) audit(db, doctorId, 'prescription_stopped', `patient:${pid}`, `rx:${rid}`);
    return r.changes > 0;
  }
  function decideReferral(pid, doctorId, { action, comment }) {
    const ref = evaluateReferral(referralCtx(pid));
    if (ref.level === 'none' && action === 'confirm') return { error: 'no_basis' };
    let row = db.prepare("SELECT * FROM referrals WHERE patient_id=? AND status='suggested' ORDER BY created_ts DESC LIMIT 1").get(pid);
    if (!row) {
      const id = Number(db.prepare('INSERT INTO referrals(patient_id,level,status,reasons,created_ts) VALUES (?,?,?,?,?)').run(pid, ref.level, 'suggested', JSON.stringify(ref.reasons), Date.now()).lastInsertRowid);
      row = { id };
    }
    const status = action === 'confirm' ? 'confirmed' : 'dismissed';
    db.prepare('UPDATE referrals SET status=?, comment=?, decided_by=?, decided_ts=?, level=? WHERE id=?').run(status, comment || null, doctorId, Date.now(), ref.level, row.id);
    audit(db, doctorId, `referral_${status}`, `patient:${pid}`, `${ref.level}${comment ? ' / ' + comment : ''}`);
    if (status === 'confirmed') {
      db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,1)')
        .run(pid, 'doctor', ref.level === 'urgent' || ref.level === 'mandatory' ? 'Врач организует для вас дополнительную оценку. Детали вам сообщат.' : 'Врач рекомендует дополнительную консультацию. Детали вам сообщат на приёме или в этом чате.', Date.now());
    }
    return { status };
  }

  const CONSENT = {
    voluntary: 'Госпитализация по добровольному согласию пациента (оформить форму информированного добровольного согласия)',
    involuntary: 'Недобровольная госпитализация по ст. 29 Закона РФ «О психиатрической помощи и гарантиях прав граждан при её оказании» (оформить документы, уведомить суд в установленный срок)',
    declined: 'Пациент отказывается от госпитализации: оценить основания ст. 29 (непосредственная опасность, беспомощность, существенный вред здоровью), вызвать специализированную бригаду'
  };
  function recordProtocol(pid, doctorId, b = {}) {
    if (!CONSENT[b.consent]) return { error: 'bad_consent' };
    const criteria = { danger: !!b.danger, helpless: !!b.helpless, deterioration: !!b.deterioration };
    if (b.consent === 'involuntary' && !(criteria.danger || criteria.helpless || criteria.deterioration)) return { error: 'basis_required' };
    const t = Date.now();
    const id = Number(db.prepare('INSERT INTO protocols(patient_id,doctor_id,ts,criteria,consent,route,comment) VALUES (?,?,?,?,?,?,?)')
      .run(pid, doctorId, t, JSON.stringify(criteria), b.consent, CONSENT[b.consent], b.comment ? String(b.comment).slice(0, 1000) : null).lastInsertRowid);
    audit(db, doctorId, 'protocol_recorded', `patient:${pid}`, `${b.consent}; критерии: ${JSON.stringify(criteria)}${b.comment ? '; ' + b.comment : ''}`);
    // оформление протокола подтверждает обязательный маршрут
    const open = db.prepare("SELECT id FROM referrals WHERE patient_id=? AND status='suggested' ORDER BY created_ts DESC LIMIT 1").get(pid);
    if (open) db.prepare("UPDATE referrals SET status='confirmed', decided_by=?, decided_ts=?, comment=? WHERE id=?").run(doctorId, t, 'Протокол оценки показаний к госпитализации оформлен', open.id);
    db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,1)')
      .run(pid, 'doctor', 'Врач организует для вас специализированную помощь. Если стало хуже, звоните 112.', t);
    return { id, route: CONSENT[b.consent] };
  }

  // Осмотр врача: отметки, которых нет в опроснике (психотические симптомы, исключение БАР, соматика)
  function saveExam(pid, doctorId, b = {}) {
    const p = patientRow(pid);
    const profile = j(p.profile);
    const ex = { ...(profile.exam || {}) };
    for (const k of ['psychotic', 'bar_excluded', 'somatoform', 'arrhythmia', 'meds_reconciled']) if (k in b) ex[k] = !!b[k];
    // диагноз и клинический контекст устанавливает врач; система его не выставляет
    const DX = { F41_1: { code: 'F41.1', name: 'Генерализованное тревожное расстройство' }, F43_2: { code: 'F43.2', name: 'Стрессовая реакция / нарушение адаптации' }, F32: { code: 'F32', name: 'Депрессивный эпизод' }, F33: { code: 'F33', name: 'Рекуррентное депрессивное расстройство' } };
    if ('dx' in b) profile.dx = DX[b.dx] || null;
    if ('post_covid' in b) {
      const set = new Set(profile.conditions || []);
      if (b.post_covid) set.add('post_covid'); else set.delete('post_covid');
      profile.conditions = [...set];
    }
    if ('tsh' in b) { const v = Number(b.tsh); ex.tsh = Number.isFinite(v) && b.tsh !== '' && b.tsh !== null ? v : null; }
    ex.somatic = (typeof ex.tsh === 'number' && ex.tsh > T.tsh_severe) || !!ex.arrhythmia;
    profile.exam = ex;
    db.prepare('UPDATE patients SET profile=? WHERE user_id=?').run(JSON.stringify(profile), pid);
    audit(db, doctorId, 'exam_saved', `patient:${pid}`, JSON.stringify(ex));
    const hits = evaluateAlerts({ scales: scalesOf(pid), sppvr: sppvrOf(pid, 1)[0] || null, profile, diary: [], events: {}, fresh: 'exam', activeRx: !!activeRx(pid) });
    raiseAlerts(pid, hits);
    return { exam: ex };
  }

  // Решение врача по рекомендации «Авиандр»: подтвердить, изменить или отклонить, с причиной. Рецепт этим не создаётся.
  function recordAdvice(pid, doctorId, b = {}) {
    const map = { confirm: 'advice_confirmed', change: 'advice_changed', dismiss: 'advice_dismissed' };
    const action = map[b.action];
    if (!action) return { error: 'bad_action' };
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (action !== 'advice_confirmed' && reason.length < 3) return { error: 'reason_required' };
    const adv = buildCard(pid).recommendation.advice || {};
    audit(db, doctorId, action, `patient:${pid}`, JSON.stringify({ state: adv.state, key: adv.key, reason }));
    return { ok: true, action };
  }

  function addMed(pid, doctorId, name) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) return { error: 'empty' };
    const meds = j(patientRow(pid).meds);
    const c = medClasses(n);
    meds.push({ name: n, classes: c.classes, known: c.known });
    db.prepare('UPDATE patients SET meds=? WHERE user_id=?').run(JSON.stringify(meds), pid);
    audit(db, doctorId, 'med_added', `patient:${pid}`, `${n}; классы: ${c.classes.join(',') || 'не найден в справочнике'}`);
    return { known: c.known, classes: c.classes };
  }
  function removeMed(pid, doctorId, idx) {
    const meds = j(patientRow(pid).meds);
    if (!meds[idx]) return false;
    const [m] = meds.splice(idx, 1);
    db.prepare('UPDATE patients SET meds=? WHERE user_id=?').run(JSON.stringify(meds), pid);
    audit(db, doctorId, 'med_removed', `patient:${pid}`, m.name);
    return true;
  }
  function closeVisit(pid, doctorId, note) {
    db.prepare('INSERT INTO visits(patient_id,doctor_id,ts,note) VALUES (?,?,?,?)').run(pid, doctorId, Date.now(), note ? String(note).slice(0, 1000) : null);
    audit(db, doctorId, 'visit_closed', `patient:${pid}`, note || null);
    return { ok: true };
  }

  // ---------- действия пациента ----------
  function submitScale(pid, scaleId, answers) {
    const t0 = performance.now();
    const res = scoreScale(scaleId, answers);
    const ts = Date.now();
    db.prepare('INSERT INTO scale_results(patient_id,scale,answers,total,band,ts) VALUES (?,?,?,?,?,?)').run(pid, scaleId, JSON.stringify(answers), res.total, res.band, ts);
    audit(db, pid, 'scale_submitted', `patient:${pid}`, `${scaleId}=${res.total}`);
    const hits = evaluateAlerts({ scales: scalesOf(pid), diary: [], events: {}, fresh: scaleId, activeRx: !!activeRx(pid) });
    const ids = raiseAlerts(pid, hits);
    notifyResult(pid, SCALES[scaleId].name);
    rec('scale_submit', Math.round((performance.now() - t0) * 10) / 10);
    return { ...res, alert: ids.length > 0 };
  }

  function notifyResult(pid, what) {
    const p = patientRow(pid);
    bus.emit(`doctor:${p.doctor_id}`, { type: 'result', patient_id: pid, patient_name: p.name, what });
  }

  function sppvrStart(pid) { starts.set(pid, Date.now()); return { ok: true }; }

  // Сохраняем первые 9 ответов и создаём сигнал до завершения анкеты.
  // Токен делает повтор после потери HTTP-ответа идемпотентным.
  function submitEarlySafety(pid, input = {}) {
    const { token, answers, item_sec: itemSec, elapsed_sec: elapsed } = input;
    if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(token) ||
        !Array.isArray(answers) || answers.length !== SPPVR_TOTAL ||
        !Number.isInteger(answers[8]) || answers[8] <= 0 ||
        answers.slice(9).some((v) => v !== null)) throw new Error('bad_answers');
    const scored = scoreSppvr(answers, null); // проверяет все значения до записи
    const existing = db.prepare("SELECT id, answers FROM sppvr_results WHERE patient_id=? AND json_extract(extra,'$.early_token')=?").get(pid, token);
    if (existing) {
      if (existing.answers !== JSON.stringify(answers)) throw new Error('token_conflict');
      return { ok: true, alert: true, safety_question: true, partial: true };
    }
    const sec = Array.isArray(itemSec) && itemSec.length === SPPVR_TOTAL
      ? itemSec.map((v) => Number.isFinite(v) && v >= 0 ? Math.min(v, 3600) : null) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertSppvr(db, pid, answers, { elapsed_sec: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null, item_sec: sec }, null);
      const row = db.prepare('SELECT id, extra FROM sppvr_results WHERE patient_id=? ORDER BY id DESC LIMIT 1').get(pid);
      const extra = { ...j(row.extra), partial: true, early_token: token };
      db.prepare('UPDATE sppvr_results SET extra=? WHERE id=?').run(JSON.stringify(extra), row.id);
      audit(db, pid, 'sppvr_partial_safety', `patient:${pid}`, 'Ответ на пункт 9 сохранён; остальные вопросы не завершены.');
      const cur = { ...scored, ts: Date.now() };
      const hits = evaluateAlerts({ scales: scalesOf(pid), sppvr: cur, profile: profileOf(pid), diary: [], events: {}, fresh: 'sppvr', activeRx: !!activeRx(pid) });
      raiseAlerts(pid, hits);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notifyResult(pid, 'Незавершённый опросник');
    starts.delete(pid);
    return { ok: true, alert: true, safety_question: true, partial: true };
  }

  /**
   * Приём СППВР 2.0. answers: 20 значений 0–3 (null = пропуск пункта: суммы и ИКСО не считаются).
   * Время: серверное общее; по пунктам — активное время вкладки, присланное клиентом (item_sec).
   */
  function submitSppvr(pid, answers, clientElapsed = null, itemSec = null, token = null) {
    const t0 = performance.now();
    if (token !== null && (typeof token !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(token))) throw new Error('bad_token');
    if (token) {
      const prior = db.prepare("SELECT answers, extra FROM sppvr_results WHERE patient_id=? AND json_extract(extra,'$.submission_token')=?").get(pid, token);
      if (prior) {
        if (prior.answers !== JSON.stringify(answers)) throw new Error('token_conflict');
        const response = j(prior.extra).submission_response;
        if (!response) throw new Error('missing_response');
        return response;
      }
    }
    scoreSppvr(answers, null);
    const st = starts.get(pid);
    starts.delete(pid);
    const elapsed = st ? Math.round((Date.now() - st) / 100) / 10 : (Number.isFinite(Number(clientElapsed)) && clientElapsed !== null ? Number(clientElapsed) : null);
    const itemClean = Array.isArray(itemSec) && itemSec.length === SPPVR_TOTAL ? itemSec.map((x) => (Number.isFinite(Number(x)) && x !== null ? Math.max(0, Math.min(3600, Number(x))) : null)) : null;
    // Активное время клиента не может превышать серверное общее время (защита от подмены)
    const active = itemClean && elapsed !== null && itemClean.reduce((a, x) => a + (x || 0), 0) > elapsed * 1.05 + 2 ? null : itemClean;
    let r, response;
    db.exec('BEGIN IMMEDIATE');
    try {
    r = insertSppvr(db, pid, answers, { elapsed_sec: elapsed, item_sec: active }, null);
    const inserted = db.prepare('SELECT id,extra FROM sppvr_results WHERE patient_id=? ORDER BY id DESC LIMIT 1').get(pid);
    const ts = Date.now();
    audit(db, pid, 'sppvr_submitted', `patient:${pid}`, `PHQ-9=${r.phq9 ?? 'н/д'} HADS-A=${r.hads_a ?? 'н/д'} ИКСО=${r.quality.score ?? 'н/д'}${elapsed !== null ? ' t=' + elapsed + 'с' : ''}; шкалы ${SPPVR.version}`);
    const cur = sppvrOf(pid, 1)[0];
    const hits = evaluateAlerts({ scales: scalesOf(pid), sppvr: cur, profile: profileOf(pid), diary: [], events: {}, fresh: 'sppvr', activeRx: !!activeRx(pid) });
    raiseAlerts(pid, hits);
    response = { ok: true, elapsed_sec: elapsed, alert: hits.some((h) => h.severity === 'red') || openAlerts(pid).some((a) => a.severity === 'red'), safety_question: !!r.flags.suicidal, retry_suggested: r.flags.quality_low };
    if (token) {
      const extra = { ...j(inserted.extra), submission_token: token, submission_response: response };
      db.prepare('UPDATE sppvr_results SET extra=? WHERE id=?').run(JSON.stringify(extra), inserted.id);
    }
    db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (elapsed !== null) rec('sppvr_fill', elapsed);
    notifyResult(pid, 'СППВР');
    rec('scale_submit', Math.round((performance.now() - t0) * 10) / 10);
    return response;
  }

  const CLIN_KEYS = ['duration', 'functioning', 'meds_status', 'adverse', 'mania', 'somatic_hx', 'safety', 'pregnancy', 'alcohol', 'substances', 'nicotine', 'organ'];
  /**
   * Клинический контекст (C1–C12): сохраняется вместе с последним результатом СППВР, в суммы не входит.
   * «Не знаю / не отвечаю» сохраняются как неизвестное и никогда не превращаются в отрицательный ответ.
   */
  function submitClinical(pid, input = {}) {
    const row = db.prepare('SELECT * FROM sppvr_results WHERE patient_id=? ORDER BY ts DESC, id DESC LIMIT 1').get(pid);
    if (!row || !hydrate(row)) return { error: 'no_sppvr' };
    const cfg = SPPVR.clinical;
    if ('safety' in input && !cfg.safety.options.some((o) => o.v === input.safety)) return { error: 'bad_safety' };
    const prev = (row.extra ? j(row.extra).clinical : null) || {};
    const c = { ...prev };
    for (const k of CLIN_KEYS) {
      if (!(k in input)) continue;
      const v = input[k];
      const allowed = [...(cfg[k].options || []), ...(cfg[k].exclusive || [])].map((o) => o.v);
      if (cfg[k].multi) {
        const arr = Array.isArray(v) ? v.filter((x) => allowed.includes(x)) : [];
        c[k] = arr;
      } else if (allowed.includes(v)) c[k] = v;
    }
    if ('meds' in input && Array.isArray(input.meds)) {
      c.meds = input.meds.slice(0, 20).map((m) => ({
        name: String(m.name || '').trim().slice(0, 80), purpose: String(m.purpose || '').slice(0, 120), dose: String(m.dose || '').slice(0, 60),
        freq: String(m.freq || '').slice(0, 60), started: String(m.started || '').slice(0, 40), last_dose: String(m.last_dose || '').slice(0, 40),
        missed7: String(m.missed7 || '').slice(0, 40), prescribed: ['yes', 'no', 'unknown'].includes(m.prescribed) ? m.prescribed : 'unknown', prn: !!m.prn
      }));
    }
    for (const k of ['adverse_text', 'mania_text', 'other_text']) if (typeof input[k] === 'string') c[k] = input[k].slice(0, 500);
    c.ts = Date.now();
    const extra = row.extra ? j(row.extra) : {};
    extra.clinical = c;
    const d = deriveClinical(c);
    const flags = { ...j(row.flags), bar: d.bar, safety_immediate: d.safety_immediate, unknown_data: d.unknown_data };
    db.prepare('UPDATE sppvr_results SET extra=?, flags=? WHERE id=?').run(JSON.stringify(extra), JSON.stringify(flags), row.id);
    // профиль и список лекарств для проверки DDI: что пациент сообщил, помечается источником «со слов пациента»
    const p = patientRow(pid);
    const profile = j(p.profile);
    if (d.pregnant) profile.pregnant = true;
    if (d.lactating) profile.lactating = true;
    profile.pregnancy_unknown = d.pregnancy_unknown;
    if (d.alcohol_regular) profile.alcohol = true;
    profile.conditions = [...new Set([...(profile.conditions || []), ...d.conditions])];
    profile.reported = { by: 'patient', ts: c.ts };
    const meds = j(p.meds).filter((m) => m.source !== 'patient');
    for (const m of c.meds || []) {
      if (!m.name) { meds.push({ name: 'Название неизвестно' + (m.purpose ? ` (${m.purpose})` : ''), classes: [], known: false, source: 'patient' }); continue; }
      const cl = medClasses(m.name);
      meds.push({ name: m.name + (m.dose ? ' ' + m.dose : ''), classes: cl.classes, known: cl.known, source: 'patient' });
    }
    if (['dont_know_name', 'dont_remember', 'discuss'].includes(c.meds_status) && !(c.meds || []).length) meds.push({ name: 'Приём лекарств сообщён, названия неизвестны', classes: [], known: false, source: 'patient' });
    db.prepare('UPDATE patients SET profile=?, meds=? WHERE user_id=?').run(JSON.stringify(profile), JSON.stringify(meds), pid);
    audit(db, pid, 'clinical_submitted', `patient:${pid}`, `поля: ${Object.keys(input).filter((k) => CLIN_KEYS.includes(k) || k === 'meds').join(',')}; неизвестные сведения: ${d.unknown_data ? 'да' : 'нет'}`);
    const cur = sppvrOf(pid, 1)[0];
    const hits = evaluateAlerts({ scales: scalesOf(pid), sppvr: cur, profile, diary: [], events: {}, fresh: 'clinical', activeRx: !!activeRx(pid) });
    const ids = raiseAlerts(pid, hits);
    notifyResult(pid, 'Сведения о здоровье');
    return { ok: true, alert: hits.some((h) => h.severity === 'red') && ids.length > 0, unknown_data: d.unknown_data };
  }

  function submitDiary(pid, d) {
    const rx = activeRx(pid);
    const planned = rx ? DRUGS[rx.drug].dosing.doses_per_day : 0;
    const taken = planned ? Math.max(0, Math.min(planned, Number(d.doses_taken) || 0)) : 0;
    const se = Array.isArray(d.side_effects) ? d.side_effects.map(String).slice(0, 20) : [];
    const clamp = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
    db.prepare('INSERT INTO diary(patient_id,ts,mood,anxiety,sleep_hours,doses_taken,doses_planned,side_effects,note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(pid, Date.now(), clamp(d.mood, 0, 10), clamp(d.anxiety, 0, 10), clamp(d.sleep_hours, 0, 24), taken, planned, JSON.stringify(se), d.note ? String(d.note).slice(0, 1000) : null);
    audit(db, pid, 'diary_submitted', `patient:${pid}`, null);
    const hits = evaluateAlerts({ scales: scalesOf(pid), diary: diaryOf(pid, 30), events: { adverse: se, diary: true }, activeRx: !!rx });
    return { alert: raiseAlerts(pid, hits).length > 0 };
  }

  function sos(pid) {
    const hits = evaluateAlerts({ scales: scalesOf(pid), diary: [], events: { sos: true }, activeRx: !!activeRx(pid) });
    audit(db, pid, 'sos', `patient:${pid}`, null);
    return { alert: raiseAlerts(pid, hits).length > 0 };
  }

  function postMessage(pid, role, text) {
    db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,0)').run(pid, role, String(text).slice(0, 2000), Date.now());
    audit(db, role === 'patient' ? pid : null, 'message', `patient:${pid}`, role);
    if (role === 'patient') {
      const p = patientRow(pid);
      bus.emit(`doctor:${p.doctor_id}`, { type: 'message', patient_id: pid, patient_name: p.name });
    }
  }

  function patientHome(pid) {
    const p = patientRow(pid);
    const scales = scalesOf(pid);
    const sp = sppvrOf(pid, 10);
    const diary = diaryOf(pid, 30);
    const rx = activeRx(pid);
    const red = openAlerts(pid).filter((a) => a.severity === 'red');
    const last = db.prepare("SELECT * FROM alerts WHERE patient_id=? AND severity='red' ORDER BY created_ts DESC LIMIT 1").get(pid);
    const doctor = db.prepare('SELECT name, specialty FROM users WHERE id=?').get(p.doctor_id);
    const safety = red.length ? { status: red[0].ack_ts ? 'acknowledged' : 'delivered' } : (last && Date.now() - last.created_ts < DAY && last.ack_ts ? { status: 'acknowledged' } : null);
    return {
      name: p.name,
      sex: (j(p.profile) || {}).sex || null,
      doctor,
      game: gameOf({ sppvr: db.prepare("SELECT COUNT(*) c FROM sppvr_results WHERE patient_id=? AND COALESCE(json_extract(extra,'$.partial'),0)=0").get(pid).c, scale: Object.values(scales).reduce((a, x) => a + x.length, 0) }, diaryOf(pid, 400).map((r) => r.ts)),
      therapy: rx ? { drug: DRUGS[rx.drug].name, regimen: DRUGS[rx.drug].dosing.regimen, started_ts: rx.started_ts } : null,
      sppvr: {
        title: SPPVR.title,
        total: SPPVR_TOTAL,
        // Только результаты полных шкал: hydrate пересчитывает их по сохранённым ответам.
        // Пропуск остаётся null; технические индикаторы и флаги пациенту не передаются.
        history: sp.filter((r) => !r.partial).map((r) => ({ ts: r.ts, phq9: r.phq9 })).reverse(),
        due: !sp.find((r) => !r.partial) || Date.now() - sp.find((r) => !r.partial).ts > 14 * DAY,
        early_pending: !!(sp[0] && sp[0].partial && !(sp[0].clinical && sp[0].clinical.safety)),
        clinical_done: !!(sp[0] && sp[0].clinical),
        female: (j(p.profile) || {}).sex === 'Ж'
      },
      scales: Object.keys(SCALES).map((id) => ({
        id, name: SCALES[id].name, title: SCALES[id].title, purpose: SCALES[id].purpose, max: SCALES[id].max,
        history: scales[id].map((r) => ({ ts: r.ts, total: r.total, band: r.band })).reverse(),
        due: !scales[id][0] || Date.now() - scales[id][0].ts > 14 * DAY
      })),
      diary: diary.slice(0, 14).map((r) => ({ ts: r.ts, mood: r.mood, anxiety: r.anxiety, sleep_hours: r.sleep_hours })).reverse(),
      adherence: adhOf(diary),
      side_effects: DRUGS.aviandr.adverse_events,
      severe_events: RULES.alert_rules.find((r) => r.id === 'severe_adverse_event').params.events,
      safety: safety ? { ...safety, ...RULES.safety } : null,
      emergency: RULES.safety,
      messages: db.prepare('SELECT * FROM messages WHERE patient_id=? ORDER BY ts ASC').all(pid)
    };
  }

  function metrics() {
    const stat = (a, unit = 'ms') => {
      if (!a.length) return { n: 0 };
      const s = [...a].sort((x, y) => x - y);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      return { n: a.length, [`p50_${unit}`]: q(0.5), [`p95_${unit}`]: q(0.95), [`max_${unit}`]: s[s.length - 1] };
    };
    return {
      recommendation: stat(timings.recommendation),
      alert_delivery: stat(timings.alert_delivery),
      scale_submit: stat(timings.scale_submit),
      sppvr_fill: stat(timings.sppvr_fill, 's'),
      config_version: configVersion,
      counts: {
        users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
        scale_results: db.prepare('SELECT COUNT(*) c FROM scale_results').get().c,
        sppvr_results: db.prepare('SELECT COUNT(*) c FROM sppvr_results').get().c,
        diary: db.prepare('SELECT COUNT(*) c FROM diary').get().c,
        alerts: db.prepare('SELECT COUNT(*) c FROM alerts').get().c
      }
    };
  }

  return { recordAdvice, bootstrapAlerts, bus, patientRow, buildCard, listForDoctor, confirmPrescription, stopPrescription, decideReferral, recordProtocol, saveExam, addMed, removeMed, closeVisit,
    submitScale, sppvrStart, submitEarlySafety, submitSppvr, submitClinical, submitDiary, sos, postMessage, patientHome, ackAlert, markRead, checkEscalation, metrics, raiseAlerts, openAlerts, activeRx, scalesOf, sppvrOf, diaryOf, analysisOf, configVersion };
}
