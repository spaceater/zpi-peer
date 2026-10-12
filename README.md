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

## Automatic revival

Mailing a dead recipient revives it automatically: the letter is delivered by first relaunching the session via `pi --session <sid>` in a new tmux pane, waiting (up to ~25s) until the pane is verifiably up, then injecting the notice — a running session gets it within ~1.5s (steer while running, followUp when idle). If the revive fails, the letter stays queued and is read at the next start. The mechanism never bypasses pi's own resume logic: no label within the budget (pi exited, or waits at an interactive prompt) counts as a failure.

## Bundled skill

Installs the `peer-orchestrator` skill alongside the extension: the policy for when to spawn peers (only for genuinely parallel, independent work), how to write a self-contained first task, how to choose a peer's starting context, and how to batch follow-up letters.
