import { readdirSync, statSync, existsSync, createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { run, projectsDir, extractUuid } from "./util.js";

export interface SessionInfo {
  session_id: string;
  title: string;
  project: string; // human-ish project name (last cwd segment)
  cwd: string;
  last_active: string; // ISO
  last_active_ms: number;
  live: boolean;
  tmux?: string;
  transcript: string;
}

/** All transcript files under the config's projects/ dir. */
function transcriptFiles(): string[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const proj of readdirSync(root)) {
    const pdir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) out.push(join(pdir, f));
    }
  }
  return out;
}

/** Read the first human prompt (title) and cwd from a transcript without loading it all. */
function peekTranscript(path: string): { title: string; cwd: string } {
  let title = "";
  let cwd = "";
  let lines = 0;
  try {
    const content = readFileSync(path, "utf8");
    for (const raw of content.split("\n")) {
      if (++lines > 200 && title && cwd) break;
      if (!raw.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!cwd && typeof rec.cwd === "string") cwd = rec.cwd;
      if (!title && rec.type === "user" && rec.message) {
        const text = extractUserText(rec.message);
        if (text) title = text;
      }
      if (title && cwd) break;
    }
  } catch {
    /* ignore */
  }
  return { title: title.replace(/\s+/g, " ").trim().slice(0, 120), cwd };
}

/** Pull plain text out of a user message, skipping tool_result / command noise. */
function extractUserText(message: any): string {
  const content = message.content;
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("<") || t.startsWith("Caveat:")) return "";
    return t;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t && !t.startsWith("<")) return t;
      }
    }
  }
  return "";
}

/** Map of live session_id -> tmux session name, derived from running processes. */
export function liveMap(): Map<string, string> {
  const map = new Map<string, string>();
  const panes = run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  if (!panes) return map;

  // Snapshot the whole process table once: pid -> {ppid, command}
  const psOut = run("ps", ["-axo", "pid=,ppid=,command="]);
  if (!psOut) return map;
  const byPid = new Map<number, { ppid: number; cmd: string }>();
  const children = new Map<number, number[]>();
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    byPid.set(pid, { ppid, cmd: m[3] });
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }

  for (const line of panes.split("\n")) {
    const [tmuxName, panePidStr] = line.split("\t");
    const panePid = Number(panePidStr);
    if (!tmuxName || !panePid) continue;
    // DFS the descendants of the pane's root process looking for a claude CLI.
    const stack = [panePid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const node = byPid.get(pid);
      if (node) {
        if (/(^|\/|\s)claude(\s|$)/.test(node.cmd) && !node.cmd.includes("intercom")) {
          const sid = sessionIdForPid(pid, node.cmd);
          if (sid && !map.has(sid)) map.set(sid, tmuxName);
        }
        for (const c of children.get(pid) || []) stack.push(c);
      }
    }
  }
  return map;
}

/** Resolve a claude process's session id: prefer --resume argv, fall back to open transcript. */
function sessionIdForPid(pid: number, cmd: string): string | null {
  const resume = cmd.match(/--resume\s+([0-9a-f-]{36})/i);
  if (resume) return resume[1];
  return openTranscriptSessionId(pid);
}

/** Find the *.jsonl transcript a claude pid currently has open (via lsof). */
function openTranscriptSessionId(pid: number): string | null {
  const lsof = run("lsof", ["-p", String(pid), "-Fn"]);
  if (!lsof) return null;
  let best: { sid: string; mtime: number } | null = null;
  for (const line of lsof.split("\n")) {
    if (!line.startsWith("n")) continue;
    const path = line.slice(1);
    if (!/\/projects\/.+\.jsonl$/.test(path)) continue;
    const sid = extractUuid(path);
    if (!sid) continue;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* ignore */
    }
    if (!best || mtime > best.mtime) best = { sid, mtime };
  }
  return best?.sid ?? null;
}

/** Identify the session this MCP server belongs to by walking up to the claude ancestor. */
export function selfSession(): SessionInfo | null {
  // Walk parent chain from our own pid up to find the claude CLI process.
  let pid = process.pid;
  const psOut = run("ps", ["-axo", "pid=,ppid=,command="]);
  const byPid = new Map<number, { ppid: number; cmd: string }>();
  if (psOut) {
    for (const line of psOut.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) byPid.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] });
    }
  }
  let sid: string | null = null;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const node = byPid.get(pid);
    if (!node) break;
    if (/(^|\/|\s)claude(\s|$)/.test(node.cmd) && !node.cmd.includes("intercom")) {
      sid = sessionIdForPid(pid, node.cmd);
      if (sid) break;
    }
    pid = node.ppid;
  }

  const all = listSessions({ scope: "all", limit: 9999 });
  if (sid) {
    const hit = all.find((s) => s.session_id === sid);
    if (hit) return hit;
  }
  // Fallback: most-recently-active transcript whose cwd matches our working dir.
  const cwd = process.cwd();
  const match = all.filter((s) => s.cwd === cwd).sort((a, b) => b.last_active_ms - a.last_active_ms);
  return match[0] ?? null;
}

export function listSessions(opts: { scope?: "all" | "live" | "recent"; limit?: number; project?: string } = {}): SessionInfo[] {
  const { scope = "recent", limit = 25, project } = opts;
  const live = liveMap();
  const out: SessionInfo[] = [];
  for (const path of transcriptFiles()) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const sid = extractUuid(path);
    if (!sid) continue;
    const { title, cwd } = peekTranscript(path);
    const projectName = cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "(unknown)";
    out.push({
      session_id: sid,
      title: title || "(no prompt yet)",
      project: projectName,
      cwd,
      last_active: new Date(mtime).toISOString(),
      last_active_ms: mtime,
      live: live.has(sid),
      tmux: live.get(sid),
      transcript: path,
    });
  }
  let filtered = out;
  if (project) {
    const q = project.toLowerCase();
    filtered = filtered.filter((s) => s.project.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }
  if (scope === "live") filtered = filtered.filter((s) => s.live);
  filtered.sort((a, b) => b.last_active_ms - a.last_active_ms);
  return filtered.slice(0, limit);
}

export function findSession(idOrPrefix: string): SessionInfo | null {
  const all = listSessions({ scope: "all", limit: 9999 });
  return (
    all.find((s) => s.session_id === idOrPrefix) ||
    all.find((s) => s.session_id.startsWith(idOrPrefix)) ||
    null
  );
}

/** Read assistant text that appears in a transcript after a given byte offset / timestamp. */
export function assistantTextSince(path: string, sinceMs: number): string {
  const chunks: string[] = [];
  try {
    const content = readFileSync(path, "utf8");
    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
      if (ts < sinceMs) continue;
      if (rec.type === "assistant" && rec.message?.content) {
        for (const block of rec.message.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            chunks.push(block.text.trim());
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return chunks.join("\n\n").trim();
}
