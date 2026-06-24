#!/usr/bin/env node
// Claude Code **Stop hook** for claude-intercom.
//
// When a session finishes a turn, this picks up any unread intercom messages
// addressed to it and feeds them back so the session handles them right away
// (and can answer with the intercom `reply` tool). It's how a session "responds
// on its own" to send_message without anyone calling read_messages manually.
//
// Install it under hooks.Stop in settings.json:
//   { "hooks": { "Stop": [ { "hooks": [
//       { "type": "command", "command": "node /opt/claude-intercom/hooks/pickup-stop.mjs" }
//   ] } ] } }
//
// Safe no-op when there are no unread messages (lets the session stop normally).
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let sid;
  try {
    sid = JSON.parse(input).session_id;
  } catch {
    process.exit(0);
  }
  if (!sid) process.exit(0);

  const base = process.env.CLAUDE_INTERCOM_DIR || join(homedir(), ".claude-intercom");
  const dir = join(base, "inbox", sid);
  if (!existsSync(dir)) process.exit(0);

  const picked = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = join(dir, f);
      const m = JSON.parse(readFileSync(p, "utf8"));
      if (m.read_at) continue;
      m.read_at = new Date().toISOString();
      writeFileSync(p, JSON.stringify(m, null, 2));
      picked.push(m);
    } catch {
      /* ignore unreadable entries */
    }
  }
  if (!picked.length) process.exit(0);

  const body = picked
    .map((m) => `- [${m.kind} ${String(m.id).slice(0, 8)}] from ${m.from_title}: ${m.text}`)
    .join("\n");
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason:
        `You have ${picked.length} new intercom message(s). Address them now; ` +
        `if a response is expected, send it with the intercom 'reply' tool (use the message id).\n${body}`,
    })
  );
  process.exit(0);
});
