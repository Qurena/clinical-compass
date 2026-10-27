// Резервная копия SQLite: целостная копия без остановки сервиса (VACUUM INTO).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const src = process.env.DB_PATH || 'data/compass.db';
const dir = process.env.BACKUP_DIR || 'data/backups';
const keep = Number(process.env.BACKUP_KEEP) || 14;
mkdirSync(dir, { recursive: true });
const name = `compass-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
const t0 = Date.now();
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
db.close();
const old = readdirSync(dir).filter((f) => f.startsWith('compass-')).sort().reverse().slice(keep);
for (const f of old) rmSync(join(dir, f));
console.log(`Копия: ${join(dir, name)} за ${Date.now() - t0} мс, хранится копий: ${keep}`);
