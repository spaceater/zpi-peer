---
name: peer-orchestrator
description: Policy for creating and steering equal pi peers. Load when considering peer_spawn, peer_list, peer_send_mail, or peer_name — deciding to run directions in parallel, choosing a peer's starting context, writing its first task, or reading/changing a session's name.
---

# Peer Orchestrator

## Mental model
Peers are equal instances, not subordinates: you have no control over them, only a launch and a messaging channel. Each peer has its own context, its own token budget, its own mistakes.
Work directly by default; spawn a peer only when the user asked for parallel/independent work, or a task clearly warrants a separate context. Never spawn for a single lookup or a file read.

## The four tools

### `peer_spawn(name, task, prompt?, context?, model?)`
Creates a peer in its own tmux pane and returns its sessionId immediately — no handshake. You name it at spawn — the peer is named `[peer]<name>` — it receives `task` as its first message, and starts working as soon as it boots. Use `peer_send_mail` for everything after that.

### `peer_send_mail(to, summary, message)`
Delivers a letter to any session's mailbox as a .md file with a frontmatter header (from + summary). The recipient's poll injects only the summary plus the file path; the recipient reads the full letter itself and deletes the file afterwards.
The summary is all the recipient sees up front: state who you are (name/sessionId) and what the letter is about. The letter body must be self-contained: state whether a reply is needed and where to send it. Batch related matters into one letter.
Notices reach a running session within seconds and pending notices merge into one message. A dead recipient is revived automatically — the call may block up to ~25s and tells you whether the revive succeeded; on failure the letter stays queued and is read whenever that session next runs.

### `peer_list(contact?, page?)`
Lists sessions with their contact count, cwd, and sessionId — newest first, 15 per page; the first line summarises the total count and the current page (pass `page` for older ones).
Use `contact: "self"` to see the sessions you have spawned or exchanged letters with (either direction counts); pass any other sessionId to inspect who that session has communicated with.
Run it before spawning: reusing or forking an existing peer beats recreating one — a session's whole history is on disk whether it is running or not, so mail it instead of spawning a duplicate.

### `peer_name(name?)`
Reads or sets THIS session's name. Omit `name` to read: the value returned is the name as it exists on disk; a session with no name entry reads as unnamed. Pass `name` to set: effective immediately.
Name is shown in `peer_list` as the first field and is the only thing a reader sees before deciding to mail, so the name should declare and stay consistent with exact function, responsibility, and state.
Your name is your own responsibility. Whenever your state changes — retirement, a new direction, a changed task — update your name with `peer_name` in the same run, so that other peers are not misled.

## Writing a spawn

### `name`
The peer's name is `[peer]<name>`. The name is the peer's identity carrier — see `peer_name`. A compliant name declares function, responsibility, and state, separated by `|`: e.g. `investigate-auth-latency-and-root-causes | owns the auth-latency diagnosis report for the main session | active, one-shot mission`, `宏观与全球央行跟踪 | 负责 economy 日报的宏观板块 | 活跃,每日例行`, `英伟达股价走势分析 | 已交付一次性走势判断报告 | 已退役 2026-10-19` — not `task1`, `helper`, a bare `refactor-auth`, or a function-only name like `investigate-auth-latency-and-analyze-causes` (no responsibility, no state).

### `task`
The task is the peer's entire brief — it has no other context. State: the goal, the boundaries, the expected output format, and where to send the result (your own sessionId; the peer learns it from what you write). Make it self-contained: the peer must be able to finish without asking back.

### `context`
- omit — empty context; cheapest; the default for a self-contained task.
- `fork:<sessionId>` — inherit that session's full history, and the forked peer also inherits its role (unless you pass a different `prompt`, or the source has no role — then nothing is inherited); only when the peer truly needs everything you know (expensive).
- `handoff:<text>` — you write exactly what the peer needs; best token/value ratio for a large context. To pass on your own context, write the handoff yourself — do NOT reuse your /compact summary: it is a self-continuation artifact and is stale by everything that happened after it.

### `prompt` (role)
Path to a role file. Its text is appended to the peer's system prompt on every turn — it survives every restart (spawn, revive, manual resume), and editing the file takes effect without respawning. Pass one whenever it fits the mission; omitted, the peer runs with no discipline beyond its task.

## The standard roles

A role is a stance, not a rank and not permissions. It changes how the peer works — what it produces and what it refuses — never what it works on: "review the frontend" is a task, "verify, audit, then criticize" is a role. It never grants control over other peers: every peer stays equal.
Pass the path of the role file you want to `peer_spawn`'s prompt parameter; the exact paths are given in the peer_spawn tool description. For a custom role, pass the path of any other role file.

- **investigator** — find out what is true. Merges codebase reconnaissance with outside research: a map of where things are, or a sourced brief on what the evidence says. It cites every path and URL it actually checked, and marks the boundary between what it verified and what it infers. Use it whenever you need facts you do not have.
- **strategist** — make the call. Given a problem, or given alternatives someone else produced, it weighs them and commits: real options with what each buys and costs, the axis being balanced, one recommendation definite enough to be wrong, and the fact that would flip it. Decisive, not analytic — it decides, then says what would change its mind. It proposes; it does not plan execution steps or direct other peers. Use it before committing to an approach.
- **auditor** — expose what does not hold, and dare to say so. It verifies by actually doing: re-runs, reproduces, re-derives — then audits the path actually taken (including what was skipped), names the risks, and only then criticizes: VERDICT (agree / agree-with-changes / object) plus numbered findings by severity, each with evidence and a concrete suggestion. It pours cold water on warm consensus and never rubber-stamps — give it the artifact, not your defense of it.

## Conventions
- One direction per peer; a peer with two missions does neither well.
- Tell the peer where to reply (your sessionId) in the task itself.
- Waiting for a peer's report does not require you to stay active: an incoming letter is injected into your context and starts a new conversation turn by itself, even after your output has ended. Finish your reply and stop; holding the turn open (timed pauses, re-checks, sleep) only burns time and tokens.
- No acknowledgements or small talk by letter; write only when there is substance.
- Keep the name truthful: a name that has drifted from the peer's real state is a bug — update it with `peer_name` in the same run that changes the state.
- A peer that goes quiet is not stuck — letters merge while it is busy; wait for its report before nudging, and nudge with new information, not with "status?".
