# @semanaut/zpi-peer

Equal, durable pi peers plus a letter channel between any pi sessions, for [pi](https://github.com/earendil-works/pi).

Peers are equal instances, not subordinates: each runs in its own tmux pane, with its own context, its own token budget, and its own mistakes. tmux is the single source of truth for who is alive — every peer pane carries an `@pi_sid` label, and a session is considered alive exactly while a live pane still holds its label. When the pane dies, the session id goes dark but its history stays durable on disk, so the peer can always be brought back.

## Management via tmux

- **Spawn**: a peer is launched in a new tmux pane with a pre-assigned sessionId. `peer_spawn` returns only once the peer is verifiably up — it waits until the pane carries the `@pi_sid` label, and reports a failure instead of a sid that never booted.
- **Liveness**: `@pi_sid` pane labels are the liveness signal. Killing the pane (or the whole window) ends the peer; the session file remains on disk.
- **Revive**: a dark session is restarted with `pi --session <sid>` in a fresh pane, restoring its full history. The sid becomes disk-durable once the peer submits its first message; a peer killed before that cannot be resumed.
- **Normal tmux workflow works**: switch panes/windows, watch a peer work live in its pane, kill it with tmux when done.

## The three tools

- **`peer_spawn`** — launch an equal peer in a tmux pane; optional role-prompt file and fork/handoff context.
- **`peer_list`** — list sessions and their liveness, filterable by creator ("self" = your own peers).
- **`peer_send_mail`** — deliver a letter to any pi session's mailbox, peers and human-started alike.

## Compatibility

zpi-peer only adds tools and session-scoped handlers and patches no pi internals, so it does not affect subagent or other orchestration extensions and can be used alongside them.

## Automatic revival

Mailing a dead recipient revives it automatically: the letter is delivered by first relaunching the session via `pi --session <sid>` in a new tmux pane, waiting (up to ~25s) until the pane is verifiably up, then injecting the notice — a running session gets it within ~1.5s (steer while running, followUp when idle). If the revive fails, the letter stays queued and is read at the next start. The mechanism never bypasses pi's own resume logic: no label within the budget (pi exited, or waits at an interactive prompt) counts as a failure.

## Bundled role prompts

Three standard role prompts ship with the package. Pass one as `peer_spawn`'s `prompt` parameter to give a peer a persistent role — a role is the main lever for shaping a peer's stance, so pass one whenever it fits the mission:

- **investigator** — find out what is true. Codebase reconnaissance and outside research in one role: a map of where things are, or a sourced brief on what the evidence says. It cites every path and URL it actually checked, and marks the line between verified facts and inference.
- **strategist** — make the call. Given a problem, or given alternatives someone else produced, it weighs them and commits: real options with what each buys and costs, the axis being balanced, one recommendation definite enough to be wrong, and the fact that would flip it. Decisive, not analytic — it decides, then says what would change its mind. It proposes; it does not plan execution steps or direct other peers.
- **auditor** — expose what does not hold, and dare to say so. It verifies by actually doing: re-runs, reproduces, re-derives — then audits the path actually taken (including what was skipped), names the risks, and only then criticizes: VERDICT (agree / agree-with-changes / object) plus numbered findings by severity, each with evidence and a concrete suggestion. It pours cold water on warm consensus and never rubber-stamps.

Roles here are responsibilities, not permissions. Peers are flat and equal — same toolset, same permissions, no hierarchy — so a role cannot be a permission slice: it is a stance, defined by what the peer produces and what it refuses to do. Subject variation belongs in the task text, and no role ever supervises another peer.

Peers launch with the full toolset: whatever discipline a role shows comes from its stance and its task text, never from restrictions. A peer can always mail back.

On every start the extension mirrors the bundled role files into the peer data directory (`<agent dir>/peer`); the bundled files sit next to the extension's parent directory, so when the extension is loaded from `<agent dir>/extensions` they are `<agent dir>/AGENTS.investigator.md` and so on. An edited or older copy is preserved as `<name>.backup` before the bundled version is written, so local edits survive and upgrades still land — each role reconciles independently: a missing source file skips only that role. Retired role files (`AGENTS.scout.md`, `AGENTS.researcher.md`, `AGENTS.critic.md` from 0.1.x) are moved aside as `.backup` too. Any other file path works for a custom role.

## Bundled skill

Installs the `peer-orchestrator` skill alongside the extension: the policy for when to spawn peers (only for genuinely parallel, independent work), how to write a self-contained first task, how to choose a peer's starting context, and how to batch follow-up letters.
