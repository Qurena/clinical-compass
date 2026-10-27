import {sheepHTML} from './mascot/sheep.js?v=1';
import {patientMetricsHTML, shouldShowMetrics} from './patient-metrics.js?v=1';
import {doctorSummaryHTML} from './doctor-summary.js?v=1';
import {createAlertSound} from './alert-sound.js?v=1';
// Роли «Врач» и «Пациент» в одном приложении; клиническая логика не зависит от маскота.
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const doctorAlertSound = createAlertSound();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dShort = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
const dClock = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dTime = (ts) => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function api(method, path, body, timeoutMs = 0) {
  let r;
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try { r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, ...(controller ? { signal: controller.signal } : {}) }); }
  catch { return { ok: false, status: 0, data: { error: 'network' } }; }
  finally { if (timeout) clearTimeout(timeout); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login' && path !== '/api/me') { location.reload(); }
  return { ok: r.ok, status: r.status, data };
}

function toast(html, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'info' ? 6000 : 20000);
  el.onclick = () => el.remove();
}

const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="kkl-bg" x1="8" y1="2" x2="56" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#C5D6F0"/><stop offset="1" stop-color="#6F8FC8"/></linearGradient></defs><rect width="64" height="64" rx="20" fill="url(#kkl-bg)"/><circle cx="32" cy="32" r="23" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-dasharray="1.2 4.4" stroke-linecap="round"/><g transform="translate(32 32) scale(.8) translate(-32 -32)"><path d="M32 6 37 27 58 32 37 37 32 58 27 37 6 32 27 27z" fill="#FBF0DC"/><path d="M32 6 37 27H27z" fill="#F29C8C"/></g><circle cx="32" cy="32" r="3.1" fill="#1B2A4E" stroke="#FBF0DC" stroke-width="1.5"/></svg>';

// ---------- график ----------
function lineChart({ title, points, max, marks = [], w = 340, h = 160, unit = '' }) {
  const L = 28, R = 10, T = 14, B = 24;
  const iw = w - L - R, ih = h - T - B;
  const y = (v) => T + ih - (v / max) * ih;
  let xs;
  if (points.length <= 1) xs = points.map(() => L + iw / 2);
  else {
    const t0 = points[0].ts, t1 = points[points.length - 1].ts;
    xs = points.map((p) => L + ((p.ts - t0) / (t1 - t0 || 1)) * iw);
  }
  const grid = marks.map((m) => `<line x1="${L}" x2="${w - R}" y1="${y(m)}" y2="${y(m)}" stroke="#b9c7c2" stroke-dasharray="3 3"/><text x="${L - 4}" y="${y(m) + 3}" text-anchor="end">${m}</text>`).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.total).toFixed(1)}" r="4" fill="#0f5c55"/><text x="${xs[i].toFixed(1)}" y="${(y(p.total) - 8).toFixed(1)}" text-anchor="${i === 0 && points.length > 1 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'middle'}" style="fill:#14231f;font-weight:700">${p.total}${unit}</text>`).join('');
  const anchor = (i) => (points.length > 1 && i === 0 ? 'start' : points.length > 1 && i === points.length - 1 ? 'end' : 'middle');
  const dates = points.map((p, i) => (i === 0 || i === points.length - 1 || points.length < 6) ? `<text x="${xs[i].toFixed(1)}" y="${h - 6}" text-anchor="${anchor(i)}">${dShort(p.ts)}</text>` : '').join('');
  const empty = points.length ? '' : `<text x="${w / 2}" y="${h / 2}" text-anchor="middle">нет данных</text>`;
  return `<figure style="margin:0"><figcaption class="small muted" style="margin-bottom:2px"><b>${esc(title)}</b></figcaption>
    <svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}">
    <line x1="${L}" x2="${L}" y1="${T}" y2="${T + ih}" stroke="#8a9a95"/><line x1="${L}" x2="${w - R}" y1="${T + ih}" y2="${T + ih}" stroke="#8a9a95"/>
    ${grid}<path d="${path}" fill="none" stroke="#0f5c55" stroke-width="2.5" stroke-linejoin="round"/>${dots}${dates}${empty}</svg></figure>`;
}
const MARKS = { gad7: [5, 10, 15], phq9: [5, 10, 15, 20], anx: [8, 11, 15], dep: [5, 10, 15, 20] };
const SC = { gad7: { name: 'GAD-7', max: 21 }, phq9: { name: 'PHQ-9', max: 27 } };
const SEV = {
  red: { cls: 'crit', ico: '⚠', label: 'КРАСНЫЙ' },
  orange: { cls: 'orange', ico: '▲', label: 'ОРАНЖЕВЫЙ' },
  yellow: { cls: 'warn', ico: '!', label: 'ЖЁЛТЫЙ' }
};


// =============== ВХОД ===============
function renderLogin(msg) {
  app.innerHTML = `<div class="login">
    <div class="login-head"><div class="brand">${LOGO}<span>Клинический компас</span></div>${MASCOT('wave', 'sm')}</div>
    <p class="muted">Система поддержки принятия врачебных решений для психиатра: ведение пациентов с тревожно-депрессивной симптоматикой. Учебный прототип, данные синтетические.</p>
    <div class="card">
      <h2>Демо-вход</h2>
      <div class="demo-grid">
        <button class="btn primary" data-demo="doctor">Врач-психиатр: Лебедева И.С.</button>
        <button class="btn" data-demo="maria">Пациент: Кузнецова Мария, повторный приём (другой синтетический сценарий)</button>
        <button class="btn" data-demo="anna">Пациент: Соколова Анна, 32 года, повторный приём (синтетический сценарий)</button>
        <button class="btn" data-demo="igor">Пациент: Волков Игорь, 45 лет, тревога и неизвестные лекарства (случай 2: серый статус)</button>
        <button class="btn" data-demo="pavel">Пациент: Беляев Павел, 38 лет, депрессия и соматические жалобы (случай 3)</button>
        <button class="btn" data-demo="daria">Пациент: Орлова Дарья, 26 лет, высокий риск (сигнал безопасности)</button>
      </div>
      <details><summary class="small muted">Вход по логину</summary>
        <form id="lf" class="grid" style="display:grid;gap:8px;margin-top:8px">
          <input type="text" name="login" placeholder="Логин" autocomplete="username" aria-label="Логин">
          <input type="password" name="password" placeholder="Пароль" autocomplete="current-password" aria-label="Пароль">
          <button class="btn primary">Войти</button>
        </form></details>
      ${msg ? `<p class="chk-crit">${esc(msg)}</p>` : ''}
    </div></div>`;
  app.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => { if (b.dataset.demo === 'doctor') doctorAlertSound.enable(); doLogin(b.dataset.demo, 'demo'); }));
  $('#lf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); doLogin(f.get('login'), f.get('password')); };
}
async function doLogin(login, password) {
  const r = await api('POST', '/api/login', { login, password });
  if (!r.ok) return renderLogin('Неверный логин или пароль');
  boot();
}
async function logout() { await api('POST', '/api/logout'); location.reload(); }

async function boot() {
  const me = await api('GET', '/api/me');
  if (me.status === 0) {
    app.innerHTML = '<div class="login"><div class="card"><h2>Нет связи с приложением</h2><p>Проверьте подключение и попробуйте снова.</p><button class="btn primary" id="retry-connection">Повторить</button></div></div>';
    $('#retry-connection').onclick = boot;
    return;
  }
  if (!me.ok) return renderLogin();
  if (me.data.role === 'doctor') return doctorApp(me.data);
  return patientApp(me.data);
}

// =============== ВРАЧ ===============
const D = { list: [], sel: null, card: null, tab: 'overview', live: false, es: null, dismissed: new Set(), showRaw: false, spp: null, verify: null };
const ansTxt = (q, v) => (v === null || v === undefined ? 'пропуск' : (((q.options || D.spp.options).find((o) => o.v === v) || {}).t ?? v));
const optTxt = (key, v) => { const f = (D.spp.clinical || {})[key]; if (v === null || v === undefined || !f) return 'нет ответа'; const o = [...(f.options || []), ...(f.exclusive || [])].find((x) => x.v === v); return o ? o.t : v; };
const ANSWER_TXT = (q, v) => ((q.options || D.spp.options).find((o) => o.v === v) || {}).t ?? v;

async function doctorApp(me) {
  D.me = me;
  D.spp = (await api('GET', '/api/scales')).data.sppvr;
  await refreshList();
  if (D.list.length) {
    D.sel = D.list[0].id;
    await loadCard();
  }
  connectStream();
  drawDoctor();
}
function connectStream() {
  if (D.es) D.es.close();
  const es = new EventSource('/api/doctor/stream');
  D.es = es;
  es.onopen = async () => {
    const reconnect = D.connectedOnce;
    D.connectedOnce = true; D.live = true; paintLive();
    if (reconnect) { await refreshList(); if (D.sel) await loadCard(); drawDoctor(); }
  };
  es.onerror = () => { D.live = false; paintLive(); };
  es.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'alert') {
      const a = ev.alert;
      const name = a.patient_name || (D.list.find((p) => p.id === a.patient_id) || {}).name || 'Пациент';
      const s = SEV[a.severity] || SEV.yellow;
      if (a.severity === 'red' && !doctorAlertSound.play()) toast('Звуковой сигнал недоступен. Включите звук в кабинете врача.', 'orange');
      toast(`<b>${s.ico} ${s.label} АЛЕРТ</b><br>${esc(name)}: ${esc(a.title)}<br><span class="small">${esc(a.details || '')}</span>`, a.severity === 'red' ? '' : a.severity === 'orange' ? 'orange' : 'yellow');
      if (a.severity === 'red' && (a.actions || []).includes('fullscreen')) { D.sel = a.patient_id; D.tab = 'overview'; }
    } else if (ev.type === 'escalation') {
      toast(`<b>⚠ Эскалация</b><br>Алерт не принят в срок: ${esc(ev.title)}`);
    } else if (ev.type === 'result') {
      toast(`${esc(ev.patient_name)}: получен результат (${esc(ev.what)})`, 'info');
    } else if (ev.type === 'message') {
      toast(`Новое сообщение от пациента: ${esc(ev.patient_name)}`, 'info');
    }
    await refreshList();
    if (D.sel) await loadCard();
    keepInputs(drawDoctor);
  };
}
const paintLive = () => { const d = $('#live'); if (d) d.innerHTML = `<span class="dot ${D.live ? '' : 'off'}" aria-hidden="true"></span> ${D.live ? 'Связь есть' : 'Нет связи: обновление приостановлено'}`; };
async function refreshList() { const r = await api('GET', '/api/doctor/patients'); if (r.ok && Array.isArray(r.data)) D.list = r.data; }
async function loadCard() { const r = await api('GET', '/api/doctor/patients/' + D.sel); D.card = r.ok ? r.data : null; }

const refBadge = (lvl) => ({ urgent: '<span class="badge mand">⚠ НЕОТЛОЖНО</span>', mandatory: '<span class="badge mand2">◆ ОБЯЗАТЕЛЬНО</span>', recommended: '<span class="badge desir">◐ РЕКОМЕНДОВАНО</span>' }[lvl] || '<span class="badge none">✓ ПРОДОЛЖИТЬ НАБЛЮДЕНИЕ</span>');
const DDI_LBL = { green: 'ЗЕЛЁНЫЙ', yellow: 'ЖЁЛТЫЙ', orange: 'ОРАНЖЕВЫЙ', red: 'КРАСНЫЙ', grey: 'СЕРЫЙ: данных недостаточно' };
const sevBadge = (s, text) => `<span class="badge ${SEV[s].cls}">${SEV[s].ico} ${text || SEV[s].label}</span>`;
const STATE_CLS = { red: 's-red', orange: 's-orange', yellow: 's-yellow', none: 's-none' };

