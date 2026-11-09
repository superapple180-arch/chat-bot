import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContactRequest, Cursor, QzonePost, Session } from './types.js';
export type RecordState = { status: string; at: string; reason?: string };
type Data = { version: 2; cursor?: Cursor; sessions: Record<string, Session>; antigravitySessions?: Record<string, { id: string; model: string }>; pendingSessions?: string[]; requests?: Record<string, ContactRequest>; qzonePosts?: Record<string, QzonePost>; mediaHistory?: Record<string, { at: number; turns: number }>; pauseReason: string };
export class State {
  data: Data;
  private db: DatabaseSync;
  constructor(private file: string) {
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    if (previous && (![1, 2].includes(previous.version) || !previous.sessions || previous.version === 1 && !previous.events)) throw new Error('INVALID_STATE');
    if (previous?.version === 2 && !fs.existsSync(file + '.events.sqlite')) throw new Error('STATE_EVENTS_MISSING');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file + '.events.sqlite');
    try {
      if (previous?.version === 2 && !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) throw new Error('STATE_EVENTS_MISSING');
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, status TEXT NOT NULL, at TEXT NOT NULL, reason TEXT);
        CREATE TABLE IF NOT EXISTS send_times (scope TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS send_scope ON send_times(scope,at);`);
      const requestSchema = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (requestSchema >= 1 && !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_requests'").get()) throw new Error('STATE_REQUESTS_MISSING');
      this.db.exec(`CREATE TABLE IF NOT EXISTS contact_requests (id TEXT PRIMARY KEY, account TEXT NOT NULL, user_id TEXT NOT NULL,
        status TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS request_account ON contact_requests(account,status,user_id);
        CREATE INDEX IF NOT EXISTS request_time ON contact_requests(at);`);
      this.data = previous ?? { version: 2, sessions: {}, pauseReason: 'STARTUP_PAUSED' };
      if (previous?.version === 1) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const insert = this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)');
          for (const [key, record] of Object.entries(previous.events) as [string, RecordState][]) insert.run(key, record.status, record.at, record.reason ?? null);
          this.db.exec('COMMIT');
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        this.data = { version: 2, cursor: previous.cursor, sessions: {}, antigravitySessions: {}, pauseReason: 'SECURITY_UPGRADE_NEW_SESSIONS' };
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [id, request] of Object.entries(this.data.requests ?? {})) {
          if (!this.event('contact:' + id)) {
            this.db.prepare('INSERT OR IGNORE INTO contact_requests VALUES(?,?,?,?,?,?)').run(id, request.selfId, request.userId, request.status, request.at, JSON.stringify(request));
            this.record('contact:' + id, 'request-recorded');
          }
        }
        this.db.exec("UPDATE contact_requests SET status='uncertain' WHERE status='processing'; PRAGMA user_version=1; COMMIT;");
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      delete this.data.requests;
      this.cleanupRequests();
      for (const key of this.data.pendingSessions ?? []) {
        delete this.data.sessions[key]; delete this.data.antigravitySessions?.[key];
      }
      delete this.data.pendingSessions;
      const interrupted = this.db.prepare("UPDATE events SET status='interrupted',reason='RESTART_NO_RETRY' WHERE status IN ('accepted','generating','sending')").run().changes;
      if (interrupted) this.data.pauseReason = 'RESTART_UNFINISHED_TASK';
      this.save();
    } catch (e) { this.db.close(); throw e; }
  }
  close() { if (this.db.isOpen) this.db.close(); }
  save() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  event(key: string): RecordState | undefined {
    const row = this.db.prepare('SELECT status,at,reason FROM events WHERE key=?').get(key) as (RecordState & { reason: string | null }) | undefined;
    return row ? { status: row.status, at: row.at, ...(row.reason ? { reason: row.reason } : {}) } : undefined;
  }
  events(): Record<string, RecordState> {
    const rows = this.db.prepare('SELECT * FROM events').all() as (RecordState & { key: string })[];
    return Object.fromEntries(rows.map(row => [row.key, { status: row.status, at: row.at, ...(row.reason ? { reason: row.reason } : {}) }]));
  }
  record(key: string, status: string, reason?: string) {
    this.db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?)').run(key, status, new Date().toISOString(), reason ?? null);
  }
  request(id: string): ContactRequest | undefined {
    const row = this.db.prepare('SELECT data,status FROM contact_requests WHERE id=?').get(id) as { data: string; status: ContactRequest['status'] } | undefined;
    return row ? { ...JSON.parse(row.data), status: row.status } : undefined;
  }
  requests(account: string, activeOnly = false): Record<string, ContactRequest> {
    const rows = this.db.prepare(`SELECT id,data,status FROM contact_requests WHERE account=?
      AND (?=0 OR status IN ('pending','processing','uncertain','failed'))
      ORDER BY status IN ('pending','processing','uncertain') DESC,at DESC,id DESC LIMIT 1000`).all(account, Number(activeOnly)) as { id: string; data: string; status: string }[];
    return Object.fromEntries(rows.map(row => [row.id, { ...JSON.parse(row.data), status: row.status }]));
  }
  pendingRequests(account: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM contact_requests WHERE account=? AND status='pending'").get(account)!.n);
  }
  cleanupRequests(now = Date.now()) {
    this.db.prepare("DELETE FROM contact_requests WHERE status IN ('approved','rejected','failed') AND at<?").run(new Date(now - 90 * 86400000).toISOString());
  }
  addRequest(id: string, request: ContactRequest): 'accepted' | 'duplicate' | 'limited' {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let result: 'accepted' | 'duplicate' | 'limited' = 'duplicate';
      if (!this.event('contact:' + id)) {
        this.cleanupRequests();
        const counts = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(user_id=?),0) AS person FROM contact_requests
          WHERE account=? AND status IN ('pending','processing','uncertain')`).get(request.userId, request.selfId)!;
        result = Number(counts.total) >= 500 || Number(counts.person) >= 5 ? 'limited' : 'accepted';
        if (result === 'accepted') this.db.prepare('INSERT INTO contact_requests VALUES(?,?,?,?,?,?)').run(id, request.selfId, request.userId, request.status, request.at, JSON.stringify(request));
        this.record('contact:' + id, result === 'accepted' ? 'request-recorded' : 'request-limited');
      }
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  requestStatus(id: string, status: ContactRequest['status'], expected?: ContactRequest['status']): boolean {
    return this.db.prepare("UPDATE contact_requests SET status=?,at=CASE WHEN ? IN ('approved','rejected','failed') THEN ? ELSE at END WHERE id=? AND (? IS NULL OR status=?)")
      .run(status, status, new Date().toISOString(), id, expected ?? null, expected ?? null).changes === 1;
  }
  canSend(scope: string, now = Date.now()) {
    const rows = this.db.prepare('SELECT at FROM send_times WHERE scope=? AND at>?').all(scope, now - 20000) as { at: number }[];
    return rows.length < 4 && rows.filter(r => r.at > now - 6000).length < 2;
  }
  reserveSend(scope: string, now = Date.now()) {
    this.db.prepare('DELETE FROM send_times WHERE at<=?').run(now - 20000);
    this.db.prepare('INSERT INTO send_times VALUES(?,?)').run(scope, now);
  }
  startReply(key: string) {
    if (this.data.pendingSessions?.includes(key)) this.discardReply(key);
    (this.data.pendingSessions ??= []).push(key); this.save();
  }
  confirmReply(key: string) {
    this.data.pendingSessions = this.data.pendingSessions?.filter(k => k !== key); this.save();
  }
  discardReply(key: string) {
    delete this.data.sessions[key]; delete this.data.antigravitySessions?.[key];
    this.confirmReply(key);
  }
}
