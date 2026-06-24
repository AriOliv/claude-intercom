import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { commsDir } from "./util.js";

export type MessageKind = "message" | "question" | "reply";

export interface Message {
  id: string;
  from: string; // sender session id
  from_title: string;
  to: string; // recipient session id
  kind: MessageKind;
  text: string;
  in_reply_to?: string;
  created_at: string;
  read_at?: string;
}

function inboxDir(sessionId: string): string {
  const dir = join(commsDir(), "inbox", sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function send(msg: Omit<Message, "id" | "created_at">): Message {
  const full: Message = { ...msg, id: randomUUID(), created_at: new Date().toISOString() };
  const dir = inboxDir(full.to);
  writeFileSync(join(dir, `${full.id}.json`), JSON.stringify(full, null, 2));
  return full;
}

export function inbox(sessionId: string, unreadOnly = false): Message[] {
  const dir = inboxDir(sessionId);
  const out: Message[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m: Message = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (unreadOnly && m.read_at) continue;
      out.push(m);
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return out;
}

export function getMessage(sessionId: string, id: string): Message | null {
  const path = join(inboxDir(sessionId), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function markRead(sessionId: string, id: string): void {
  const m = getMessage(sessionId, id);
  if (!m || m.read_at) return;
  m.read_at = new Date().toISOString();
  writeFileSync(join(inboxDir(sessionId), `${id}.json`), JSON.stringify(m, null, 2));
}