// Живое обновление не должно стирать то, что врач уже печатает
function keepInputs(fn) {
  const saved = [...app.querySelectorAll('input[type=text], textarea')].filter((e) => e.value && (e.id || e.dataset.note)).map((e) => [e.id ? '#' + e.id : `[data-note="${e.dataset.note}"]`, e.value]);
  const active = document.activeElement && document.activeElement.id ? '#' + document.activeElement.id : null;
  const y = window.scrollY;
  fn();
  for (const [sel, v] of saved) { const e = app.querySelector(sel); if (e && !e.value) e.value = v; }
  if (active) { const e = app.querySelector(active); if (e) e.focus({ preventScroll: true }); }
  window.scrollTo(0, y);
}
function drawDoctor() {
  const items = D.list.map((p) => {
    const hyp = p.dx ? `${p.dx.code} · ${p.dx.name}` : p.hypothesis ? `Сигнал: ${p.hypothesis.name}` : 'СППВР ещё не пройден';
    const counts = ['red', 'orange', 'yellow'].map((s) => [s, p.open_alerts.filter((a) => a.severity === s).length]).filter(([, n]) => n);
    return `<button class="item ${STATE_CLS[p.color]} ${p.id === D.sel ? 'sel' : ''}" data-pid="${p.id}">
      <div class="row spread"><b>${esc(p.name)}</b><span class="muted small">${p.age} л., ${esc(p.sex)}</span></div>
      <div class="small" style="margin-top:2px">${esc(hyp)}</div>
      <div class="scores">${p.sppvr ? `<span title="PHQ-9, 0–27">PHQ-9 <b>${p.sppvr.phq9 ?? '–'}</b></span><span title="Экспериментальный технический индикатор согласованности ответов (не валидирован)">ИКСО <b>${p.sppvr.ikso ?? '–'}</b></span>` : ''}${p.on_therapy ? `<span>приём <b>${p.adherence ?? '–'}${p.adherence != null ? '%' : ''}</b></span>` : ''}</div>
      <div class="row" style="margin-top:8px">${counts.slice(0, 1).map(([s, n]) => sevBadge(s, n > 1 ? `${SEV[s].label} ${n}` : SEV[s].label)).join('')}</div>
    </button>`;
  }).join('');
  app.innerHTML = `<div class="topbar"><div class="brand">${LOGO}<span>Клинический компас</span></div><span class="grow"></span>
      <span class="small" id="live"></span><button class="linkbtn small" id="alert-sound" type="button">${doctorAlertSound.enabled ? 'Звук сигналов включён' : 'Включить звук сигналов'}</button>
      <details class="menu"><summary>${esc(D.me.name)}</summary><div class="menu-pop"><button class="linkbtn" id="mt">Метрики</button><button class="linkbtn" id="lo">Выйти</button></div></details></div>
    <div class="doc"><aside class="plist"><h2>Пациенты на приёме</h2>${items}</aside><main id="main"></main></div>`;
  paintLive();
  $('#alert-sound').onclick = async () => { const ok = await doctorAlertSound.enable(); $('#alert-sound').textContent = ok ? 'Звук сигналов включён' : 'Звук недоступен'; };
  app.querySelectorAll('[data-pid]').forEach((b) => (b.onclick = async () => { D.sel = Number(b.dataset.pid); D.showRaw = false; await loadCard(); drawDoctor(); }));
  $('#lo').onclick = logout;
  $('#mt').onclick = showMetrics;
  drawCard();
  maybeOverlay();
}

async function showMetrics() {
  const r = await api('GET', '/api/doctor/metrics');
  const m = r.data;
  const f = (x) => (x.n ? `p50 ${x.p50_ms} мс · p95 ${x.p95_ms} мс · n=${x.n}` : 'пока нет замеров');
  const s = m.sppvr_fill.n ? `медиана ${m.sppvr_fill.p50_s} с · n=${m.sppvr_fill.n}` : 'пока нет замеров';
  toast(`<b>Технические метрики сессии</b><br>Формирование рекомендации: ${f(m.recommendation)}<br>Доставка алерта врачу: ${f(m.alert_delivery)}<br>Приём результата: ${f(m.scale_submit)}<br>Время заполнения СППВР: ${s}<br>Версия конфигурации: ${esc(m.config_version)}`, 'info');
}

