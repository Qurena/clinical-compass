// Сводка использует только сохранённые ответы, сообщения, записи и известные пробелы.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = (ts) => new Date(ts).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
export function doctorSummaryHTML(c) {
  if (!c) return '';
  const s = c.summary;
  const since = s?.since_ts || c.visits?.[0]?.ts || 0;
  const changed = s?.prev_ts && Array.isArray(s.items) ? s.items : [];
  const scores = s?.scores?.phq9;
  const scoreRow = scores ? `<p><b>PHQ-9</b> · ${esc(date(s.prev_ts))}: ${scores.from}/27 → ${esc(date(s.cur_ts))}: ${scores.to}/27</p>` : '';
  const gadRow = s?.gad7 ? `<p><b>GAD-7</b> · ${s.gad7.from} → ${s.gad7.to}</p>` : '';
  const adherence = s?.adherence_since?.pct != null ? `<p><b>Дневник приёма</b> · принято ${s.adherence_since.pct}% запланированных доз</p>` : '';
  const renderChanges = (items) => items.map((x) => `<li><b>${esc(x.dir || x.tag)}</b><div>${esc(date(s.prev_ts))}: ${esc(x.from)} → ${esc(date(s.cur_ts))}: ${esc(x.to)}</div></li>`).join('');
  const changedRows = renderChanges(changed.slice(0,3));
  const comparisons = s?.prev_ts
    ? changedRows ? `<p><b>Изменившиеся ответы: ${changed.length}</b></p><ul class="summary-list">${changedRows}</ul>${changed.length > 3 ? `<details><summary>Ещё ${changed.length-3}</summary><ul class="summary-list">${renderChanges(changed.slice(3))}</ul></details>` : ''}`
      : '<p>Изменений в сопоставимых ответах нет.</p>'
    : '<p>Для сравнения ответов пока недостаточно данных.</p>';
  const diary = (c.diary || []).filter((x) => x.ts > since).sort((a,b) => b.ts-a.ts)[0];
  const diaryFields = diary ? [
    diary.mood != null ? `настроение ${diary.mood}/10` : '',
    diary.anxiety != null ? `тревога ${diary.anxiety}/10` : '',
    diary.sleep_hours != null ? `сон ${diary.sleep_hours} ч` : '',
    diary.side_effects?.length ? `отмечено: ${diary.side_effects.join(', ')}` : '',
    diary.note ? `заметка: ${diary.note}` : ''
  ].filter(Boolean).join(' · ') : '';
  const messages = (c.messages || []).filter((m) => m.from_role === 'patient' && !m.system && m.ts > since).sort((a,b) => b.ts-a.ts).slice(0,2);
  const messageRows = messages.map((m) => `<li><time>${esc(date(m.ts))}</time> «${esc(m.text)}»</li>`).join('');
  const gaps = c.recommendation?.drug?.gaps || [];
  return `<section class="card doctor-summary" aria-labelledby="visit-summary-title">
    <div class="summary-heading"><div><h2 id="visit-summary-title">Перед приёмом</h2><p>${since ? `С последнего приёма ${esc(date(since))}` : 'История пациента'}</p></div><span class="summary-label">сводка</span></div>
    <div class="summary-grid"><div class="summary-panel"><h3>Что изменилось</h3>${scoreRow}${gadRow}${adherence}${comparisons}</div>
      <div class="summary-panel"><h3>Сообщил пациент</h3>${diary ? `<p><b>Дневник · ${esc(date(diary.ts))}</b><br>${esc(diaryFields || 'запись без показателей')}</p>` : '<p>Новых записей дневника нет.</p>'}
      ${messageRows ? `<ul class="summary-list">${messageRows}</ul>` : '<p>Новых сообщений нет.</p>'}</div>
      <div class="summary-panel"><h3>Что уточнить</h3>${gaps.length ? `<ul class="summary-list">${gaps.map((g)=>`<li>${esc(g)}</li>`).join('')}</ul>` : '<p>Нет отмеченных пробелов в лекарственных данных.</p>'}</div></div>
    <p class="summary-footer">Информация для обсуждения; решение принимает врач.</p>
  </section>`;
}
