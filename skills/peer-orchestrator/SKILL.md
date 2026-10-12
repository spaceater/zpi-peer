---
name: peer-orchestrator
description: Policy for creating and steering equal pi peers. Load when considering peer_spawn — deciding to run directions in parallel, choosing a peer's starting context, or writing its first task.
---

# Peer Orchestrator

## Mental model
Peers are equal instances, not subordinates: you have no control over them, only a launch and a
messaging channel. Each peer has its own context, its own token budget, its own mistakes.
Work directly by default; spawn a peer only when the user asked for parallel/independent work,
or a task clearly warrants a separate context. Never spawn for a single lookup or a file read.

## The three tools

### `peer_spawn(topic, task, prompt?, context?, model?)`
Creates a peer in its own tmux pane and returns its sessionId immediately — no handshake. The peer
is named `[peer]<topic>`, receives `task` as its first message, and starts working as soon as it
boots. Use `peer_send_mail` for everything after that.

### `peer_send_mail(to, summary, message)`
Delivers a letter to any session's mailbox as a .md file with a frontmatter header (from + summary).
The recipient's poll injects only the summary plus the file path — never the full text; the recipient
reads the full letter itself and deletes the file afterwards. Notices reach a running session within
~1.5s — via steer while it is running, via followUp when it is idle — and pending notices merge into one
message. A dead recipient is revived automatically — the call may block up to ~20s and tells you
whether the revive succeeded; on failure the letter stays queued and is read whenever that session
next runs.
The summary is all the recipient sees up front: state who you are (name/sessionId) and what the
letter is about. The letter body must be self-contained: state whether a reply is needed and where
to send it. Batch related matters into one letter — every letter costs the recipient a turn.

### `peer_list(parent?, alive?, page?)`
Lists sessions with their creator, liveness, cwd, and sessionId — newest first, 40 per page; the
first line summarises the total count and the current page (pass `page` for older ones). Run it
before spawning: reusing or forking an existing peer beats recreating one. Use `parent: "self"` to
see only your own peers.

## Writing a spawn

### `topic`
The peer's name is `[peer]<topic>` (capped at 60 chars). Name the peer after its task or
responsibility in detail — a reader should understand what the peer does from the topic alone,
without opening its task. Use a semantic, mission-descriptive name, not a vague handle: e.g.
`investigate-auth-latency-and-analyze-causes`, `分析8月英伟达股价波动情况以判断未来走势` — not `task1`,
`helper`, or a bare `refactor-auth`.

### `task`
The task is the peer's entire brief — it has no other context. State: the goal, the boundaries,
the expected output format, and where to send the result (your own sessionId; the peer learns it
from what you write). Make it self-contained: the peer must be able to finish without asking back.

### `context`
- omit — empty context; cheapest; the default for a self-contained task.
- `fork:<sessionId>` — inherit that session's full history, and the forked peer also inherits its
  role (unless you pass a different `prompt`, or the source has no role — then nothing is inherited);
  only when the peer truly needs everything you know (expensive).
- `handoff:<text>` — you write exactly what the peer needs; best token/value ratio for a large
  context. To pass on your own context, write the handoff yourself — do NOT reuse your /compact
  summary: it is a self-continuation artifact and is stale by everything that happened after it.

### `prompt` (role)
Pass the path to a role file — no need to read it first; `peer_spawn` only checks it exists. The
role stays with that session across every start (fresh spawn, revive after a letter, or a manual
`/resume`), and editing the role file takes effect without respawning. Identity follows the
session, never the process: `/new` inside a peer's pane starts a plain session, while a fork
inherits the role of the session it branched from (unless you pass `prompt`) — spawn a proper
peer when a new one is needed.

## The standard roles
All three are read-only by intent. Peers launch with the full toolset; discipline comes from the
role file and your task text, not from restrictions. A peer can always mail you back.

The three role files ship inside this skill, under `roles/` — pass their paths (resolved from
this skill's directory) to `peer_spawn`'s prompt parameter. A same-named file in
`~/.pi/agent/` takes precedence when present, so users can override any role locally; any other
file path works too.

- `roles/AGENTS.scout.md` — fast reconnaissance. Use it to map unknown territory: key
  directories, entry points, one-line file descriptions. It locates, it does not analyze deeply,
  and it states its interpretation when your task is ambiguous.
- `roles/AGENTS.researcher.md` — directed research. Use it for a sourced findings brief on a
  question you could not answer from the code alone; every conclusion cites a file path or URL.
- `roles/AGENTS.critic.md` — independent review. Use it for an unpolluted second opinion on a
  plan, diff, or conclusion of yours; it answers VERDICT (agree / agree-with-changes / object)
  plus numbered findings by severity, each with quoted evidence and a concrete suggestion. It
  never rubber-stamps — give it the artifact, not your defense of it.

## Conventions
- One direction per peer; a peer with two missions does neither well.
- Tell the peer where to reply (your sessionId) in the task itself.
- Waiting for a peer's report does not require you to stay active: an incoming letter is injected into your context and starts a new conversation turn by itself, even after your output has ended. Finish your reply and stop; holding the turn open (timed pauses, re-checks, sleep) only burns time and tokens.
- No acknowledgements or small talk by letter; write only when there is substance.
- A peer that goes quiet is not stuck — letters merge while it is busy; wait for its report before
  nudging, and nudge with new information, not with "status?".
