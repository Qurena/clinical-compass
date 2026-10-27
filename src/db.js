import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCALES, scoreSppvr, deriveClinical } from './engine.js';

const DAY = 86400000;

export function hashPassword(pw, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(pw, salt, 32).toString('hex') };
}
export function verifyPassword(pw, salt, hash) {
  const a = Buffer.from(scryptSync(pw, salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function openDb(path = process.env.DB_PATH || 'data/compass.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('doctor','patient')),
      login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, specialty TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS patients (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), doctor_id INTEGER NOT NULL REFERENCES users(id),
      profile TEXT NOT NULL, meds TEXT NOT NULL DEFAULT '[]', source TEXT
    );
    CREATE TABLE IF NOT EXISTS sppvr_results (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), answers TEXT NOT NULL,
      anx INTEGER NOT NULL, anx_eq INTEGER NOT NULL, dep INTEGER NOT NULL, dep_eq INTEGER NOT NULL, veg INTEGER NOT NULL,
      duration INTEGER NOT NULL, elapsed_sec REAL, flags TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sppvr ON sppvr_results(patient_id, ts);
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), doctor_id INTEGER NOT NULL REFERENCES users(id),
      ts INTEGER NOT NULL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS protocols (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), doctor_id INTEGER NOT NULL REFERENCES users(id),
      ts INTEGER NOT NULL, criteria TEXT NOT NULL, consent TEXT NOT NULL, route TEXT NOT NULL, comment TEXT
    );
    CREATE TABLE IF NOT EXISTS scale_results (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), scale TEXT NOT NULL,
      answers TEXT NOT NULL, total INTEGER NOT NULL, band TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_scale ON scale_results(patient_id, scale, ts);
    CREATE TABLE IF NOT EXISTS diary (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id),
      ts INTEGER NOT NULL, mood INTEGER, anxiety INTEGER, sleep_hours REAL,
      doses_taken INTEGER NOT NULL DEFAULT 0, doses_planned INTEGER NOT NULL DEFAULT 0,
      side_effects TEXT NOT NULL DEFAULT '[]', note TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_diary ON diary(patient_id, ts);
    CREATE TABLE IF NOT EXISTS prescriptions (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), drug TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','stopped')), started_ts INTEGER NOT NULL,
      confirmed_by INTEGER REFERENCES users(id), override_reason TEXT, stopped_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id),
      level TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('suggested','confirmed','dismissed')),
      reasons TEXT NOT NULL, comment TEXT, decided_by INTEGER REFERENCES users(id), created_ts INTEGER NOT NULL, decided_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id), rule_id TEXT NOT NULL,
      severity TEXT NOT NULL, title TEXT NOT NULL, details TEXT, actions TEXT NOT NULL,
      created_ts INTEGER NOT NULL, delivered_ts INTEGER, read_ts INTEGER, ack_ts INTEGER, ack_by INTEGER REFERENCES users(id),
      ack_note TEXT, escalated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(user_id),
      from_role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, system INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, entity TEXT, detail TEXT,
      prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT ''
    );
  `);
  // миграции (старые файлы БД): новые колонки добавляются, если их нет
  const addCol = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('sppvr_results', 'extra', 'TEXT');           // JSON: время по пунктам, клинический блок C1–C12
  addCol('alerts', 'action_ts', 'INTEGER');           // действие врача (action_taken) отдельно от «принято»
  addCol('alerts', 'action_note', 'TEXT');
  return db;
}

/** Сохраняет результат СППВР 2.0 (20 ответов). Колонки anx/dep хранят HADS-A и PHQ-9; пустое значение — 0 (суммы при пропуске пересчитываются из ответов). */
export function insertSppvr(db, pid, answers, timing, clinical, ts = Date.now()) {
  const r = scoreSppvr(answers, timing);
  const d = clinical ? deriveClinical(clinical) : null;
  const flags = { ...r.flags, bar: !!(d && d.bar), safety_immediate: !!(d && d.safety_immediate), unknown_data: !!(d && d.unknown_data) };
  db.prepare('INSERT INTO sppvr_results(patient_id,answers,anx,anx_eq,dep,dep_eq,veg,duration,elapsed_sec,flags,ts,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(pid, JSON.stringify(answers), r.hads_a ?? 0, r.hads_a ?? 0, r.phq9 ?? 0, r.phq9 ?? 0, 0, 0, r.elapsed_sec, JSON.stringify(flags), ts,
      JSON.stringify({ item_sec: r.item_sec, clinical: clinical || null }));
  return r;
}

// Журнал с цепочкой хэшей: изменение или удаление любой записи нарушает проверку verifyAudit.
const chainHash = (prev, ts, uid, action, entity, detail) =>
  createHash('sha256').update([prev, ts, uid ?? '', action, entity ?? '', detail ?? ''].join('|')).digest('hex');

export function audit(db, userId, action, entity, detail) {
  const prev = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
  const ts = Date.now();
  const d = detail ? String(detail) : null;
  const ph = prev ? prev.hash : '';
  db.prepare('INSERT INTO audit(ts,user_id,action,entity,detail,prev_hash,hash) VALUES (?,?,?,?,?,?,?)')
    .run(ts, userId, action, entity || null, d, ph, chainHash(ph, ts, userId, action, entity || null, d));
}

export function verifyAudit(db) {
  let prev = '';
  let n = 0;
  for (const r of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
    if (r.prev_hash !== prev || r.hash !== chainHash(prev, r.ts, r.user_id, r.action, r.entity, r.detail)) return { ok: false, broken_at: r.id, n };
    prev = r.hash; n++;
  }
  return { ok: true, n };
}

// Раскладывает сумму по пунктам шкалы (для демонстрационных данных).
function spread(total, n, max = 3) {
  const a = Array(n).fill(0);
  let i = 0;
  while (total > 0) {
    if (a[i % n] < max) { a[i % n]++; total--; }
    i++;
  }
  return a;
}


export function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const now = Date.now();
  const mkUser = (role, login, name, specialty, pw = 'demo') => {
    const { salt, hash } = hashPassword(pw);
    return Number(db.prepare('INSERT INTO users(role,login,name,specialty,salt,hash) VALUES (?,?,?,?,?,?)').run(role, login, name, specialty, salt, hash).lastInsertRowid);
  };
  const doctor = mkUser('doctor', 'doctor', 'Лебедева Ирина Сергеевна', 'врач-психиатр');
  const mkPatient = (login, name, source, profile, meds) => {
    const id = mkUser('patient', login, name, null);
    db.prepare('INSERT INTO patients(user_id,doctor_id,profile,meds,source) VALUES (?,?,?,?,?)').run(id, doctor, JSON.stringify(profile), JSON.stringify(meds), source);
    return id;
  };
  const base = { conditions: [], pregnant: false, lactating: false, egfr: 98, hepatic_class: null, alcohol: false, exam: {}, treatment: {} };
  const scale = (pid, sc, answers, daysAgo) => {
    const t = answers.reduce((s, x) => s + x, 0);
    const band = SCALES[sc].bands.find((b) => t <= b.max).label;
    db.prepare('INSERT INTO scale_results(patient_id,scale,answers,total,band,ts) VALUES (?,?,?,?,?,?)').run(pid, sc, JSON.stringify(answers), t, band, now - daysAgo * DAY);
  };
  // 20 ответов СППВР из «закодированных» значений: PHQ-9 ×9, HADS-A по ключу ×7 (пункт 7 хранится сырым), проверка внимания, 3 контрольных
  const mk = (phq, hads, anchors = null) => [...phq, ...hads.map((v, i) => (i === 3 ? 3 - v : v)), 1, ...(anchors || [phq[2], phq[6], hads[0]])];
  const sppvr = (pid, answers, daysAgo, sec, clinical = null) => insertSppvr(db, pid, answers,
    { elapsed_sec: sec, item_sec: Array.from({ length: answers.length }, (_, i) => Math.round((sec / answers.length) * (0.8 + ((i * 7) % 5) / 12) * 10) / 10) }, clinical, now - daysAgo * DAY);
  const diaryRow = (pid, daysAgo, o) =>
    db.prepare('INSERT INTO diary(patient_id,ts,mood,anxiety,sleep_hours,doses_taken,doses_planned,side_effects,note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(pid, now - daysAgo * DAY, o.mood, o.anxiety, o.sleep, o.taken || 0, o.planned || 0, JSON.stringify(o.se || []), o.note || null);

  // Клинический случай 1 (Арина): женщина 32 лет, острая стрессовая реакция. Анкета заполняется в демо.
  const anna = mkPatient('anna', 'Соколова Анна', 'Синтетический сценарий, повторный приём', {
    ...base, age: 32, sex: 'Ж', dx: null,
    complaint: 'Постоянное внутреннее напряжение, мышечный спазм в шейно-воротниковой зоне, учащённое сердцебиение, нарушения сна после сильного стресса на работе 2 месяца назад. ТТГ и ЭКГ в норме.'
  }, []);
  // Искусственная история для демонстрации динамики; не копия другого пациента.
  db.prepare('INSERT INTO visits(patient_id,doctor_id,ts,note) VALUES (?,?,?,?)').run(anna, doctor, now - 28 * DAY, 'Синтетический предыдущий приём');
  sppvr(anna, mk([1,1,1,1,1,1,1,1,0], [2,2,2,2,2,2,1]), 28, 205);
  sppvr(anna, mk([1,1,1,0,1,1,1,0,0], [2,2,2,2,2,2,1]), 15, 210);
  diaryRow(anna, 7, { mood: 4, anxiety: 6, sleep: 5, se: [] });
  db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,0)')
    .run(anna, 'patient', 'В последние дни хуже сплю. Хочу обсудить это на приёме.', now - 5 * DAY);

  // Клинический случай 2 (КЛК): мужчина 45 лет, тревожные симптомы, принимает «таблетку для сна» и «что-то от давления», названий не знает. Анкета заполняется в демо.
  mkPatient('igor', 'Волков Игорь', 'Направлен неврологом', {
    ...base, age: 45, sex: 'М', dx: null,
    complaint: 'Тревога, внутреннее дрожание, напряжение, плохой сон около 7 месяцев. Принимает «таблетку для сна» и «что-то от давления», названий и упаковок не знает.'
  }, []);

  // Клинический случай 3: женщина 26 лет, тяжёлая депрессия, суицидальный риск.
  mkPatient('daria', 'Орлова Дарья', 'Доставлена родственниками на приём', {
    ...base, age: 26, sex: 'Ж', dx: null,
    complaint: 'Тотальная тоска, чувство собственной никчёмности, нет сил встать с постели, отказ от еды.'
  }, []);

  // Клинический случай 3 (КЛК): депрессивные симптомы и соматические/вегетативные жалобы. Авиандр автоматически не рекомендуется.
  const pavel = mkPatient('pavel', 'Беляев Павел', 'Направлен терапевтом', {
    ...base, age: 38, sex: 'М', dx: null,
    complaint: 'Сердцебиение, дрожь, непереносимость жары, потеря веса за 2 месяца, сниженное настроение, нарушение сна.'
  }, []);
  sppvr(pavel, mk([2, 2, 2, 2, 2, 2, 2, 3, 0], [2, 2, 1, 1, 1, 1, 1]), 1, 215, {
    duration: '1_6m', functioning: 2, meds_status: 'none', meds: [], adverse: 'no', mania: 'no', somatic_hx: ['none'],
    alcohol: 'rare', substances: 'no', nicotine: 'no', organ: ['palpitations', 'tremor', 'heat', 'weight']
  });

  // Основной сценарий (Андрей): повторный приём взрослой пациентки с установленным ГТР.
  const maria = mkPatient('maria', 'Кузнецова Мария', 'Наблюдается, повторный приём', {
    ...base, age: 41, sex: 'Ж', dx: { code: 'F41.1', name: 'Генерализованное тревожное расстройство' }, egfr: 90, exam: { meds_reconciled: true },
    complaint: 'ГТР, терапия Авиандром 4 недели. Жалобы на сонливость днём, сон по-прежнему нарушен.'
  }, []);
  db.prepare('INSERT INTO prescriptions(patient_id,drug,status,started_ts,confirmed_by) VALUES (?,?,?,?,?)').run(maria, 'aviandr', 'active', now - 28 * DAY, doctor);
  db.prepare('INSERT INTO visits(patient_id,doctor_id,ts,note) VALUES (?,?,?,?)').run(maria, doctor, now - 28 * DAY, 'Назначен Авиандр, повторный приём через 4 недели');
  sppvr(maria, mk([1, 1, 1, 1, 1, 1, 1, 1, 0], [3, 3, 2, 2, 2, 2, 1]), 28.1, 196);
  sppvr(maria, mk([1, 1, 1, 1, 1, 1, 1, 1, 0], [2, 3, 2, 2, 2, 2, 1]), 14, 210);
  sppvr(maria, mk([1, 1, 1, 2, 1, 1, 1, 1, 0], [3, 3, 2, 2, 2, 2, 2]), 3, 205);
  scale(maria, 'gad7', [3, 2, 2, 2, 2, 2, 2], 28); scale(maria, 'gad7', [3, 2, 2, 2, 2, 2, 2], 21);
  scale(maria, 'gad7', [2, 2, 2, 2, 2, 2, 2], 14); scale(maria, 'gad7', [3, 2, 2, 3, 2, 2, 2], 7);
  scale(maria, 'phq9', [2, 2, 2, 2, 1, 2, 1, 1, 0], 28); scale(maria, 'phq9', [2, 2, 2, 2, 2, 2, 1, 1, 0], 7);
  const taken = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0];
  for (let i = 0; i < taken.length; i++) {
    const d = taken.length - i;
    diaryRow(maria, d, { mood: 3, anxiety: 8, sleep: 4.5, taken: taken[i], planned: 2, se: i % 4 === 0 ? ['сонливость'] : [] });
  }
  const m = db.prepare('INSERT INTO messages(patient_id,from_role,text,ts,system) VALUES (?,?,?,?,0)');
  m.run(maria, 'patient', 'Доктор, сонливость днём, поэтому иногда пропускаю утренний приём.', now - 6 * DAY);
  m.run(maria, 'doctor', 'Мария, не пропускайте приём без согласования. Напишите, как будет самочувствие, обсудим на приёме.', now - 6 * DAY + 3600000);
  audit(db, null, 'seed', 'system', 'демо-данные (синтетические)');
}
