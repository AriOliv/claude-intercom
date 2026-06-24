#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import { statSync } from "node:fs";
import { run, shortId } from "./util.js";
import { listSessions, selfSession, findSession, assistantTextSince, type SessionInfo } from "./sessions.js";
import { send, inbox, getMessage, markRead } from "./store.js";

const server = new McpServer({ name: "claude-intercom", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Resolve the current session, honoring an explicit override env var. */
function resolveSelf(): SessionInfo | null {
  const override = process.env.CLAUDE_INTERCOM_SESSION;
  if (override) return findSession(override);
  return selfSession();
}

function fmtSession(s: SessionInfo): string {
  const tag = s.live ? "🟢 live" : "⚪️ idle";
  const when = timeAgo(s.last_active_ms);
  return `- [${shortId(s.session_id)}] ${tag}  ${s.project}  · "${s.title}"  · ${when}${s.tmux ? `  · tmux:${s.tmux}` : ""}`;
}

function timeAgo(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Inject a single line into a live tmux session and submit it. */
function injectTmux(tmuxName: string, line: string): boolean {
  const oneLine = line.replace(/\s+/g, " ").trim();
  const a = run("tmux", ["send-keys", "-t", tmuxName, "-l", "--", oneLine]);
  if (a === null) return false;
  const b = run("tmux", ["send-keys", "-t", tmuxName, "Enter"]);
  return b !== null;
}

server.tool(
  "list_sessions",
  "List Claude Code sessions discovered on this machine — recent ones and which are currently live (running in a tmux pane). Use scope='live' to see only sessions you can reach right now, or pass a project filter.",
  {
    scope: z.enum(["recent", "live", "all"]).optional().describe("recent = sorted by last activity (default), live = only running sessions, all = everything"),
    project: z.string().optional().describe("filter by project name or path substring"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ scope, project, limit }) => {
    const sessions = listSessions({ scope: scope ?? "recent", project, limit: limit ?? 25 });
    if (sessions.length === 0) return text("No sessions found.");
    const me = resolveSelf();
    const lines = sessions.map((s) => (me && s.session_id === me.session_id ? fmtSession(s) + "  ← you" : fmtSession(s)));
    const liveCount = sessions.filter((s) => s.live).length;
    return text(`${sessions.length} session(s), ${liveCount} live:\n\n${lines.join("\n")}`);
  }
);

server.tool(
  "whoami",
  "Identify which Claude Code session this is (its id, project, and cwd). Useful so other sessions can message you back.",
  {},
  async () => {
    const me = resolveSelf();
    if (!me) {
      return text(
        "Could not auto-detect the current session. You can set CLAUDE_INTERCOM_SESSION=<session-id> in this MCP server's env to force it, or pass an explicit 'from' when messaging."
      );
    }
    return text(
      `You are session [${shortId(me.session_id)}]\n  full id: ${me.session_id}\n  project: ${me.project}\n  cwd: ${me.cwd}\n  live: ${me.live}${me.tmux ? `  (tmux: ${me.tmux})` : ""}`
    );
  }
);

server.tool(
  "send_message",
  "Send an async message to another Claude Code session. It lands in that session's intercom inbox; the recipient reads it with read_messages on its next turn. Set deliver_live=true to also inject it immediately into the recipient's live tmux pane (this interrupts whatever it's doing).",
  {
    to: z.string().describe("recipient session id or 8-char prefix (from list_sessions)"),
    text: z.string().describe("the message body"),
    deliver_live: z.boolean().optional().describe("if the recipient is live, also push the message into its terminal now"),
  },
  async ({ to, text: body, deliver_live }) => {
    const target = findSession(to);
    if (!target) return text(`No session matches "${to}". Run list_sessions first.`);
    const me = resolveSelf();
    if (me && target.session_id === me.session_id) return text("That's you — pick a different session.");

    const msg = send({
      from: me?.session_id ?? "unknown",
      from_title: me?.project ? `${me.project} [${me ? shortId(me.session_id) : "?"}]` : "unknown",
      to: target.session_id,
      kind: "message",
      text: body,
    });

    let live = "";
    if (deliver_live) {
      if (target.live && target.tmux) {
        const ok = injectTmux(
          target.tmux,
          `[intercom message from ${msg.from_title}] ${body} — (reply with the intercom 'reply' tool; message id ${shortId(msg.id)})`
        );
        live = ok ? " Also delivered live to its terminal." : " (live delivery failed; it's still in the inbox.)";
      } else {
        live = " (recipient is not live, so it'll see it on its next turn.)";
      }
    }
    return text(`Sent to [${shortId(target.session_id)}] ${target.project}. Message id ${shortId(msg.id)}.${live}`);
  }
);

server.tool(
  "read_messages",
  "Read intercom messages other sessions have sent to you. Call this at the start of a turn (or when prompted) to pick up cross-session messages. Marks them read.",
  {
    unread_only: z.boolean().optional().describe("only return messages you haven't read yet (default true)"),
  },
  async ({ unread_only }) => {
    const me = resolveSelf();
    if (!me) return text("Could not detect the current session, so I don't know whose inbox to read. Set CLAUDE_INTERCOM_SESSION to your session id.");
    const msgs = inbox(me.session_id, unread_only ?? true);
    if (msgs.length === 0) return text("No messages.");
    const out = msgs
      .map((m) => `• [${shortId(m.id)}] ${m.kind} from ${m.from_title} (${timeAgo(Date.parse(m.created_at))})${m.in_reply_to ? ` (re: ${shortId(m.in_reply_to)})` : ""}\n    ${m.text}`)
      .join("\n\n");
    for (const m of msgs) markRead(me.session_id, m.id);
    return text(`${msgs.length} message(s):\n\n${out}\n\nReply with the 'reply' tool using a message id.`);
  }
);

server.tool(
  "reply",
  "Reply to a message in your inbox. Looks up the original sender by message id and delivers your reply to their inbox (and live, if they're running).",
  {
    message_id: z.string().describe("the message id (or prefix) you are replying to, from read_messages"),
    text: z.string().describe("your reply"),
    deliver_live: z.boolean().optional().describe("also push the reply into the sender's terminal if it is live (default true)"),
  },
  async ({ message_id, text: body, deliver_live }) => {
    const me = resolveSelf();
    if (!me) return text("Could not detect the current session.");
    const all = inbox(me.session_id, false);
    const original = all.find((m) => m.id === message_id || m.id.startsWith(message_id));
    if (!original) return text(`No message in your inbox matches "${message_id}".`);

    const reply = send({
      from: me.session_id,
      from_title: `${me.project} [${shortId(me.session_id)}]`,
      to: original.from,
      kind: "reply",
      in_reply_to: original.id,
      text: body,
    });

    let live = "";
    if (deliver_live ?? true) {
      const sender = findSession(original.from);
      if (sender?.live && sender.tmux) {
        const ok = injectTmux(sender.tmux, `[intercom reply from ${reply.from_title}] ${body} — (re: your message ${shortId(original.id)})`);
        live = ok ? " Delivered live." : "";
      }
    }
    return text(`Replied to ${original.from_title}.${live}`);
  }
);

server.tool(
  "ask",
  "Ask a LIVE session a question and wait for its answer. Injects the question into the target's running terminal, then reads the answer back from its transcript. Only works on sessions marked live in list_sessions. Note: this interrupts what the target is currently doing.",
  {
    to: z.string().describe("target session id or prefix (must be live)"),
    question: z.string().describe("the question to ask"),
    wait_seconds: z.number().int().positive().max(300).optional().describe("how long to wait for an answer (default 90)"),
  },
  async ({ to, question, wait_seconds }) => {
    const target = findSession(to);
    if (!target) return text(`No session matches "${to}".`);
    const me = resolveSelf();
    if (me && target.session_id === me.session_id) return text("You can't ask yourself.");

    // Always record the question in the inbox for traceability.
    const msg = send({
      from: me?.session_id ?? "unknown",
      from_title: me?.project ? `${me.project} [${shortId(me.session_id)}]` : "unknown",
      to: target.session_id,
      kind: "question",
      text: question,
    });

    if (!target.live || !target.tmux) {
      return text(`Session [${shortId(target.session_id)}] is not live, so I can't get a synchronous answer. The question was placed in its inbox (id ${shortId(msg.id)}) and it will see it on its next turn.`);
    }

    const sinceMs = Date.now();
    const ok = injectTmux(
      target.tmux,
      `[intercom question from ${msg.from_title}] ${question} — please answer concisely in your reply text.`
    );
    if (!ok) return text("Failed to deliver the question into the target terminal.");

    const deadline = sinceMs + (wait_seconds ?? 90) * 1000;
    let last = "";
    let stableFor = 0;
    while (Date.now() < deadline) {
      await sleep(2500);
      let answer = "";
      try {
        // Re-stat to make sure we read the freshest transcript.
        statSync(target.transcript);
        answer = assistantTextSince(target.transcript, sinceMs);
      } catch {
        /* ignore */
      }
      if (answer && answer === last) {
        stableFor += 1;
        if (stableFor >= 2) break; // answer stopped growing -> the turn is done
      } else if (answer) {
        stableFor = 0;
        last = answer;
      }
    }
    if (!last) return text(`Asked [${shortId(target.session_id)}] but got no answer within the wait window. The question is in its inbox (id ${shortId(msg.id)}).`);
    const capped = last.length > 4000 ? last.slice(0, 4000) + "\n…(truncated)" : last;
    return text(`Answer from ${target.project} [${shortId(target.session_id)}]:\n\n${capped}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("claude-intercom failed to start:", err);
  process.exit(1);
});
