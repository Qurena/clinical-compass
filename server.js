import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, seed, verifyPassword, verifyAudit, audit } from './src/db.js';
import { makeService } from './src/service.js';
import { SCALES, SPPVR } from './src/engine.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

export function createApp(dbPath) {
  const db = openDb(dbPath);
  seed(db);
  const svc = makeService(db);
  svc.bootstrapAlerts();

  const sessions = new Map(); // sid -> { id, role }
  const attempts = new Map(); // ip -> [ts]

  const send = (res, code, body, headers = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100000) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad_json')); } });
  });
  const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((a) => a[0]));
  const authOf = (req) => sessions.get(cookie(req).sid) || null;

  // Доступ врача только к своим пациентам
  const ownPatient = (user, pid) => {
    const p = svc.patientRow(pid);
    return p && p.doctor_id === user.id ? p : null;
  };

  async function api(req, res, url) {
    const m = req.method;
    const path = url.pathname;

    if (m === 'POST' && path === '/api/login') {
      const ip = req.socket.remoteAddress || '';
      const list = (attempts.get(ip) || []).filter((t) => Date.now() - t < 60000);
      if (list.length >= (Number(process.env.LOGIN_LIMIT) || 20)) return send(res, 429, { error: 'too_many_attempts' });
      list.push(Date.now()); attempts.set(ip, list);
      const b = await readBody(req);
      const u = db.prepare('SELECT * FROM users WHERE login=?').get(String(b.login || ''));
      if (!u || !verifyPassword(String(b.password || ''), u.salt, u.hash)) return send(res, 401, { error: 'bad_credentials' });
      const sid = randomBytes(24).toString('hex');
      sessions.set(sid, { id: u.id, role: u.role });
      audit(db, u.id, 'login', null, null);
      return send(res, 200, { role: u.role, name: u.name }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (m === 'POST' && path === '/api/logout') {
      sessions.delete(cookie(req).sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
    }

    const user = authOf(req);
    if (!user) return send(res, 401, { error: 'auth_required' });

    if (m === 'GET' && path === '/api/me') {
      const u = db.prepare('SELECT id, role, name, specialty FROM users WHERE id=?').get(user.id);
      return send(res, 200, u);
    }
    if (m === 'GET' && path === '/api/scales') {
      return send(res, 200, { ...SCALES, sppvr: { id: SPPVR.id, name: SPPVR.name, version: SPPVR.version, title: SPPVR.title, period: SPPVR.period, intro: SPPVR.intro, options: SPPVR.options, blocks: SPPVR.blocks, questions: SPPVR.questions.map(({ pair, ...q }) => q), clinical: SPPVR.clinical, hads_form_status: SPPVR.hads_a.form_status } });
    }

    // ----- врач -----
    if (path.startsWith('/api/doctor/')) {
      if (user.role !== 'doctor') return send(res, 403, { error: 'forbidden' });

      if (m === 'GET' && path === '/api/doctor/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const ch = `doctor:${user.id}`;
        const on = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        svc.bus.on(ch, on);
        // недоставленные алерты уходят сразу при подключении
        for (const a of db.prepare('SELECT a.* FROM alerts a JOIN patients p ON p.user_id=a.patient_id WHERE p.doctor_id=? AND a.delivered_ts IS NULL AND a.ack_ts IS NULL').all(user.id)) {
          db.prepare('UPDATE alerts SET delivered_ts=? WHERE id=?').run(Date.now(), a.id);
          on({ type: 'alert', alert: { id: a.id, patient_id: a.patient_id, severity: a.severity, title: a.title, details: a.details, created_ts: a.created_ts } });
        }
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { svc.bus.off(ch, on); clearInterval(ping); });
        return;
      }
      if (m === 'GET' && path === '/api/doctor/patients') return send(res, 200, svc.listForDoctor(user.id));
      if (m === 'GET' && path === '/api/doctor/metrics') return send(res, 200, svc.metrics());
      if (m === 'GET' && path === '/api/doctor/audit/verify') return send(res, 200, verifyAudit(db));

      let mt = path.match(/^\/api\/doctor\/patients\/(\d+)$/);
      if (m === 'GET' && mt) {
        if (!ownPatient(user, Number(mt[1]))) return send(res, 404, { error: 'not_found' });
        audit(db, user.id, 'card_view', `patient:${mt[1]}`, null);
        svc.markRead(Number(mt[1]), user.id);
        return send(res, 200, svc.buildCard(Number(mt[1])));
      }
      mt = path.match(/^\/api\/doctor\/patients\/(\d+)\/(prescribe|referral|messages|protocol|exam|meds|visit|advice)$/);
      if (m === 'POST' && mt) {
        const pid = Number(mt[1]);
        if (!ownPatient(user, pid)) return send(res, 404, { error: 'not_found' });
        const b = await readBody(req);
        if (mt[2] === 'prescribe') {
          const r = svc.confirmPrescription(pid, user.id, b);
          return send(res, r.error ? 409 : 200, r);
        }
        if (mt[2] === 'referral') {
          if (!['confirm', 'dismiss'].includes(b.action)) return send(res, 400, { error: 'bad_action' });
          const r = svc.decideReferral(pid, user.id, b);
          return send(res, r.error ? 409 : 200, r);
        }
        if (mt[2] === 'protocol') { const r = svc.recordProtocol(pid, user.id, b); return send(res, r.error ? 409 : 200, r); }
        if (mt[2] === 'advice') { const r = svc.recordAdvice(pid, user.id, b); return send(res, r.error ? 400 : 200, r); }
        if (mt[2] === 'exam') return send(res, 200, svc.saveExam(pid, user.id, b));
        if (mt[2] === 'visit') return send(res, 200, svc.closeVisit(pid, user.id, b.note));
        if (mt[2] === 'meds') {
          if (b.remove !== undefined) return send(res, 200, { ok: svc.removeMed(pid, user.id, Number(b.remove)) });
          const r = svc.addMed(pid, user.id, b.name);
          return send(res, r.error ? 400 : 200, r);
        }
        if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'empty' });
        svc.postMessage(pid, 'doctor', b.text);
        return send(res, 200, { ok: true });
      }
      mt = path.match(/^\/api\/doctor\/patients\/(\d+)\/prescriptions\/(\d+)\/stop$/);
      if (m === 'POST' && mt) {
        if (!ownPatient(user, Number(mt[1]))) return send(res, 404, { error: 'not_found' });
        return send(res, 200, { ok: svc.stopPrescription(Number(mt[1]), Number(mt[2]), user.id) });
      }
      mt = path.match(/^\/api\/doctor\/alerts\/(\d+)\/ack$/);
      if (m === 'POST' && mt) {
        const b = await readBody(req);
        const a = svc.ackAlert(Number(mt[1]), user.id, b.note);
        return a ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not_found' });
      }
      return send(res, 404, { error: 'not_found' });
    }

    // ----- пациент -----
    if (path.startsWith('/api/patient/')) {
      if (user.role !== 'patient') return send(res, 403, { error: 'forbidden' });
      if (m === 'GET' && path === '/api/patient/home') return send(res, 200, svc.patientHome(user.id));
      let mt = path.match(/^\/api\/patient\/scales\/(phq9|gad7)$/);
      if (m === 'POST' && mt) {
        const b = await readBody(req);
        try {
          const r = svc.submitScale(user.id, mt[1], b.answers);
          return send(res, 200, r);
        } catch { return send(res, 400, { error: 'bad_answers' }); }
      }
      if (m === 'POST' && path === '/api/patient/sppvr/start') return send(res, 200, svc.sppvrStart(user.id));
      if (m === 'POST' && path === '/api/patient/sppvr/early-safety') {
        const b = await readBody(req);
        try { return send(res, 200, svc.submitEarlySafety(user.id, b)); } catch { return send(res, 400, { error: 'bad_answers' }); }
      }
      if (m === 'POST' && path === '/api/patient/sppvr') {
        const b = await readBody(req);
        try { return send(res, 200, svc.submitSppvr(user.id, b.answers, b.elapsed_sec ?? null, b.item_sec ?? null, b.submission_token ?? null)); } catch { return send(res, 400, { error: 'bad_answers' }); }
      }
      if (m === 'POST' && path === '/api/patient/sppvr/clinical') {
        const r = svc.submitClinical(user.id, await readBody(req));
        return send(res, r.error ? 400 : 200, r);
      }
      if (m === 'POST' && path === '/api/patient/diary') return send(res, 200, svc.submitDiary(user.id, await readBody(req)));
      if (m === 'POST' && path === '/api/patient/sos') return send(res, 200, svc.sos(user.id));
      if (m === 'POST' && path === '/api/patient/messages') {
        const b = await readBody(req);
        if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'empty' });
        svc.postMessage(user.id, 'patient', b.text);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not_found' });
    }
    return send(res, 404, { error: 'not_found' });
  }

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(__dir, 'public', rel);
      if (!file.startsWith(join(__dir, 'public') + sep)) return send(res, 403, 'forbidden');
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'EINVAL') return send(res, 404, 'not found');
      if (e.message === 'too_large') return send(res, 413, { error: 'too_large' });
      if (e.message === 'bad_json') return send(res, 400, { error: 'bad_json' });
      console.error(e);
      send(res, 500, { error: 'internal' });
    }
  });
  const timer = setInterval(() => svc.checkEscalation(), 5000);
  server.on('close', () => clearInterval(timer));
  return { server, db, svc };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Клинический компас: http://localhost:${PORT}`);
    for (const list of Object.values(networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`С другого устройства в той же сети: http://${n.address}:${PORT}`);
  });
}
