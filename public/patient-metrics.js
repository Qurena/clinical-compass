// Только уже рассчитанные суммы СППВР. Клинических интерпретаций здесь нет.
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const safeScore = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
export function shouldShowMetrics(result, safety) {
  return !!result && !result.alert && !result.safety_question && !safety;
}
export function patientMetricsHTML(history = []) {
  const rows = Array.isArray(history) ? history.filter((r) =>
    r && Number.isFinite(r.ts) && Number.isFinite(new Date(r.ts).getTime())).slice(-5) : [];
  if (!rows.length) return '<section class="card patient-metrics"><h2>Ваши ответы</h2><p>Пока нет данных для отображения.</p></section>';
  const one = (key, label, max) => {
    const current = rows[rows.length - 1][key];
    const available = rows.filter((r) => safeScore(r[key], max));
    const desc = available.length > 1 ? 'Несколько заполнений показывают изменения ваших ответов.' :
      available.length === 1 ? 'Первая точка: после следующих заполнений будет видна динамика.' :
      'Пока нет полной суммы для отображения.';
    const lines = rows.map((r) => {
      const date = escapeHTML(new Date(r.ts).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' }));
      const valid = safeScore(r[key], max), value = valid ? r[key] : null;
      return `<li class="metric-row"><span class="metric-date">${date}</span><span class="metric-track" aria-hidden="true"><i style="--fill:${valid ? value / max * 100 : 0}%"></i></span><b>${valid ? `${value} из ${max}` : 'нет суммы'}</b></li>`;
    }).join('');
    return `<div class="metric-scale"><div class="metric-head"><h3>${label}</h3><span>${safeScore(current,max) ? `Последний ответ: ${current} из ${max}` : 'Последний ответ: нет суммы'}</span></div>
      <p class="metric-caption">${desc} Если ответ пропущен, сумма не рассчитывается.</p>
      <ol class="metric-rows" aria-label="${label}: результаты по датам">${lines}</ol>
      <details class="metric-details"><summary>Зачем это нужно?</summary><p>Ответы помогают врачу увидеть изменения между визитами. Врач обсудит результат с вами.</p></details></div>`;
  };
  return `<section class="card patient-metrics" aria-labelledby="metrics-title"><h2 id="metrics-title">Ваши ответы во времени</h2>
    <p class="metric-intro">Врач обсудит результаты и ваши ответы с вами.</p>
    ${one('phq9','PHQ-9',27)}<p class="metric-caption">Врач увидит заполненные ответы о тревоге.</p>
    <p class="metric-foot">Вы отвечаете → врач видит сводку → вместе обсуждаете план</p></section>`;
}