// ---------- красный полноэкранный алерт ----------
function maybeOverlay() {
  const old = $('#overlay'); if (old) old.remove();
  const c = D.card; if (!c) return;
  const live = c.alerts.filter((x) => x.severity === 'red' && !x.ack_ts && JSON.parse(x.actions).includes('fullscreen') && !D.dismissed.has(x.id));
  if (!live.length) return;
  const a = live[0];
  const dismissAll = () => live.forEach((x) => D.dismissed.add(x.id));
  const el = document.createElement('div');
  el.id = 'overlay'; el.className = 'overlay'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="ov-box"><div class="ov-ico">⚠</div>
    <h1>${['sppvr_severe','phq9_severe'].includes(a.rule_id) ? 'ВНИМАНИЕ: высокая выраженность симптомов' : 'ВНИМАНИЕ: немедленно уточнить безопасность'}</h1>
    <p class="ov-p"><b>${esc(c.patient.name)}</b>, ${c.patient.profile.age} лет. ${esc(a.title)}<br>${esc(a.details || '')}</p>
    <ul class="ov-list"><li>Уточнить мысли, намерение, план, доступ к средствам и недавние попытки</li><li>Пациенту показан экран безопасности с контактами</li><li>Госпитализация автоматически не назначается: решение принимает специалист</li></ul>
    <div class="row" style="justify-content:center;margin-top:14px"><button class="btn" id="ov-proto" style="background:#fff;color:#8c1b14">Открыть оценку показаний к госпитализации</button>
      <button class="btn" id="ov-close" style="background:transparent;color:#fff;border-color:#fff">Я ознакомлен(а), открыть карточку</button></div></div>`;
  document.body.appendChild(el);
  $('#ov-proto').onclick = () => { dismissAll(); D.tab = 'overview'; el.remove(); drawCard(); const p = $('#protocol'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#ov-close').onclick = () => { dismissAll(); el.remove(); };
  $('#ov-proto').focus();
}

function drawCard() {
  const c = D.card;
  const main = $('#main');
  if (!c) { main.innerHTML = '<p class="muted">Выберите пациента</p>'; return; }
  const p = c.patient;
  const tabs = [['overview', 'Приём и решения'], ['dynamics', 'Динамика'], ['chat', 'Связь с пациентом'], ['journal', 'Журнал решений']]
    .map(([k, t]) => `<button class="tab ${D.tab === k ? 'on' : ''}" data-tab="${k}">${t}${k === 'chat' && c.messages.length ? ` (${c.messages.length})` : ''}</button>`).join('');
  const dx = p.profile.dx;
  main.innerHTML = `<div class="card"><div class="row spread"><div><h1 style="font-size:21px">${esc(p.name)}</h1>
      <div class="muted">${p.profile.age} лет · ${esc(p.profile.sex)} · ${dx ? `${esc(dx.code)} ${esc(dx.name)} (установлен)` : 'диагноз не установлен, первичная оценка'}</div>
      <div class="small muted">${esc(p.source || '')}</div></div>
      ${c.recommendation.has_active ? '<span class="badge none">на терапии Авиандром</span>' : '<span class="badge warn">терапия Авиандром не назначена</span>'}</div>
      <p class="small" style="margin:8px 0 0"><b>Жалобы:</b> ${esc(p.profile.complaint)}</p></div>
    <div class="tabs">${tabs}</div><div id="tabbody"></div>`;
  main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { D.tab = b.dataset.tab; drawCard(); }));
  if (D.tab === 'overview') drawOverview(); else if (D.tab === 'dynamics') drawDynamics(); else if (D.tab === 'chat') drawChat(); else drawJournal();
}

// статусы алерта (КЛК): создан → доставлен → открыт → принят → действие
function chain(a) {
  const st = (ok, label, t) => `<span class="step ${ok ? 'on' : ''}">${ok ? '✓' : '○'} ${label}${t ? ' ' + t : ''}</span>`;
  const dl = a.delivered_ts ? (a.delivered_ts - a.created_ts < 10000 ? `+${a.delivered_ts - a.created_ts} мс` : 'при входе врача') : '';
  return `<div class="chain" aria-label="Статусы алерта">${st(true, 'создан', dClock(a.created_ts))}${st(!!a.delivered_ts, 'доставлен', dl)}${st(!!a.read_ts, 'открыт', a.read_ts ? dClock(a.read_ts) : '')}${st(!!a.ack_ts, 'принят', a.ack_ts ? dClock(a.ack_ts) : '')}${st(!!a.action_ts, 'действие', a.action_ts ? dClock(a.action_ts) : '')}</div>`;
}

function meter(label, sub, val, max, band, cut) {
  return `<div class="meter"><div class="row spread"><b>${label}</b><span><b style="font-size:20px">${val}</b><span class="muted small"> из ${max}</span></span></div>
    <div class="bar"><i style="width:${Math.min(100, (val / max) * 100)}%" class="${cut}"></i></div><div class="small muted">${esc(sub)} · ${esc(band)}</div></div>`;
}

const KEY_LBL = { hads: 'Вопросы о тревоге', phq9: 'PHQ-9' };
function iksoBlock(s) {
  const q = s.quality, g = q.grade;
  const none = q.score === null || q.score === undefined;
  const cls = none ? 'none' : q.score >= 90 ? '' : q.score >= 75 ? 'mid' : q.score >= 50 ? 'hi' : 'crit';
  const pen = Object.entries(q.penalties).filter(([, v]) => v).map(([k, v]) => `${k} −${v}`).join(', ') || 'штрафов нет';
  const pairs = q.pairs.map((p) => `<li class="small ${p.flagged ? 'chk-warn' : ''}">${KEY_LBL[p.scale]} п. ${p.item}: ${p.orig} / повтор ${p.anchor}${p.flagged ? ' · расхождение ≥ 2' : ''}</li>`).join('');
  return `<div class="meter"><div class="row spread"><b>ИКСО</b> <span class="chip-st grey" title="Экспериментальный технический индикатор">эксперим.</span><span>${none ? '<b style="font-size:20px">не рассчитан</b>' : `<b style="font-size:20px">${q.score}</b><span class="muted small"> из 100</span>`}</span></div>
    <div class="bar"><i style="width:${none ? 0 : q.score}%" class="${cls}"></i></div>
    <div class="small">${esc(g.label)}</div>
    <p class="small muted" style="margin:4px 0">Экспериментальный технический индикатор: не валидирован, не диагностирует ложь и не отменяет и не снижает срочный сигнал.</p>
    <details class="more"><summary class="small">Из чего сложился (${pen})</summary>
      <p class="small muted" style="margin:4px 0">${esc(q.formula)}. Вспомогательный эвристический индекс: не доказывает искренность и не меняет суммы шкал.</p>
      <ul class="list">${pairs}</ul>
      ${(q.components || []).map((x) => `<p class="small chk-warn" style="margin:2px 0">! ${esc(x)}</p>`).join('')}
      <p class="small muted">Время заполнения: ${s.elapsed_sec != null ? Math.round(s.elapsed_sec) + ' с' : 'нет данных'} (активное время, без пауз). Порог «нетипичного времени» — рабочая гипотеза, не нормативная граница.</p></details></div>`;
}

function clinicalBlock() {
  const c = D.card, cl = c.clinical;
  if (!cl || !cl.derived) return `<div class="card"><h2>Клинический контекст</h2><p class="muted">Блок про длительность, лекарства и здоровье пациент ещё не заполнил. Пока он не заполнен, данных о лекарствах и безопасности может быть недостаточно, а статус по Авиандру остаётся серым, если врач не сверил список лекарств.</p></div>`;
  const r = cl.raw, d = cl.derived;
  const line = (k, v) => `<b>${k}</b><span>${v}</span>`;
  const arr = (key, a) => (a || []).map((x) => esc(optTxt(key, x))).join(', ') || '–';
  const chips = [
    d.safety_immediate ? '<span class="badge crit">⚠ безопасность: уточнить сразу</span>' : '',
    d.bar ? '<span class="badge orange">▲ возможная мания: уточнить очно</span>' : '',
    d.unknown_data ? '<span class="badge warn">? есть ответы «не знаю»</span>' : '',
    d.pregnant ? '<span class="badge warn">беременность/лактация</span>' : '', d.pregnancy_unknown ? '<span class="badge warn">беременность не уточнена</span>' : '',
    d.alcohol_regular ? '<span class="badge warn">регулярный алкоголь</span>' : '', d.substances ? '<span class="badge warn">вещества</span>' : '',
    d.somatic_red ? '<span class="badge crit">⚠ соматическая тревога: срочно</span>' : ''
  ].join('');
  return `<div class="card"><div class="sect-title"><h2>Клинический контекст (со слов пациента)</h2><span class="muted small">${dTime(cl.ts)}</span></div>
    <div class="row" style="margin:4px 0">${chips}</div>
    <div class="kv small">${line('Длительность', esc(optTxt('duration', r.duration)))}${line('Функционирование', esc(optTxt('functioning', r.functioning)))}
    ${line('Лекарства', esc(optTxt('meds_status', r.meds_status)) + ((r.meds || []).length ? ': ' + r.meds.map((m) => esc(typeof m === 'string' ? m : (m.name || 'название неизвестно'))).join(', ') : ''))}
    ${line('Побочные эффекты', esc(optTxt('adverse', r.adverse)))}${line('Мания в анамнезе', esc(optTxt('mania', r.mania)))}
    ${line('Соматические', arr('somatic_hx', r.somatic_hx))}${r.pregnancy ? line('Беременность', esc(optTxt('pregnancy', r.pregnancy))) : ''}${line('Алкоголь', esc(optTxt('alcohol', r.alcohol)))}
    ${line('Жалобы по органам', arr('organ', r.organ))}</div>
    <p class="small muted" style="margin:6px 0 0">Это ответы пациента, не диагноз и не сверенный список лекарств. Врач подтверждает их на приёме.</p></div>`;
}

function sppvrBlock() {
  const c = D.card, a = c.analysis;
  if (a.state === 'no_data') return `<div class="card"><h2>Опросник СППВР</h2><p class="muted">Пациент ещё не заполнил опросник. Первичная оценка начнётся после заполнения (${D.spp.total || 20} вопросов; время зависит от пациента).</p></div>`;
  const s = c.sppvr[0], f = s.flags, sc = a.scores;
  const chips = [
    f.attention_failed ? '<span class="badge warn">! проверка внимания не пройдена</span>' : '',
    f.inconsistent ? '<span class="badge warn">! расхождение повторных вопросов</span>' : '',
    f.fast ? `<span class="badge warn">! нетипичное время: уточнить ответы (${Math.round(s.elapsed_sec)} с)</span>` : '',
    f.slow ? '<span class="badge warn">! нетипичное время: уточнить ответы (долго)</span>' : '',
    f.uniform ? '<span class="badge warn">! однотипные ответы</span>' : '',
    f.suicidal ? '<span class="badge crit">⚠ вопрос 9 PHQ-9 &gt; 0: уточнить безопасность</span>' : ''
  ].join('');
  const sum = (v) => (v == null ? '–' : v);
  const hyp = a.hypothesis ? `<div class="hyp"><div class="small muted">Сигнал для клинической оценки${a.hypothesis.established ? ' (диагноз установлен врачом)' : ''}</div><b>${a.hypothesis.code ? esc(a.hypothesis.code) + ' · ' : ''}${esc(a.hypothesis.name)}</b>${a.hypothesis.note ? `<div class="small muted">${esc(a.hypothesis.note)}</div>` : ''}</div>` : '';
  const blocks = a.blocks.map((b) => `<div class="banner ${b.id === 'withheld' ? 'warn' : 'orange'}"><div class="ico">${b.id === 'withheld' ? '!' : '▲'}</div><div><b>${esc(b.text)}</b></div></div>`).join('');
  const notes = (a.notes || []).map((n) => `<p class="small chk-warn" style="margin:4px 0">! ${esc(n)}</p>`).join('');
  let stage = '';
  if (a.stage) {
    const st = a.stage;
    stage = `<div class="stage"><div class="small muted">Логика ведения по КР Минздрава${st.n != null ? ` · этап ${st.n}` : ''} (поддержка решения врача)</div><b>${esc(st.title)}</b>
      ${st.reason ? `<p class="small" style="margin:4px 0">${esc(st.reason)}</p>` : ''}
      <ul class="list">${(st.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${st.behavior ? `<p class="small muted">${esc(st.behavior)}</p>` : ''}
      ${st.resp ? `<p class="small">Динамика: ${st.resp.baseline} → ${st.resp.latest}. Решение о дозе принимает врач.</p>` : ''}</div>`;
  }
  const nd = a.non_drug.length ? `<h3>Немедикаментозно</h3><ul class="list">${a.non_drug.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const prevA = c.summary && c.summary.prev_answers;
  const raw = D.showRaw ? `<table class="raw small"><tr class="muted"><td>№</td><td>Вопрос</td><td>Ответ</td><td>с</td>${prevA ? '<td>Прошлый визит</td>' : ''}</tr>${D.spp.questions.map((q, i) => `<tr class="${i === 8 && s.answers[i] > 0 ? 'rowcrit' : ''}"><td>${esc(q.tag || q.id)}</td><td>${esc(q.text || q.domain || '')}</td><td><b>${esc(ansTxt(q, s.answers[i]))}</b></td><td class="muted">${s.item_sec && s.item_sec[i] != null ? s.item_sec[i] : ''}</td>${prevA ? `<td class="muted">${esc(ansTxt(q, prevA[i]))}</td>` : ''}</tr>`).join('')}</table>` : '';
  return `<div class="card"><div class="sect-title"><h2>Опросник: PHQ-9 и вопросы о тревоге</h2><span class="muted small">${dTime(s.ts)}</span></div>
    <p class="small muted" style="margin:0 0 6px">Ответы о тревоге показаны по отдельным вопросам; итоговая оценка по ним не рассчитывается.</p>
    <div class="meters">${meter('PHQ-9', 'депрессивные симптомы, сумма 9 пунктов', sum(sc.phq9), 27, sc.bands.phq9, sc.phq9 >= 20 ? 'crit' : sc.phq9 >= 10 ? 'hi' : sc.phq9 >= 5 ? 'mid' : '')}
    
    ${iksoBlock(s)}</div>
    <p class="small muted" style="margin:4px 0">Если в PHQ-9 пропущен пункт, сумма не выводится.</p>
    <div class="row" style="margin:8px 0">${chips}</div>${blocks}${hyp}${stage}${notes}${nd}${raw}
    <button class="btn small" id="rawtoggle" style="margin-top:8px">${D.showRaw ? 'Скрыть ответы' : 'Показать ответы по вопросам'}</button></div>`;
}

function examBlock() {
  const p = D.card.patient.profile, ex = p.exam || {};
  const dx = p.dx ? (p.dx.code || '').replace('.', '_') : '';
  const opt = (v, t) => `<option value="${v}" ${dx === v ? 'selected' : ''}>${t}</option>`;
  return `<details class="card" ${D.examOpen ? 'open' : ''} id="examd"><summary><h2 style="display:inline">Осмотр врача: диагноз и отметки вне опросника</h2></summary>
    <p class="small muted" style="margin:6px 0">Диагноз, психотические симптомы, соматическая патология и исключение мании определяются очно. Система только учитывает ваши отметки и сама диагноз не выставляет.</p>
    <div class="grid2">
      <label class="small" for="ex-dx">Диагноз (устанавливает врач)<select id="ex-dx"><option value="">не установлен</option>${opt('F41_1', 'F41.1 Генерализованное тревожное расстройство')}${opt('F43_2', 'F43.2 Стрессовая реакция / нарушение адаптации')}${opt('F32', 'F32 Депрессивный эпизод')}${opt('F33', 'F33 Рекуррентное депрессивное расстройство')}</select></label>
      <label class="chk"><input type="checkbox" id="ex-cov" ${(p.conditions || []).includes('post_covid') ? 'checked' : ''}> Тревога после COVID-19</label>
      <label class="chk"><input type="checkbox" id="ex-rec" ${ex.meds_reconciled ? 'checked' : ''}> Список лекарств сверён с пациентом</label>
      <label class="chk"><input type="checkbox" id="ex-psy" ${ex.psychotic ? 'checked' : ''}> Психотические симптомы</label>
      <label class="chk"><input type="checkbox" id="ex-bar" ${ex.bar_excluded ? 'checked' : ''}> Биполярность исключена очно</label>
      <label class="chk"><input type="checkbox" id="ex-som" ${ex.somatoform ? 'checked' : ''}> Выраженная соматоформная коморбидность</label>
      <label class="chk"><input type="checkbox" id="ex-arr" ${ex.arrhythmia ? 'checked' : ''}> Тяжёлая аритмия</label>
      <label class="small" for="ex-tsh">ТТГ, мЕд/л <input type="text" id="ex-tsh" value="${ex.tsh ?? ''}" style="width:90px;display:inline-block"></label></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="ex-save">Сохранить осмотр</button></div></details>`;
}

function routeBlock() {
  const c = D.card, r = c.referral, rec = r.record;
  const reasons = r.reasons.map((x) => `<li>${refBadge(x.level)} <b>${esc(x.title)}</b><span class="muted small"> — ${esc(x.basis)}</span>${x.action ? `<div class="small">${esc(x.action)}</div>` : ''}</li>`).join('');
  let decision = '';
  if (rec && rec.status === 'confirmed') decision = `<div class="banner ok"><div class="ico">✓</div><div>Маршрут подтверждён врачом · ${dTime(rec.decided_ts)}${rec.comment ? ' · ' + esc(rec.comment) : ''}</div></div>`;
  else if (r.level !== 'none') decision = `<div class="row"><input type="text" id="refc" class="grow" placeholder="Комментарий (необязательно)" aria-label="Комментарий"><button class="btn primary" id="refyes">Подтвердить маршрут</button><button class="btn" id="refno">Отклонить</button></div>
    <p class="small muted" style="margin:6px 0 0">Система только предлагает. Маршрут оформляется после вашего подтверждения.${rec && rec.status === 'dismissed' ? ' Ранее отклонено: ' + esc(rec.comment || 'без комментария') : ''}</p>`;
  const mand = r.level === 'urgent' || r.level === 'mandatory';
  const protocol = r.level === 'urgent' ? protocolBlock() : '';
  return `<div class="card" style="border:2px solid ${mand ? 'var(--crit)' : r.level === 'recommended' ? 'var(--warn-line)' : 'var(--line)'};${r.level === 'recommended' ? 'border-style:dashed' : ''}">
    <div class="sect-title"><h2>Маршрутизация</h2>${refBadge(r.level)}</div>
    <p style="margin:0 0 8px">${esc(r.route.action)}</p>${reasons ? `<ul class="list" style="list-style:none;padding:0">${reasons}</ul>` : ''}${decision}${protocol}
    <div class="src">Критерии: config/rules.json (по КЛК, требуют клинической верификации Ариной). Маршрут предлагает система, решает врач.</div></div>`;
}

function protocolBlock() {
  const c = D.card;
  const done = c.protocols.map((p) => `<div class="banner ok"><div class="ico">✓</div><div><b>Протокол оформлен</b> · ${dTime(p.ts)} · ${esc(p.name)}<div class="small">${esc(p.route)}</div>${p.comment ? `<div class="small muted">${esc(p.comment)}</div>` : ''}</div></div>`).join('');
  return `<div id="protocol" class="proto"><h3>Оценка показаний к госпитализации</h3>${done}
    <div class="small muted">Основания по ст. 29 Закона РФ «О психиатрической помощи и гарантиях прав граждан при её оказании» (для недобровольной формы нужно хотя бы одно):</div>
    <label class="chk"><input type="checkbox" id="pr-danger"> Непосредственная опасность для себя или окружающих</label>
    <label class="chk"><input type="checkbox" id="pr-help"> Беспомощность (неспособность самостоятельно удовлетворять жизненные потребности)</label>
    <label class="chk"><input type="checkbox" id="pr-det"> Существенный вред здоровью вследствие ухудшения состояния без помощи</label>
    <div class="row" style="margin:8px 0"><label class="chk"><input type="radio" name="pr-c" value="voluntary" checked> Добровольное согласие</label>
      <label class="chk"><input type="radio" name="pr-c" value="involuntary"> Недобровольная госпитализация</label>
      <label class="chk"><input type="radio" name="pr-c" value="declined"> Пациент отказывается</label></div>
    <input type="text" id="pr-note" placeholder="Комментарий врача" aria-label="Комментарий врача">
    <div class="row" style="margin-top:8px"><button class="btn danger" id="pr-go">Сохранить оценку</button></div></div>`;
}

function alertsBlock() {
  const c = D.card;
  const open = c.alerts.filter((a) => !a.ack_ts);
  const closed = c.alerts.filter((a) => a.ack_ts).slice(0, 4);
  const one = (a) => {
    const s = SEV[a.severity], acts = JSON.parse(a.actions);
    const auto = [acts.includes('notify_doctor') ? 'врач оповещён' : '', acts.includes('flag_card') ? 'карточка помечена' : '', acts.includes('patient_safety_screen') ? 'пациенту показан экран безопасности' : '', acts.includes('draft_referral') ? 'подготовлен черновик маршрута' : ''].filter(Boolean).join(' · ');
    return `<div class="banner ${s.cls}" role="alert"><div class="ico">${s.ico}</div>
      <div class="grow"><b>${s.label} АЛЕРТ: ${esc(a.title)}</b>${a.escalated ? ' <span class="badge crit">эскалация</span>' : ''}
      <div class="small">${esc(a.details || '')}</div>${chain(a)}
      <div class="small muted" style="margin-top:2px">Автоматически: ${esc(auto)}</div>
      ${a.ack_ts ? `<div class="small"><b>${a.action_ts ? 'Действие' : 'Принят'}:</b> ${esc(a.ack_name || '')}${a.ack_note ? ' · ' + esc(a.ack_note) : ''}</div>` : `<div class="row" style="margin-top:8px"><input type="text" class="grow" data-note="${a.id}" placeholder="Что сделано (например, «позвонила пациенту»)" aria-label="Заметка"><button class="btn small primary" data-ack="${a.id}">Взять в работу</button></div>`}</div></div>`;
  };
  return open.map(one).join('') + (closed.length ? `<details class="card"><summary class="small">Обработанные алерты (${closed.length})</summary>${closed.map(one).join('')}</details>` : '');
}

function drugBlock() {
  const c = D.card, rcm = c.recommendation, d = rcm.drug, a = c.analysis;
  const act = c.prescriptions.find((x) => x.status === 'active');
  const li = (arr, cls) => arr.map((x) => `<li class="${cls}">${esc(x)}</li>`).join('');
  const ind = d.indication.match ? `<span class="badge none">✓ по инструкции</span>` : '<span class="badge warn">! вне инструкции: решение врача</span>';
  const adv = rcm.advice || a.aviandr || {};
  const AV = { consider: ['ok', '✓'], orange: ['orange', '▲'], grey: ['warn', '?'], not_recommended: ['crit', '⛔'], none: ['warn', 'i'] }[adv.state] || ['warn', 'i'];
  let head;
  if (rcm.prescribe_blocked === 'ddi') head = ['crit', '⛔', 'Назначение заблокировано: красное взаимодействие (ИМАО). Интервал не менее 14 дней после отмены.'];
  else if (rcm.has_active) head = ['ok', '✓', 'Курс Авиандра идёт. Оценка ответа и дальнейшая тактика: решение врача.'];
  else head = [AV[0], AV[1], adv.title || 'Рекомендации по Авиандру нет'];
  const inter = d.interactions.map((i) => `<li class="ddi ${i.status}"><span class="chip-st ${i.status}">● ${DDI_LBL[i.status] || i.status}</span> <b>${esc(i.meds.join(', '))}:</b> ${esc(i.text)}<div class="small">${esc(i.action)}</div><div class="small muted">Источник: ${esc(i.source)}</div>${i.needs_verification ? '<div class="small chk-warn">Нужна проверка по инструкции и литературе.</div>' : ''}</li>`).join('');
  const gaps = (d.gaps || []).map((g) => `<li>${esc(g)}</li>`).join('');
  const meds = c.patient.meds.map((m, i) => `<span class="chip-med">${esc(m.name)}${m.known === false ? ' <i title="нет в справочнике">?</i>' : ''}${m.source === 'patient' ? ' <i title="со слов пациента, не сверено">п</i>' : ''}<button type="button" data-rmmed="${i}" aria-label="Удалить ${esc(m.name)}">×</button></span>`).join('') || '<span class="muted small">другие препараты не внесены</span>';
  let action;
  if (act) action = `<div class="banner ok"><div class="ico">✓</div><div class="grow">Назначен врачом ${dTime(act.started_ts)}${act.override_reason ? ' · вне инструкции: ' + esc(act.override_reason) : ''}</div><button class="btn small" id="stoprx" data-rx="${act.id}">Отменить терапию</button></div>`;
  else action = `${adv.state ? `<div class="row" style="margin-bottom:8px"><input type="text" id="advr" class="grow" placeholder="Причина (для «изменить» и «отклонить»)" aria-label="Причина"><button class="btn small" data-adv="confirm">Принять рекомендацию</button><button class="btn small" data-adv="change">Изменить</button><button class="btn small" data-adv="dismiss">Отклонить</button></div>` : ''}<div class="row"><button class="btn primary" id="rx" ${rcm.prescribe_blocked ? 'disabled' : ''}>${adv.state === 'consider' ? 'Назначить Авиандр…' : 'Назначить Авиандр вручную…'}</button><span class="small muted">Система только предлагает, назначает врач.</span></div>`;
  return `<div class="card"><div class="sect-title"><h2>Терапия: ${esc(d.drug.name)} (${esc(d.drug.inn)})</h2>${ind}</div>
    <div class="banner ${head[0]}"><div class="ico">${head[1]}</div><div><b>${esc(head[2])}</b>${adv.text ? `<div class="small" style="margin-top:4px">${esc(adv.text)}</div>` : ''}${adv.options && ['none', 'not_recommended', 'orange'].includes(adv.state) ? `<div class="small muted">${esc(adv.options[0] || adv.options)}</div>` : ''}</div></div>
    <div class="decision-context"><div><b>На основании чего</b>${(adv.basis || []).length ? `<ul class="list small">${adv.basis.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small">Основание пока не сформировано.</p>'}</div>
      <div><b>Что уточнить</b>${gaps ? `<ul class="list small">${gaps}</ul>` : '<p class="small">Неотмеченных данных для проверки не показано.</p>'}</div>
      <div><b>Решение</b><p class="small">Врач рассматривает варианты и фиксирует своё решение.</p></div></div>
    ${rcm.soft_hold && adv.state === 'consider' ? `<div class="banner orange"><div class="ico">▲</div><div><b>${esc(rcm.soft_hold)}</b></div></div>` : ''}
    <div class="kv" style="margin:10px 0"><b>Показание по инструкции</b><span>${d.indication.match ? '✓ ' : ''}${esc(d.indication.label)}</span>
      <b>Режим</b><span>${esc(d.dosing.regimen)}</span>${d.indication.course ? `<b>Курс</b><span>${esc(d.indication.course)}</span>` : ''}
      <b>Частые НЯ</b><span>${esc(d.adverse_events.common.join(', '))}</span></div>
    <details class="more"><summary>Противопоказания и предостережения (${d.contraindications.length + d.cautions.length})</summary>
    ${d.contraindications.length ? `<h3>Противопоказания</h3><ul class="list">${li(d.contraindications, 'chk-crit')}</ul>` : ''}
    ${d.cautions.length ? `<h3>Предостережения</h3><ul class="list">${li(d.cautions, 'chk-warn')}</ul>` : ''}</details>
    <h3>Окно взаимодействий <span class="chip-st ${d.ddi_level}">● ${DDI_LBL[d.ddi_level]}</span></h3>
    <div class="chips-med">${meds}</div>
    <div class="row" style="margin:6px 0"><input type="text" id="medname" class="grow" placeholder="Добавить препарат пациента (например, диазепам)" aria-label="Добавить препарат"><button class="btn small" id="medadd">Проверить и добавить</button></div>
    ${d.unknown_meds.length ? `<p class="small chk-warn">Не найдено в справочнике, статус серый: ${esc(d.unknown_meds.join(', '))}</p>` : ''}
    ${gaps ? `<div class="banner warn"><div class="ico">?</div><div><b>Данных недостаточно для статуса «совместимо»</b><ul class="list small">${gaps}</ul></div></div>` : ''}
    ${inter ? `<ul class="list" style="list-style:none;padding:0">${inter}</ul>` : (gaps ? '' : '<p class="small muted">Взаимодействий не выявлено.</p>')}
    ${action}
    <details class="more"><summary>План мониторинга и источник</summary><ul class="list">${d.monitoring.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
    <div class="src">Источник: ${esc(d.drug.source)}<br>Форма: ${esc(d.drug.form)}.</div></details></div>`;
}

function drawOverview() {
  const c = D.card, el = $('#tabbody');
  const visit = `<div class="card"><div class="row"><input type="text" id="vnote" class="grow" placeholder="Итог приёма (необязательно): что решено" aria-label="Итог приёма"><button class="btn" id="vclose">Завершить приём и сохранить в историю</button></div>
    <p class="small muted" style="margin:6px 0 0">${c.visits.length ? 'Последний приём: ' + dTime(c.visits[0].ts) + ' · ' + esc(c.visits[0].name) + (c.visits[0].note ? ' · ' + esc(c.visits[0].note) : '') : 'Приёмов в истории пока нет'}. Следующая сводка изменений будет считаться от этой отметки.</p></div>`;
  el.innerHTML = alertsBlock() + doctorSummaryHTML(c) + sppvrBlock() + clinicalBlock() + examBlock() + routeBlock() + drugBlock() + visit;
  bindOverview();
}

function bindOverview() {
  const el = $('#tabbody');
  el.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.ack; const note = $(`[data-note="${id}"]`).value;
    await api('POST', `/api/doctor/alerts/${id}/ack`, { note }); await afterAction();
  }));
  const ry = $('#refyes'), rn = $('#refno');
  if (ry) ry.onclick = async () => { await api('POST', `/api/doctor/patients/${D.sel}/referral`, { action: 'confirm', comment: $('#refc').value }); await afterAction(); };
  if (rn) rn.onclick = async () => { await api('POST', `/api/doctor/patients/${D.sel}/referral`, { action: 'dismiss', comment: $('#refc').value }); await afterAction(); };
  const rt = $('#rawtoggle'); if (rt) rt.onclick = () => { D.showRaw = !D.showRaw; drawOverview(); };
  const pg = $('#pr-go');
  if (pg) pg.onclick = async () => {
    const consent = (document.querySelector('input[name=pr-c]:checked') || {}).value;
    const r = await api('POST', `/api/doctor/patients/${D.sel}/protocol`, { consent, danger: $('#pr-danger').checked, helpless: $('#pr-help').checked, deterioration: $('#pr-det').checked, comment: $('#pr-note').value });
    if (!r.ok) return toast(r.data.error === 'basis_required' ? 'Для недобровольной госпитализации отметьте основание по ст. 29' : 'Не удалось оформить протокол', 'info');
    await afterAction();
  };
  const es = $('#ex-save');
  if (es) es.onclick = async () => {
    await api('POST', `/api/doctor/patients/${D.sel}/exam`, { dx: $('#ex-dx').value, post_covid: $('#ex-cov').checked, meds_reconciled: $('#ex-rec').checked, psychotic: $('#ex-psy').checked, bar_excluded: $('#ex-bar').checked, somatoform: $('#ex-som').checked, arrhythmia: $('#ex-arr').checked, tsh: $('#ex-tsh').value.trim().replace(',', '.') });
    D.examOpen = true; await afterAction();
  };
  const ed = $('#examd'); if (ed) ed.ontoggle = () => { D.examOpen = ed.open; };
  const ma = $('#medadd');
  if (ma) ma.onclick = async () => {
    const name = $('#medname').value.trim(); if (!name) return;
    const r = await api('POST', `/api/doctor/patients/${D.sel}/meds`, { name });
    if (r.ok && !r.data.known) toast('Препарата нет в справочнике: взаимодействия не проверены', 'info');
    await afterAction();
  };
  el.querySelectorAll('[data-rmmed]').forEach((b) => (b.onclick = async () => { await api('POST', `/api/doctor/patients/${D.sel}/meds`, { remove: Number(b.dataset.rmmed) }); await afterAction(); }));
  el.querySelectorAll('[data-adv]').forEach((b) => (b.onclick = async () => {
    const r = await api('POST', `/api/doctor/patients/${D.sel}/advice`, { action: b.dataset.adv, reason: $('#advr').value });
    if (!r.ok) return toast('Укажите причину (не менее 3 символов)', 'info');
    toast('Решение записано в журнал. Рецепт не создаётся.', 'info'); await afterAction();
  }));
  const rx = $('#rx'); if (rx) rx.onclick = openRxDialog;
  const stop = $('#stoprx'); if (stop) stop.onclick = async () => { await api('POST', `/api/doctor/patients/${D.sel}/prescriptions/${stop.dataset.rx}/stop`); await afterAction(); };
  const vc = $('#vclose'); if (vc) vc.onclick = async () => { await api('POST', `/api/doctor/patients/${D.sel}/visit`, { note: $('#vnote').value }); toast('Приём сохранён в историю решений', 'info'); await afterAction(); };
}
async function afterAction() { await refreshList(); await loadCard(); drawDoctor(); }

// Окно взаимодействий перед назначением
function openRxDialog() {
  const c = D.card, d = c.recommendation.drug, rcm = c.recommendation;
  const adv0 = rcm.advice || {};
  const need = d.status === 'contraindicated' || d.status === 'off_label' || !!rcm.soft_hold || adv0.state !== 'consider' || ['orange', 'grey'].includes(d.ddi_level);
  const why = [];
  if (d.status === 'off_label') why.push('вне зарегистрированных показаний: ' + d.indication.label);
  if (d.status === 'contraindicated') why.push('противопоказания по инструкции: ' + d.contraindications.join('; '));
  if (rcm.soft_hold) why.push(rcm.soft_hold);
  if (['orange', 'grey'].includes(d.ddi_level)) why.push('статус взаимодействий: ' + DDI_LBL[d.ddi_level]);
  const inter = d.interactions.map((i) => `<li class="ddi ${i.status}"><span class="chip-st ${i.status}">● ${DDI_LBL[i.status]}</span> <b>${esc(i.meds.join(', '))}</b><div class="small">${esc(i.action)}</div></li>`).join('');
  const el = document.createElement('div');
  el.className = 'modal'; el.id = 'rxmodal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="modal-box"><h2>Назначение: ${esc(d.drug.name)} · окно взаимодействий</h2>
    ${inter ? `<ul class="list" style="list-style:none;padding:0">${inter}</ul>` : '<p class="muted">Взаимодействий с внесёнными препаратами не выявлено.</p>'}
    ${d.unknown_meds.length ? `<p class="small chk-warn">Не проверено (нет в справочнике, статус серый): ${esc(d.unknown_meds.join(', '))}</p>` : ''}
    ${['yellow', 'orange'].includes(d.ddi_level) ? '<label class="chk"><input type="checkbox" id="rx-ack"> Ознакомлен(а) с рекомендациями по коррекции дозы и контролю</label>' : ''}
    ${need ? `<p class="small"><b>Требуется письменное обоснование (не менее 10 символов).</b><br>${why.map(esc).join('<br>')}</p><textarea id="rx-reason" rows="3" aria-label="Обоснование"></textarea>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn primary" id="rx-go">Подтвердить назначение</button><button class="btn" id="rx-cancel">Отмена</button></div></div>`;
  document.body.appendChild(el);
  $('#rx-cancel').onclick = () => el.remove();
  $('#rx-go').onclick = async () => {
    const ack = $('#rx-ack') ? $('#rx-ack').checked : true;
    const reason = $('#rx-reason') ? $('#rx-reason').value : '';
    if (!ack) return toast('Отметьте, что ознакомлены с рекомендациями по взаимодействиям', 'info');
    const r = await api('POST', `/api/doctor/patients/${D.sel}/prescribe`, { ddi_ack: ack, override_reason: reason });
    if (!r.ok) return toast(r.data.error === 'override_required' ? 'Укажите обоснование (не менее 10 символов)' : 'Назначение заблокировано правилами безопасности: ' + esc(r.data.error), 'info');
    el.remove(); await afterAction();
  };
  (need ? $('#rx-reason') : $('#rx-go')).focus();
}

function drawDynamics() {
  const c = D.card, el = $('#tabbody');
  const series = (k) => [...c.scales[k]].reverse().map((s) => ({ ts: s.ts, total: s.total }));
  const sp = [...c.sppvr].reverse();
  const spS = (k) => sp.map((s) => ({ ts: s.ts, total: k === 'ikso' ? s.quality.score : s[k] })).filter((x) => x.total != null);
  const dia = [...c.diary].reverse().filter((r) => r.anxiety != null).slice(-14).map((r) => ({ ts: r.ts, total: r.anxiety }));
  const a = c.adherence;
  const adh = !c.recommendation.has_active ? '<p class="muted">Терапия не назначена, приверженность не оценивается.</p>'
    : a.pct == null ? '<p class="muted">Нет данных дневника.</p>'
    : `<div class="row"><span class="big">${a.pct}%</span><span class="muted">доз принято за 14 дней</span></div>
       <div class="progress" aria-hidden="true"><i style="width:${a.pct}%;${a.pct < 70 ? 'background:var(--crit)' : ''}"></i></div>
       ${a.missed_streak >= 2 ? `<span class="badge ${a.missed_streak >= 3 ? 'crit' : 'warn'}">Пропусков подряд: ${a.missed_streak}</span>` : '<span class="muted small">Серий пропусков нет</span>'}`;
  const ae = c.adverse_events.length ? `<ul class="list">${c.adverse_events.map((x) => `<li>${esc(x.name)} <span class="muted">× ${x.count}</span></li>`).join('')}</ul>` : '<p class="muted">Нежелательных явлений не отмечено.</p>';
  const hist = c.sppvr.slice(0, 6).map((s) => `<tr><td>СППВР</td><td>${dShort(s.ts)}</td><td>PHQ-9 <b>${s.phq9 ?? '–'}</b> · ИКСО <b>${s.quality.score ?? '–'}</b></td><td>${esc(s.bands.phq9)}</td></tr>`).join('')
    + ['gad7', 'phq9'].map((k) => c.scales[k].slice(0, 4).map((s) => `<tr><td>${SC[k].name}</td><td>${dShort(s.ts)}</td><td><b>${s.total}</b></td><td>${esc(s.band)}</td></tr>`).join('')).join('');
  const rx = c.prescriptions.map((x) => `<li>${x.status === 'active' ? 'Принимает' : 'Отменён'} с ${dShort(x.started_ts)}${x.stopped_ts ? ' по ' + dShort(x.stopped_ts) : ''}</li>`).join('');
  el.innerHTML = `<div class="charts"><div class="card">${lineChart({ title: 'PHQ-9, СППВР (депрессия, 0–27)', points: spS('phq9'), max: 27, marks: MARKS.phq9 })}</div>
      <div class="card">${lineChart({ title: 'ИКСО: экспериментальный технический индикатор (0–100)', points: spS('ikso'), max: 100, marks: [50, 75, 90] })}</div>
      <div class="card">${lineChart({ title: 'GAD-7 (тревога, 0–21)', points: series('gad7'), max: 21, marks: MARKS.gad7 })}</div>
      <div class="card">${lineChart({ title: 'PHQ-9 (депрессия, 0–27)', points: series('phq9'), max: 27, marks: MARKS.phq9 })}</div>
      <div class="card">${lineChart({ title: 'Тревога по дневнику (0–10)', points: dia, max: 10, marks: [3, 6] })}</div></div>
    <div class="charts"><div class="card"><h2>Приверженность лечению</h2>${adh}</div>
      <div class="card"><h2>Нежелательные явления (дневник)</h2>${ae}</div>
      <div class="card"><h2>Профиль рисков</h2><div class="kv small"><b>СКФ</b><span>${c.patient.profile.egfr ?? '–'} мл/мин</span><b>Сопутствующее</b><span>${esc((c.patient.profile.conditions || []).join(', ') || 'нет')}</span>
        <b>Другие препараты</b><span>${esc(c.patient.meds.map((m) => m.name).join(', ') || 'нет')}</span></div>${rx ? `<h3 style="margin-top:8px">Назначения</h3><ul class="list">${rx}</ul>` : ''}</div></div>
    <div class="card"><h2>История измерений</h2><table class="small" style="width:100%;border-collapse:collapse"><tr class="muted"><td>Метод</td><td>Дата</td><td>Результат</td><td>Степень</td></tr>${hist}</table>
      <div class="src">GAD-7: Spitzer R.L. et al., Arch Intern Med 2006. PHQ-9: Kroenke K. et al., J Gen Intern Med 2001. Ответы о тревоге представлены отдельно без расчёта HADS-A.</div></div>`;
}

function drawChat() {
  const c = D.card, el = $('#tabbody');
  const msgs = c.messages.map((m) => `<div class="msg ${m.system ? 'system' : m.from_role}">${esc(m.text)}<time>${m.system ? 'автоматически · ' : ''}${dTime(m.ts)}</time></div>`).join('');
  el.innerHTML = `<div class="card"><h2>Сообщения</h2><div class="chat" id="chat">${msgs || '<p class="muted">Сообщений пока нет</p>'}</div>
    <form id="cf" class="row"><input type="text" class="grow" id="ct" placeholder="Сообщение пациенту" aria-label="Сообщение пациенту"><button class="btn primary">Отправить</button></form></div>`;
  const ch = $('#chat'); ch.scrollTop = ch.scrollHeight;
  $('#cf').onsubmit = async (e) => { e.preventDefault(); const t = $('#ct').value.trim(); if (!t) return; await api('POST', `/api/doctor/patients/${D.sel}/messages`, { text: t }); await loadCard(); drawCard(); };
}

const ACT = { prescription_confirmed: 'Назначение Авиандра подтверждено', prescription_stopped: 'Терапия отменена', referral_confirmed: 'Маршрут подтверждён', referral_dismissed: 'Маршрут отклонён', protocol_recorded: 'Оценка показаний к госпитализации', exam_saved: 'Осмотр: отметки сохранены', med_added: 'Препарат внесён в список', med_removed: 'Препарат удалён из списка', visit_closed: 'Приём завершён', alert_ack: 'Алерт принят', alert_action: 'По алерту выполнено действие', advice_confirmed: 'Рекомендация по Авиандру принята', advice_dismissed: 'Рекомендация по Авиандру отклонена', advice_changed: 'Рекомендация по Авиандру изменена' };
function drawJournal() {
  const c = D.card, el = $('#tabbody');
  const rows = c.decisions.map((x) => `<tr><td class="nowrap">${dTime(x.ts)}</td><td>${esc(x.name || 'система')}</td><td><b>${esc(ACT[x.action] || x.action)}</b><div class="small muted">${esc(x.detail || '')}</div></td></tr>`).join('');
  el.innerHTML = `<div class="card"><div class="sect-title"><h2>История клинических решений</h2></div>
    <p class="small muted">Каждое решение хранит автора, время и версию справочников (КР, инструкция, правила): <b>${esc(c.config_version)}</b>. Журнал защищён цепочкой хэшей.</p>
    <table class="small jt"><tr class="muted"><td>Время</td><td>Автор</td><td>Решение</td></tr>${rows || '<tr><td colspan="3" class="muted">Решений пока нет</td></tr>'}</table>
    <div class="row" style="margin-top:10px"><button class="btn" id="verify">Проверить целостность журнала</button><span id="vres" class="small"></span></div></div>`;
  $('#verify').onclick = async () => {
    const r = await api('GET', '/api/doctor/audit/verify');
    $('#vres').innerHTML = r.data.ok ? `<span class="good">✓ цепочка не нарушена, записей: ${r.data.n}</span>` : `<span class="chk-crit">⚠ нарушение на записи ${r.data.broken_at}</span>`;
  };
}

// =============== ПАЦИЕНТ ===============
const P = { home: null, view: 'home', scales: null, spp: null, step: 0, answers: [], result: null, diary: null, sosArmed: false, sc: null, t0: 0 };

async function patientApp(me) {
  P.me = me;
  const all = (await api('GET', '/api/scales')).data;
  P.spp = all.sppvr; delete all.sppvr; P.scales = all;
  if (!await loadHome()) { app.innerHTML = '<div class="login"><div class="card"><h2>Нет связи с приложением</h2><p>Проверьте подключение и попробуйте снова.</p><button class="btn primary" id="retry-connection">Повторить</button></div></div>'; $('#retry-connection').onclick = () => patientApp(me); return; }
  try { P.earlyPending = JSON.parse(sessionStorage.getItem('cc-early-' + me.id) || 'null'); } catch { P.earlyPending = null; }
  try { P.fullPending = JSON.parse(sessionStorage.getItem('cc-full-' + me.id) || 'null'); } catch { P.fullPending = null; }
  if (P.earlyPending || P.home.sppvr.early_pending) { P.result = { safety_question: true, alert: true }; P.view = 'c7'; }
  else if (P.fullPending) P.view = 'submitting';
  drawPatient();
  if (P.earlyPending) ensureEarlySafety().then(paintEarlyStatus);
  // обновление статуса сигнала и сообщений без перезагрузки страницы
  if (P.poll) clearInterval(P.poll);
  P.poll = setInterval(async () => {
    if (P.view !== 'home' || document.activeElement?.id === 'ct') return;
    const prev = JSON.stringify([P.home.safety && P.home.safety.status, P.home.messages.length]);
    await loadHome();
    if (JSON.stringify([P.home.safety && P.home.safety.status, P.home.messages.length]) !== prev) drawPatient();
  }, 3000);
}
async function loadHome() { const prev = P.home && P.home.game ? P.home.game.points : null; const r = await api('GET', '/api/patient/home'); if (!r.ok) return false; P.home = r.data; P.gain = prev == null ? 0 : Math.max(0, P.home.game.points - prev); return true; }

// ---------- Овечка и искры ----------
// Лёгкий маскот: картинки WebP/PNG (mascot/sheep.js). Поза care — без покачивания.
const MASCOT = (pose, cls = '') => sheepHTML(pose, cls);
function levelBar(g) {
  return `<div class="lvl"><div class="lvl-h"><b>Уровень ${g.level.n}: ${esc(g.level.name)}</b><span>✦ ${g.points}</span></div>
    <div class="progress"><i style="width:${g.level.pct}%"></i></div>
    <small class="muted">${g.level.next_min != null ? `до уровня «${esc(g.level.next_name)}»: ещё ${g.level.next_min - g.points} искр` : 'Высший уровень, спасибо, что вы с нами!'}</small></div>`;
}
function mascotMsg(h) {
  const g = h.game, due = h.scales.find((s) => s.due);
  if (h.sppvr.due) return `Опросник · <b>+${g.rewards.sppvr} искр</b>`;
  if (due) return `Шкала · <b>+${g.rewards.scale} искр</b>`;
  if (!g.diary_today) return `Дневник · <b>+${g.rewards.diary} искр</b>`;
  return 'Овечка рядом';
}
function mascotCard(h) {
  const g = h.game; if (!g) return '';
  const gain = P.justGain ? `<div class="gain" role="status">+${P.justGain} искр! ✦</div>` : '';
  return `<div class="mascot-card">${MASCOT(P.justGain ? 'cheer' : 'wave')}<div class="mc-body"><div class="bubble">${gain || mascotMsg(h)}</div>
    ${g.streak > 1 ? `<div class="mc-stats"><span class="chipx">серия дней: ${g.streak}</span></div>` : ''}${levelBar(g)}</div></div>`;
}
const gainBlock = (g) => (P.gain > 0 && g ? `<div class="gain big" role="status">+${P.gain} искр ✦</div>${levelBar(g)}` : '');

function pTop() {
  return `<div class="topbar"><div class="brand">${LOGO}<span>Клинический компас</span></div></div>`;
}
function drawPatient() {
  P.drawnAt = Date.now();
  if (P.view === 'home') return drawPHome();
  if (P.view === 'intro') return drawIntro();
  if (P.view === 'sppvr') return drawSppvrQ();
  if (P.view === 'sresult') return drawSResult();
  if (P.view === 'submitting') return drawSubmitPending();
  if (P.view === 'c7') return drawC7();
  if (P.view === 'clin') return drawClin();
  if (P.view === 'safety') return drawSafety();
  if (P.view === 'scale') return drawScale();
  if (P.view === 'result') return drawResult();
  if (P.view === 'diary') return drawDiary();
}
const phones = (h) => {
  const e = (h.safety && h.safety.emergency) || h.emergency.emergency;
  const g = (h.safety && h.safety.hotline) || h.emergency.hotline;
  const tel = (p) => 'tel:' + p.replace(/[^\d+]/g, '');
  return `<div class="phones"><a class="phone" href="${tel(e.phone)}"><span>${esc(e.label)}</span><b>${esc(e.phone)}</b></a>
    <a class="phone" href="${tel(g.phone)}"><span>${esc(g.label.replace(/\s*\(круглосуточно\)/i, ''))}</span><b>${esc(g.phone)}</b></a></div>`;
};
const firstName = (h) => h.name.split(' ')[1] || h.name;
const docContact = (h) => {
  const d = h.safety && h.safety.doctor_contact;
  if (d && d.phone.replace(/\D/g, '') === '70000000000') return '<p class="small">Демо: телефон врача не указан.</p>';
  return d ? `<a class="phone doc" href="tel:${d.phone.replace(/[^\d+]/g, '')}"><span>${esc(d.label)}<small>${esc(h.doctor.name)}</small></span><b>${esc(d.phone)}</b></a>` : '';
};
function safetyBanner(h) {
  if (!h.safety) return '';
  return h.safety.status === 'acknowledged'
    ? `<div class="banner ok" role="status"><div class="ico">✓</div><div><b>${esc(firstName(h))}, врач получил ваш сигнал и свяжется с вами.</b><br>Если вам стало хуже или есть угроза жизни, звоните 112.${phones(h)}</div></div>`
    : `<div class="banner soft" role="status">${MASCOT('care', 'sm')}<div><b>${esc(firstName(h))}, благодарим за заполнение опросника.</b> Рекомендуем связаться с врачом: мы уже передали ему ваши ответы.<div class="phones">${docContact(h)}</div></div></div>`;
}
function drawPHome() {
  const h = P.home, g = h.game;
  const dueScale = h.scales.find((s) => s.due);
  const cta = h.sppvr.due ? ['data-sppvr', 'Пройти опросник']
    : dueScale ? [`data-scale="${dueScale.id}"`, `Пройти шкалу «${dueScale.name}»`]
    : !g.diary_today ? ['data-diary', 'Заполнить дневник'] : null;
  const row = (attr, name, hint) => `<button class="qrow" ${attr}><span><b>${esc(name)}</b><small>${esc(hint)}</small></span><i>›</i></button>`;
  const more = (cta && cta[0] === 'data-sppvr' ? '' : row('data-sppvr', 'Опросник СППВР', `${h.sppvr.total} вопросов, отвечайте в своём темпе`))
    + (h.sppvr.history && h.sppvr.history.length && !h.sppvr.clinical_done ? row('data-clin', 'О здоровье и лекарствах', 'по желанию, помогает врачу') : '')
    + h.scales.filter((s) => !(cta && cta[0] === `data-scale="${s.id}"`)).map((s) => row(`data-scale="${s.id}"`, s.name, s.purpose)).join('')
    + (cta && cta[0] === 'data-diary' ? '' : row('data-diary', 'Дневник самочувствия', 'настроение, сон, самочувствие'));
  const th = h.therapy ? `<details class="fold"><summary>Моя терапия</summary><div class="fold-b"><b>${esc(h.therapy.drug)}</b><div class="small muted">${esc(h.therapy.regimen)}</div>
    ${h.adherence.pct != null ? `<div class="row" style="margin-top:8px"><span class="big">${h.adherence.pct}%</span><span class="muted small">доз принято за 2 недели</span></div><div class="progress"><i style="width:${h.adherence.pct}%"></i></div>` : ''}</div></details>` : '';
  const charts = h.scales.map((s) => s.history.length ? `<div style="margin-bottom:10px">${lineChart({ title: `${s.name}: моя динамика`, points: s.history, max: s.max, marks: MARKS[s.id], w: 320 })}</div>` : '').join('');
  const dyn = !h.safety && charts ? `<details class="fold"><summary>Моя динамика</summary><div class="fold-b">${charts}</div></details>` : '';
  const msgs = h.messages.map((m) => `<div class="msg ${m.system ? 'system' : m.from_role}">${esc(m.text)}<time>${dTime(m.ts)}</time></div>`).join('');
  const mc = h.safety ? '' : mascotCard(h); P.justGain = 0;
  const sos = P.sosArmed
    ? `<div class="banner soft"><div class="grow"><b>Сообщить врачу срочно?</b><div class="row" style="margin-top:8px"><button class="btn danger grow" id="sosgo">Да, мне нужна помощь</button><button class="btn" id="sosno">Отмена</button></div></div></div>`
    : `<p class="sos-line"><button class="linkbtn" id="sos">Мне срочно нужна помощь</button><small>Сразу оповестит врача. При угрозе жизни звоните 112.</small></p>`;
  app.innerHTML = `${pTop()}<div class="pat calm">${safetyBanner(h)}${mc}
    ${cta ? `<button class="btn primary big-cta" ${cta[0]}>${cta[1]}</button>` : ''}
    ${more ? `<details class="fold"><summary>Ещё</summary><div class="fold-b">${more}</div></details>` : ''}
    ${th}${dyn}
    <details class="fold" ${P.chatOpen ? 'open' : ''}><summary>Связь с врачом</summary><div class="fold-b"><p class="small muted" style="margin:0 0 8px">${esc(h.doctor.name)}, ${esc(h.doctor.specialty)}. Всё, что вы вводите, видит только ваш врач.</p>
      <div class="chat" id="chat">${msgs || '<p class="muted small">Здесь можно написать врачу</p>'}</div>
      <form id="cf" class="row"><input type="text" class="grow" id="ct" placeholder="Сообщение врачу" aria-label="Сообщение врачу"><button class="btn primary">Отправить</button></form></div></details>
    ${sos}
    <p class="foot"><button class="linkbtn" id="lo">Выйти</button></p></div>`;
  $('#lo').onclick = logout;
  app.querySelectorAll('[data-clin]').forEach((b) => (b.onclick = () => { P.view = 'clin'; P.cstep = 0; P.clin = {}; drawPatient(); }));
  const sp = app.querySelector('[data-sppvr]'); if (sp) app.querySelectorAll('[data-sppvr]').forEach((b) => (b.onclick = () => { P.view = 'intro'; drawPatient(); }));
  app.querySelectorAll('[data-scale]').forEach((b) => (b.onclick = () => { P.view = 'scale'; P.sc = b.dataset.scale; P.step = 0; P.answers = []; drawPatient(); }));
  app.querySelectorAll('[data-diary]').forEach((b) => (b.onclick = () => { P.view = 'diary'; P.diary = { mood: 5, anxiety: 5, sleep_hours: 7, doses_taken: h.therapy ? 2 : 0, side_effects: [], note: '' }; drawPatient(); }));
  const sosB = $('#sos'); if (sosB) sosB.onclick = () => { P.sosArmed = true; drawPatient(); };
  const no = $('#sosno'); if (no) no.onclick = () => { P.sosArmed = false; drawPatient(); };
  const go = $('#sosgo'); if (go) go.onclick = async () => { await api('POST', '/api/patient/sos'); P.sosArmed = false; await loadHome(); drawPatient(); window.scrollTo(0, 0); };
  $('#cf').onsubmit = async (e) => { e.preventDefault(); const t = $('#ct').value.trim(); if (!t) return; await api('POST', '/api/patient/messages', { text: t }); await loadHome(); P.chatOpen = true; drawPatient(); };
  const ch = $('#chat'); if (ch) ch.scrollTop = ch.scrollHeight;
}

// ---------- СППВР ----------
function drawIntro() {
  app.innerHTML = `<div class="pat"><button class="back" id="back" aria-label="Назад">←</button>
    <h2 style="margin-top:14px">${esc(P.spp.title)}</h2>
    <div class="card"><p>Вопросы о том, как вы себя чувствовали ${esc(P.spp.period)}. Здесь нет правильных и неправильных ответов, выбирайте то, что ближе всего.</p>
      <p class="small muted">Ответы увидит только ваш врач. Опросник не ставит диагноз: решения принимает врач.</p>
      
      <button class="btn primary" style="width:100%" id="begin">Начать</button></div></div>`;
  $('#lo') && ($('#lo').onclick = logout);
  $('#back').onclick = () => { P.view = 'home'; drawPatient(); };
  $('#begin').onclick = async () => { const b = $('#begin'); b.disabled = true; const r = await api('POST', '/api/patient/sppvr/start'); if (!r.ok) { b.disabled = false; toast('Нет связи. Проверьте подключение и попробуйте ещё раз.', 'info'); return; } P.t0 = Date.now(); P.step = 0; P.answers = []; P.itemSec = []; P.tq = null; P.view = 'sppvr'; drawPatient(); };
}
// Активное время по каждому вопросу: пауза при скрытой вкладке не считается.
// Результат только для технической оценки согласованности (ИКСО) и не влияет на суммы шкал.
function tqStart() { P.tq = document.hidden ? null : Date.now(); }
function tqStop(i) { if (P.tq) { P.itemSec[i] = Math.round(((P.itemSec[i] || 0) + (Date.now() - P.tq) / 1000) * 10) / 10; P.tq = null; } }
document.addEventListener('visibilitychange', () => { if (P.view !== 'sppvr') return; if (document.hidden) tqStop(P.step); else tqStart(); });
function drawSppvrQ() {
  const qs = P.spp.questions, n = qs.length, i = P.step, q = qs[i];
  tqStart();
  const opts = q.options || P.spp.options;
  app.innerHTML = `<div class="pat"><button class="back" id="back" aria-label="Назад">←</button>
    <div class="small muted" style="margin-top:14px">${esc(P.spp.blocks[q.block])}</div>
    <h2 style="margin-top:4px">Вопрос ${i + 1} из ${n}</h2><div class="progress"><i style="width:${(i / n) * 100}%"></i></div>
    <p class="small muted">${q.kind === 'attention' ? 'Небольшая проверка понимания.' : 'Как часто это было ' + esc(P.spp.period) + '?'}</p>
    <p style="font-size:18px;font-weight:600">${esc(q.text)}</p>
    <div class="opts">${opts.map((o) => `<button class="opt ${P.answers[i] === o.v ? 'on' : ''}" data-v="${o.v}">${esc(o.t)}</button>`).join('')}</div>
    <div class="row spread" style="margin-top:6px">${i > 0 ? '<button class="linkbtn" id="prev">Предыдущий вопрос</button>' : '<span></span>'}<button class="linkbtn" id="skip">Пропустить вопрос</button></div></div>`;
  $('#back').onclick = () => { tqStop(i); P.view = 'home'; drawPatient(); };
  const prev = $('#prev'); if (prev) prev.onclick = () => { tqStop(i); P.step--; drawPatient(); };
  const next = async (v) => {
    if (P.sending || Date.now() - P.drawnAt < 250) return;
    tqStop(i);
    P.answers[i] = v;
    if (i === 8 && v > 0) {
      const ans = Array.from({ length: n }, (_, k) => k < 9 && P.answers[k] !== undefined ? P.answers[k] : null);
      const sec = Array.from({ length: n }, (_, k) => k < 9 ? (P.itemSec[k] ?? 0) : null);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
      P.earlyPending = { token, answers: ans, item_sec: sec, elapsed_sec: Math.round((Date.now() - P.t0) / 100) / 10 };
      try { sessionStorage.setItem('cc-early-' + P.me.id, JSON.stringify(P.earlyPending)); } catch {}
      P.result = { safety_question: true, alert: true };
      P.view = 'c7'; drawPatient(); window.scrollTo(0, 0);
      ensureEarlySafety().then(paintEarlyStatus);
      return;
    }
    if (i + 1 < n) { P.step++; return drawPatient(); }
    const ans = Array.from({ length: n }, (_, k) => (P.answers[k] === undefined ? null : P.answers[k]));
    const sec = Array.from({ length: n }, (_, k) => P.itemSec[k] ?? 0);
    P.sending = true;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
    P.fullPending = { answers: ans, item_sec: sec, elapsed_sec: Math.round((Date.now() - P.t0) / 100) / 10, submission_token: token };
    try { sessionStorage.setItem('cc-full-' + P.me.id, JSON.stringify(P.fullPending)); } catch {}
    P.sending = false; P.view = 'submitting'; drawPatient(); window.scrollTo(0, 0);
    sendFullSubmission();
  };
  app.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => next(Number(b.dataset.v))));
  $('#skip').onclick = () => next(null);
}
function drawSubmitPending() {
  app.innerHTML = `${pTop()}<div class="pat"><div class="card">
    <h2>Отправка ответов</h2><p id="submit-status" role="status">Подтвердите отправку, если она ещё не завершена.</p>
    <button class="btn primary" id="submit-retry" style="width:100%">Повторить отправку</button>
    <p class="small muted">До подтверждения отправки не закрывайте вкладку: ответы сохранены в ней для повтора.</p>
    </div></div>`;
  $('#submit-retry').onclick = sendFullSubmission;
}
async function sendFullSubmission() {
  if (P.fullSending || !P.fullPending) return;
  P.fullSending = true;
  const btn = $('#submit-retry'); if (btn) btn.disabled = true;
  const status = $('#submit-status'); if (status) status.textContent = 'Отправляем ответы…';
  const r = await api('POST', '/api/patient/sppvr', P.fullPending, 8000);
  P.fullSending = false;
  if (!r.ok) {
    if ($('#submit-status')) $('#submit-status').textContent = 'Отправка не подтверждена. Проверьте связь и повторите.';
    if ($('#submit-retry')) $('#submit-retry').disabled = false;
    return;
  }
  P.fullPending = null;
  try { sessionStorage.removeItem('cc-full-' + P.me.id); } catch {}
  P.result = r.data;
  if (!await loadHome()) P.result.history_unavailable = true;
  P.view = r.data.safety_question ? 'c7' : r.data.alert || P.home.safety ? 'safety' : 'sresult';
  drawPatient(); window.scrollTo(0, 0);
}
async function ensureEarlySafety() {
  if (!P.earlyPending) return true;
  if (P.earlyPromise) return P.earlyPromise;
  P.earlyPromise = (async () => {
    const r = await api('POST', '/api/patient/sppvr/early-safety', P.earlyPending, 8000);
    if (!r.ok) return false;
    P.result = r.data; P.earlyPending = null;
    try { sessionStorage.removeItem('cc-early-' + P.me.id); } catch {}
    await loadHome();
    return true;
  })();
  const ok = await P.earlyPromise; P.earlyPromise = null;
  return ok;
}
function paintEarlyStatus() {
  const el = $('#early-status'); if (!el) return;
  el.textContent = P.earlyPending ? 'Нет подтверждения отправки. Проверьте связь; ответ можно отправить повторно.' : 'Ответы сохранены.';
}
function drawSResult() {
  const r = P.result || {};
  if (!shouldShowMetrics(r, P.home.safety)) return drawSafety();
  const clinDone = P.home.sppvr.clinical_done;
  app.innerHTML = `${pTop()}<div class="pat"><div class="card" style="text-align:center">${MASCOT(P.gain > 0 ? 'happy' : 'wave', 'lg')}<h2>${esc(firstName(P.home))}, благодарим за заполнение опросника</h2>
    <div class="submission-status" role="status">✓ Отправлено · доступно врачу</div>
    <p class="muted">Врач увидит ответы и обсудит результат с вами. Рекомендуем связаться с врачом, если вам станет хуже.</p>${gainBlock(P.home.game)}
    ${r.retry_suggested ? '<p class="small muted">Врач может попросить вас уточнить некоторые ответы.</p>' : ''}</div>
    ${r.history_unavailable ? '<div class="card">Ответы отправлены. Данные для графика сейчас недоступны: проверьте подключение.</div>' : patientMetricsHTML(P.home.sppvr.history)}
    ${clinDone ? '' : `<div class="card"><b>Несколько вопросов о здоровье и лекарствах</b><p class="small muted" style="margin:4px 0 10px">По желанию. Так врачу проще проверить безопасность лечения. На любой вопрос можно ответить «не знаю».</p><button class="btn" style="width:100%" id="clin">Ответить сейчас</button></div>`}
    <button class="btn primary" style="width:100%" id="ok">Готово</button></div>`;
  const cb = $('#clin'); if (cb) cb.onclick = () => { P.view = 'clin'; P.cstep = 0; P.clin = {}; drawPatient(); };
  $('#ok').onclick = () => { P.view = 'home'; drawPatient(); };
}
// C7: уточнение безопасности сразу после положительного ответа на пункт 9 PHQ-9
function drawC7() {
  const f = P.spp.clinical.safety;
  app.innerHTML = `<div class="pat"><div class="card calm-c7">${MASCOT('care', 'sm')}<h2 style="margin-top:8px">Спасибо, что ответили честно</h2>
    <p>${esc(f.text)}</p>
    <div class="opts">${f.options.map((o) => `<button class="opt" data-v="${o.v}">${esc(o.t)}</button>`).join('')}</div>
    <p class="small muted" id="early-status">${P.earlyPending ? 'Отправляем ответы…' : 'Ответы сохранены.'}</p>
    <p class="small muted">Если вам нужна помощь прямо сейчас, звоните 112.</p>${phones(P.home)}</div></div>`;
  app.querySelectorAll('[data-v]').forEach((b) => (b.onclick = async () => {
    if (P.c7Sending) return;
    P.c7Sending = true; app.querySelectorAll('[data-v]').forEach((x) => { x.disabled = true; });
    const v = b.dataset.v;
    if (!await ensureEarlySafety()) { P.c7Sending = false; app.querySelectorAll('[data-v]').forEach((x) => { x.disabled = false; }); paintEarlyStatus(); return; }
    const sent = await api('POST', '/api/patient/sppvr/clinical', { safety: v });
    P.c7Sending = false;
    if (!sent.ok) { app.querySelectorAll('[data-v]').forEach((x) => { x.disabled = false; }); toast('Не удалось подтвердить отправку. Проверьте связь.', 'info'); return; }
    await loadHome();
    const urgent = f.immediate.includes(v) || P.result.alert || !!P.home.safety;
    P.view = urgent ? 'safety' : 'sresult'; drawPatient(); window.scrollTo(0, 0);
  }));
}
// Клинический блок: необязательный, 4 экрана, «не знаю» сохраняется как неизвестное
const CLIN_SCREENS = [['duration', 'functioning'], ['meds_status', 'adverse', 'mania'], ['somatic_hx', 'organ', 'pregnancy'], ['alcohol', 'substances', 'nicotine']];
function drawClin() {
  const cfg = P.spp.clinical, female = P.home.sppvr.female;
  const keys = CLIN_SCREENS[P.cstep].filter((k) => k !== 'pregnancy' || female);
  const last = P.cstep === CLIN_SCREENS.length - 1;
  const field = (k) => {
    const f = cfg[k], cur = P.clin[k];
    const on = (v) => (f.multi ? (cur || []).includes(v) : cur === v);
    const opts = [...f.options, ...(f.exclusive || [])];
    let extra = '';
    if (k === 'meds_status' && cur === 'taking') {
      P.clin.meds = P.clin.meds || [{}, {}];
      extra = `<div class="small muted" style="margin:6px 0">Название с упаковки. Если не знаете, оставьте поле пустым и напишите, для чего принимаете.</div>${P.clin.meds.map((m, i) => `<div class="medrow"><input type="text" data-med="${i}" data-f="name" placeholder="Название" value="${esc(m.name || '')}" aria-label="Название лекарства ${i + 1}"><input type="text" data-med="${i}" data-f="dose" placeholder="Доза" value="${esc(m.dose || '')}" aria-label="Доза ${i + 1}"><input type="text" data-med="${i}" data-f="purpose" placeholder="Для чего" value="${esc(m.purpose || '')}" aria-label="Для чего ${i + 1}"></div>`).join('')}<button class="linkbtn" id="addmed">Добавить ещё лекарство</button>`;
    }
    return `<fieldset class="cq"><legend>${esc(f.text)}</legend>${f.multi ? '<div class="small muted">Можно выбрать несколько</div>' : ''}<div class="opts">${opts.map((o) => `<button type="button" class="opt ${on(o.v) ? 'on' : ''}" data-k="${k}" data-v="${esc(String(o.v))}" aria-pressed="${on(o.v)}">${esc(o.t)}</button>`).join('')}</div>${extra}</fieldset>`;
  };
  app.innerHTML = `<div class="pat"><button class="back" id="back" aria-label="Назад">←</button>
    <h2 style="margin-top:14px">О здоровье · ${P.cstep + 1} из ${CLIN_SCREENS.length}</h2><div class="progress"><i style="width:${(P.cstep / CLIN_SCREENS.length) * 100}%"></i></div>
    <p class="small muted">По желанию. На любой вопрос можно ответить «не знаю» или пропустить: это не считается ответом «нет».</p>
    ${keys.map(field).join('')}
    <div class="row" style="margin-top:12px"><button class="btn primary grow" id="cnext">${last ? 'Отправить врачу' : 'Дальше'}</button></div>
    <div class="row spread"><button class="linkbtn" id="cskip">Пропустить блок</button>${P.cstep ? '<button class="linkbtn" id="cprev">Назад</button>' : ''}</div></div>`;
  const num = (k, v) => (k === 'functioning' ? Number(v) : v);
  app.querySelectorAll('.cq .opt').forEach((b) => (b.onclick = () => {
    const k = b.dataset.k, f = cfg[k], v = num(k, b.dataset.v);
    if (f.multi) {
      const ex = (f.exclusive || []).some((o) => o.v === v);
      let a = P.clin[k] || [];
      a = a.includes(v) ? a.filter((x) => x !== v) : ex ? [v] : [...a.filter((x) => !(f.exclusive || []).some((o) => o.v === x)), v];
      P.clin[k] = a;
    } else P.clin[k] = P.clin[k] === v ? undefined : v;
    drawClin();
  }));
  app.querySelectorAll('[data-med]').forEach((inp) => (inp.oninput = () => { P.clin.meds[Number(inp.dataset.med)][inp.dataset.f] = inp.value; }));
  const am = $('#addmed'); if (am) am.onclick = () => { P.clin.meds.push({}); drawClin(); };
  const back = () => { P.view = 'sresult'; drawPatient(); };
  $('#back').onclick = back;
  const pv = $('#cprev'); if (pv) pv.onclick = () => { P.cstep--; drawClin(); };
  const send = async () => {
    const body = {};
    for (const [k, v] of Object.entries(P.clin)) if (v !== undefined && !(Array.isArray(v) && !v.length && k !== 'meds')) body[k] = v;
    if (Object.keys(body).length) {
      if (body.meds) body.meds = body.meds.filter((m) => m.name || m.purpose || m.dose);
      const r = await api('POST', '/api/patient/sppvr/clinical', body);
      if (!r.ok) return toast('Не удалось сохранить, попробуйте ещё раз', 'info');
      toast('Спасибо, сведения переданы врачу', 'info');
    }
    await loadHome();
    P.view = P.home.safety ? 'safety' : 'home'; drawPatient(); window.scrollTo(0, 0);
  };
  $('#cnext').onclick = () => { if (!last) { P.cstep++; return drawClin(); } send(); };
  $('#cskip').onclick = send;
}
// Протокол безопасности: весь экран, телефоны экстренных служб
function drawSafety() {
  const h = P.home;
  app.innerHTML = `<div class="safety" role="status">${MASCOT('care', 'lg')}
    <p class="small">Учебный прототип: контакты требуют проверки командой.</p>
    <h1>${esc(firstName(h))}, благодарим за заполнение опросника</h1>
    <p class="sf-p">Рекомендуем связаться с врачом. Мы передали ему ваши ответы, он увидит их и ответит вам. Врач сам решит, какая помощь нужна.</p>
    <div class="phones">${docContact(h)}</div>
    <p class="sf-p small">Если станет хуже или вам нужна помощь прямо сейчас, позвоните:</p>
    ${phones(h)}
    <button class="btn" id="ok" style="margin-top:18px;width:100%">Вернуться в приложение</button></div>`;
  $('#ok').onclick = () => { P.view = 'home'; drawPatient(); };
}

// ---------- полные шкалы (GAD-7, PHQ-9) ----------
function drawScale() {
  const def = P.scales[P.sc], n = def.items.length, i = P.step;
  app.innerHTML = `<div class="pat"><button class="back" id="back" aria-label="Назад">←</button>
    <h2 style="margin-top:14px">${esc(def.name)} · вопрос ${i + 1} из ${n}</h2><div class="progress"><i style="width:${(i / n) * 100}%"></i></div>
    <p class="small muted">${esc(def.intro)}</p><p style="font-size:18px;font-weight:600">${esc(def.items[i])}</p>
    <div class="opts">${def.options.map((o) => `<button class="opt ${P.answers[i] === o.v ? 'on' : ''}" data-v="${o.v}">${esc(o.t)}</button>`).join('')}</div>
    ${i > 0 ? '<button class="linkbtn" id="prev">Предыдущий вопрос</button>' : ''}</div>`;
  $('#lo') && ($('#lo').onclick = logout);
  $('#back').onclick = () => { P.view = 'home'; drawPatient(); };
  const prev = $('#prev'); if (prev) prev.onclick = () => { P.step--; drawPatient(); };
  app.querySelectorAll('[data-v]').forEach((b) => (b.onclick = async () => {
    if (P.scaleSending || Date.now() - P.drawnAt < 250) return;
    P.answers[i] = Number(b.dataset.v);
    if (i + 1 < n) { P.step++; return drawPatient(); }
    P.scaleSending = true; app.querySelectorAll('[data-v]').forEach((x) => { x.disabled = true; });
    const r = await api('POST', `/api/patient/scales/${P.sc}`, { answers: P.answers });
    P.scaleSending = false;
    if (!r.ok) { app.querySelectorAll('[data-v]').forEach((x) => { x.disabled = false; }); return toast('Не удалось отправить ответы. Проверьте связь и попробуйте ещё раз.', 'info'); }
    P.result = { ...r.data, scale: P.sc };
    await loadHome(); P.view = r.data.alert ? 'safety' : 'result'; drawPatient();
  }));
}
function drawResult() {
  const r = P.result, def = P.scales[r.scale];
  if (P.home.safety || r.alert) return drawSafety();
  app.innerHTML = `${pTop()}<div class="pat">
    <div class="card" style="text-align:center">${MASCOT(P.gain > 0 ? 'happy' : 'wave', 'lg')}<div class="muted">${esc(def.name)}</div><div class="big">${r.total} <span class="muted" style="font-size:16px">из ${def.max}</span></div>
      <p class="muted">Результат передан вашему врачу. Оценивает и принимает решения врач.</p>${gainBlock(P.home.game)}</div>
    <button class="btn primary" style="width:100%" id="ok">Готово</button></div>`;
  $('#ok').onclick = () => { P.view = 'home'; drawPatient(); };
}


function drawDiary() {
  const d = P.diary, h = P.home;
  const chip = (name, sev) => `<button type="button" class="chip ${sev ? 'severe' : ''} ${d.side_effects.includes(name) ? 'on' : ''}" data-se="${esc(name)}">${esc(name)}</button>`;
  app.innerHTML = `<div class="pat"><button class="back" id="back" aria-label="Назад">←</button><h2 style="margin-top:14px">Дневник самочувствия</h2>
    <div class="card"><label for="mood"><b>Настроение:</b> <span id="mv">${d.mood}</span> из 10</label><input type="range" id="mood" min="0" max="10" value="${d.mood}">
      <label for="anx"><b>Тревога:</b> <span id="av">${d.anxiety}</span> из 10</label><input type="range" id="anx" min="0" max="10" value="${d.anxiety}">
      <label for="slp"><b>Сон прошлой ночью:</b> <span id="sv">${d.sleep_hours}</span> ч</label><input type="range" id="slp" min="0" max="14" step="0.5" value="${d.sleep_hours}"></div>
    ${h.therapy ? `<div class="card"><b>Принято доз сегодня (${esc(h.therapy.drug)})</b><div class="chips">${[0, 1, 2].map((n) => `<button type="button" class="chip ${d.doses_taken === n ? 'on' : ''}" data-dose="${n}">${n} из 2</button>`).join('')}</div></div>` : ''}
    <div class="card"><b>Что беспокоит</b><div class="chips">${[...h.side_effects.common, ...h.side_effects.uncommon.slice(0, 5)].map((s) => chip(s)).join('')}</div>
      <b style="color:var(--crit)">⚠ Срочные симптомы</b><div class="chips">${h.severe_events.map((s) => chip(s, true)).join('')}</div></div>
    <div class="card"><label for="nt"><b>Заметка врачу</b></label><textarea id="nt" rows="2">${esc(d.note)}</textarea></div>
    <button class="btn primary" style="width:100%" id="save">Отправить врачу</button></div>`;
  $('#lo') && ($('#lo').onclick = logout);
  $('#back').onclick = () => { P.view = 'home'; drawPatient(); };
  const bind = (id, key, out, num = true) => { $(id).oninput = (e) => { d[key] = num ? Number(e.target.value) : e.target.value; if (out) $(out).textContent = d[key]; }; };
  bind('#mood', 'mood', '#mv'); bind('#anx', 'anxiety', '#av'); bind('#slp', 'sleep_hours', '#sv'); bind('#nt', 'note', null, false);
  app.querySelectorAll('[data-se]').forEach((b) => (b.onclick = () => { const s = b.dataset.se; d.side_effects = d.side_effects.includes(s) ? d.side_effects.filter((x) => x !== s) : [...d.side_effects, s]; b.classList.toggle('on'); }));
  app.querySelectorAll('[data-dose]').forEach((b) => (b.onclick = () => { d.doses_taken = Number(b.dataset.dose); app.querySelectorAll('[data-dose]').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#save').onclick = async () => {
    const sv = $('#save'); if (sv.disabled) return; sv.disabled = true;
    const r = await api('POST', '/api/patient/diary', d);
    if (!r.ok) { sv.disabled = false; return toast('Не удалось отправить дневник. Проверьте связь и попробуйте ещё раз.', 'info'); }
    await loadHome(); P.justGain = P.gain; P.view = 'home'; drawPatient(); window.scrollTo(0, 0); if (r.data.alert) window.scrollTo(0, 0); };
}

boot();
