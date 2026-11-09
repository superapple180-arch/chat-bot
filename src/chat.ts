import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Target } from './types.js';

export class ChatStore {
  readonly db: DatabaseSync;
  constructor(file = 'state/chat.sqlite', readOnly = false) {
    if (readOnly) { this.db = new DatabaseSync(file,{readOnly:true}); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, event TEXT NOT NULL, source TEXT NOT NULL,
        sender TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, at INTEGER NOT NULL,
        UNIQUE(account,event,source));
      CREATE INDEX IF NOT EXISTS chat_scope ON chat(account,kind,target,id);
      UPDATE chat SET status='uncertain' WHERE source!='user' AND status='sending';
      UPDATE chat SET status='cancelled' WHERE source!='user' AND status IN ('accepted','generating','generated');`);
    this.cleanup();
  }
  cleanup() {
    this.db.prepare('DELETE FROM chat WHERE at < ?').run(Date.now() - 90 * 86400000);
  }
  capture(account: string, t: Target) { this.put(account, t, 'user', t.text, 'received'); }
  put(account: string, t: Target, source: string, body: string, status: string) {
    this.db.prepare(`INSERT INTO chat(account,kind,target,event,source,sender,name,body,attachments,status,at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account,event,source) DO UPDATE SET body=excluded.body,status=excluded.status`)
      .run(account,t.kind,t.id,t.eventKey,source,t.userId ?? '',t.senderName ?? t.userId ?? '',body,
        JSON.stringify((t.attachments ?? []).map(({kind,name}) => ({kind,name}))),status,t.at ?? Date.now());
  }
  status(account: string, event: string, status: string) {
    this.db.prepare("UPDATE chat SET status=? WHERE account=? AND event=? AND source!='user'").run(status,account,event);
  }
  summary(account: string, event: string, summary: string) {
    this.db.prepare("UPDATE chat SET summary=? WHERE account=? AND event=? AND source='user'").run(summary,account,event);
  }
  hasConversation(account: string, kind: string, target: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM chat WHERE account=? AND kind=? AND target=? AND source!='owner-result' LIMIT 1").get(account,kind,target));
  }
  conversations(account: string) {
    return this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM chat n WHERE n.account=c.account AND n.kind=c.kind AND n.target=c.target AND n.source!='owner-result') AS count
      FROM chat c WHERE c.account=? AND c.source!='owner-result' AND c.id=(SELECT MAX(n.id) FROM chat n WHERE n.account=c.account AND n.kind=c.kind AND n.target=c.target AND n.source!='owner-result')
      ORDER BY c.id DESC LIMIT 500`).all(account);
  }
  messages(account: string, kind: string, target: string, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT * FROM chat WHERE account=? AND kind=? AND target=? AND id<? ORDER BY id DESC LIMIT 100')
      .all(account,kind,target,before).reverse();
  }
  close() { this.db.close(); }
}
