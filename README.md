# claude-intercom

An [MCP](https://modelcontextprotocol.io) server that lets **Claude Code sessions talk to each other**.

Run many Claude Code sessions at once (e.g. with [agent-deck](https://github.com/asheshgoplani/agent-deck), tmux, or just several terminals) and let them:

- **`list_sessions`** — discover recent sessions and see which are *live* right now
- **`whoami`** — find out which session you are
- **`send_message`** — drop an async message into another session's inbox
- **`read_messages`** — pick up messages other sessions sent you
- **`reply`** — answer a message you received
- **`ask`** — ask a *live* session a question and get its answer back synchronously

No daemon, no database. Messages are plain JSON files under `~/.claude-intercom/`, and sessions are discovered from Claude Code's own transcripts (`~/.claude/projects/`).

---

## How it works

- **Discovery.** Every Claude Code session writes a transcript to `~/.claude/projects/<project>/<session-id>.jsonl`. `list_sessions` reads those for the session id, project, first prompt (as a title), and last-active time.
- **Liveness.** A session is "live" if its `claude` process is running inside a tmux pane. The server correlates tmux panes → processes → the session id each one has open.
- **Self-identity.** The server walks up from its own process to the parent `claude` process and uses `lsof` to find which transcript that process has open — that's *you*. (Override with `CLAUDE_INTERCOM_SESSION` if detection ever fails.)
- **Live delivery / `ask`.** For a live target, the message is typed into its tmux pane with `tmux send-keys`. For `ask`, the server then tails the target's transcript and returns the assistant text that appears in response.

> **Heads up:** live delivery and `ask` *interrupt* whatever the target session is doing, exactly as if you typed into its terminal. Async `send_message` (the default) does not — the recipient sees it when it next calls `read_messages`.

## Requirements

- Node.js ≥ 18
- `tmux`, `ps`, and `lsof` on `PATH` (standard on macOS/Linux) — only needed for liveness, live delivery, and `ask`. Async messaging works without them.

## Install

### From source (recommended today)

```bash
git clone https://github.com/AriOliv/claude-intercom
cd claude-intercom
npm install
npm run build
```

Then register it with Claude Code (user scope = available in every session):

```bash
claude mcp add intercom -s user -- node "$(pwd)/dist/index.js"
```

If you run several Claude Code config dirs, register it in each:

```bash
CLAUDE_CONFIG_DIR=~/.claude     claude mcp add intercom -s user -- node "$(pwd)/dist/index.js"
CLAUDE_CONFIG_DIR=~/.claude-ari claude mcp add intercom -s user -- node "$(pwd)/dist/index.js"
```

### Via npx (once published to npm)

```bash
claude mcp add intercom -s user -- npx -y claude-intercom
```

Or add it to your MCP config manually:

```json
{
  "mcpServers": {
    "intercom": {
      "command": "node",
      "args": ["/absolute/path/to/claude-intercom/dist/index.js"]
    }
  }
}
```

## Usage

In any Claude Code session:

> "List the other sessions I have open."

> "Ask the litellm session whether the model-selection refactor is merged yet."

> "Tell the BRLA session I'm done with the migration — it can rebase."

> "Check my intercom inbox."

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code stores `projects/` transcripts |
| `CLAUDE_INTERCOM_DIR` | `~/.claude-intercom` | Where messages are stored |
| `CLAUDE_INTERCOM_SESSION` | _(auto)_ | Force this server's session identity (a session id) |
| `CLAUDE_INTERCOM_RESUME_FLAGS` | _(empty)_ | Extra flags passed to `claude -p --resume` when `ask` reaches an **idle** session (e.g. `--dangerously-skip-permissions`). Empty = safe default. |

## Reaching idle sessions

`ask` works whether the target is live or idle. A **live** session (running in a
tmux pane) gets the question typed into its terminal. An **idle** session — one
whose transcript exists but isn't currently running — is resumed headlessly with
`claude -p --resume <id>` in its own cwd, so you can still reach it; the thread
continues in the same transcript. Set `CLAUDE_INTERCOM_RESUME_FLAGS` if those
headless resumes need extra flags.

## Hands-off pickup (optional Stop hook)

`hooks/pickup-stop.mjs` is a Claude Code **Stop hook**: when a session finishes a
turn, it pulls any unread messages addressed to that session and feeds them back
so the session handles them (and replies) without anyone calling `read_messages`.
Register it in `settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "node /absolute/path/to/claude-intercom/hooks/pickup-stop.mjs" }
] } ] } }
```

## Development

```bash
npm install
npm run build      # compile to dist/
npm run dev        # run from source with tsx
```

## Limitations

- Liveness, live delivery, and `ask` assume sessions run inside **tmux**. Plain-terminal sessions still work for `list_sessions` and async `send_message`/`read_messages`.
- `ask` reads the answer by tailing the target's transcript; it returns the assistant text produced after the question, capped at ~4k chars. It's pragmatic, not a structured RPC.
- A session only checks its inbox when something calls `read_messages` (or you tell it to). Pair it with a hook or a polling loop if you want hands-off pickup.

## License

MIT
