import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

/** Run a command and return trimmed stdout, or null on any error. Never throws. */
export function run(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The Claude Code config dir holding the `projects/` transcripts. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir(): string {
  return join(configDir(), "projects");
}

/** Shared mailbox root. Override with CLAUDE_INTERCOM_DIR. */
export function commsDir(): string {
  const dir = process.env.CLAUDE_INTERCOM_DIR || join(homedir(), ".claude-intercom");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** Match a session UUID anywhere in a string (e.g. a transcript path or argv). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function extractUuid(s: string): string | null {
  const m = s.match(UUID_RE);
  return m ? m[0] : null;
}
