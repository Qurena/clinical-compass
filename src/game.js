// Геймификация пациента: искры за опросник, шкалы и дневник, уровни Облачка, серия дней дневника.
// Считается из уже сохранённых данных, отдельного хранилища нет. Потери очков и «сгоревшей» серии нет.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const GAME = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'game.json'), 'utf8'));
const DAY = 86400000;
const dayKey = (ts) => Math.floor(ts / DAY);

/** counts: { sppvr, scale }, diaryTs: время записей дневника (мс), now: текущее время. */
export function gameOf(counts, diaryTs, now = Date.now()) {
  const P = GAME.points;
  const points = counts.sppvr * P.sppvr + counts.scale * P.scale + diaryTs.length * P.diary;
  let lv = 0; GAME.levels.forEach((l, i) => { if (points >= l.min) lv = i; });
  const cur = GAME.levels[lv], nxt = GAME.levels[lv + 1] || null;
  const pct = nxt ? Math.round(((points - cur.min) / (nxt.min - cur.min)) * 100) : 100;
  const days = new Set(diaryTs.map(dayKey));
  let d = dayKey(now); if (!days.has(d)) d -= 1; // серия не «горит» до конца сегодняшнего дня
  let streak = 0; while (days.has(d)) { streak++; d--; }
  return { points, level: { n: lv + 1, name: cur.name, min: cur.min, next_min: nxt ? nxt.min : null, next_name: nxt ? nxt.name : null, pct },
    streak, diary_today: days.has(dayKey(now)), rewards: P };
}
