import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi-peer — equal, durable peers in tmux windows + a letter channel between any pi
// sessions. A session is alive exactly while a live pane carries its @pi_sid label.

const NOT_IN_TMUX_SERVER_DOWN =
	"tmux is not running and this pi instance is not inside it ($TMUX is unset). Peers live in windows of the caller's own tmux session, so start tmux and run pi inside it first — without that, peer_spawn / peer_list / peer_send_mail cannot work properly.";
const NOT_IN_TMUX_SERVER_UP =
	"a tmux server is running, but this pi instance is not inside tmux ($TMUX is unset). Peers live in windows of the caller's own tmux session, so move this pi instance into a tmux pane (restart it inside tmux) first — outside tmux, peer_spawn / peer_list / peer_send_mail cannot work properly.";
const POLL_MS = 1500;
const SKILL_GATE =
	"Before calling this tool, read the peer-orchestrator skill.";
const REVIVE_TIMEOUT_MS = 25_000;
const SPAWN_BOOT_TIMEOUT_MS = 20_000;
const LIST_PAGE_SIZE = 40;
const BATCH_SEP = "\n\n──────── next letter ────────\n\n";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface PeerRecord {
	creatorSessionId: string;
	/** Absolute role-file path; absent for plain peers. */
	appendPrompt?: string;
}

interface SessionRecord {
	sessionId: string;
	name: string | null;
	cwd: string;
	startedAt: number;
	alive: boolean;
	peer?: PeerRecord;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** v7 (time-ordered) to match pi's own session ids. */
function uuidv7(): string {
	const ts = BigInt(Date.now());
	const b = randomBytes(16);
	b[0] = Number(ts >> 40n);
	b[1] = Number(ts >> 32n);
	b[2] = Number(ts >> 24n);
	b[3] = Number(ts >> 16n);
	b[4] = Number(ts >> 8n);
	b[5] = Number(ts);
	b[6] = (b[6] & 0x0f) | 0x70;
	b[8] = (b[8] & 0x3f) | 0x80;
	const hex = b.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** First gate of every peer tool: this pi must run inside tmux. A throw reads as "server down". */
async function tmuxGuard(pi: ExtensionAPI): Promise<string | null> {
	if (process.env.TMUX) return null;
	let serverUp = false;
	try {
		serverUp = (await pi.exec("tmux", ["list-sessions"], {})).code === 0;
	} catch {}
	return serverUp ? NOT_IN_TMUX_SERVER_UP : NOT_IN_TMUX_SERVER_DOWN;
}

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The pi invocation for a pane command: works under node, bun and the compiled binary.
 *  PI_PEER_CMD, when set, overrides the launcher used for panes
 *  (a deployment pin — takes precedence over execPath). */
function piCommandString(args: string[]): string {
	const script = process.argv[1];
	const launcher =
		script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)
			? [process.execPath, script]
			: /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
				? ["pi"]
				: [process.env.PI_PEER_CMD || process.execPath];
	return [...launcher, ...args].map(shq).join(" ");
}

/** pi + optional first user message. Nothing holds the pane open, so a peer's window closes with its pi. */
function buildCommand(opts: { args: string[]; firstMessage?: string }): string {
	const msg = opts.firstMessage;
	const positional = msg === undefined || msg === "" ? "" : ` -- ${shq(/^[-@]/.test(msg) ? ` ${msg}` : msg)}`;
	return `${piCommandString(opts.args)}${positional}`;
}

/** pi.exec can THROW instead of returning non-zero — every throw is folded into { ok: false } and never escapes. */
async function launchPane(
	pi: ExtensionAPI,
	cmdStr: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ ok: true; pane: string } | { ok: false; message: string }> {
	try {
		// -d: the peer's window must not steal focus from whatever the user is looking at.
		const r = await pi.exec("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, cmdStr], { signal });
		if (r.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim() || `tmux exited ${r.code}` };
		return { ok: true, pane: r.stdout.trim().split("\n").pop() ?? "" };
	} catch (e: any) {
		return { ok: false, message: `tmux could not be run: ${String(e?.message ?? e)}` };
	}
}

/** Best-effort pane kill: never throws, ignores abort. */
async function killPane(pi: ExtensionAPI, pane: string): Promise<void> {
	try {
		await pi.exec("tmux", ["kill-pane", "-t", pane], {}); // no signal: cleanup must run even when aborted
	} catch {}
}

// Every TUI pi labels its own pane with its sessionId; the pane dies with its pi, so the label
// needs no TTL. print/json/rpc runs must not steal their pane's label.

/** pane_id -> @pi_sid of every live pane. THROWS when tmux is unreachable — never silently "nothing is alive". */
async function paneLabels(pi: ExtensionAPI): Promise<Map<string, string>> {
	const r = await pi.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}|#{@pi_sid}|#{pane_dead}"], {});
	if (r.code !== 0) {
		const detail = (r.stderr || r.stdout).trim() || `exited ${r.code}`;
		throw new Error(`tmux list-panes failed: ${detail}`);
	}
	const out = new Map<string, string>();
	for (const line of (r.stdout ?? "").split("\n")) {
		const [pane, sid, dead] = line.split("|");
		if (pane && dead === "0") out.set(pane, UUID_RE.test(sid) ? sid : "");
	}
	return out;
}

/** Best effort — without the label this session reads as dead. */
async function labelPane(pi: ExtensionAPI, sid: string): Promise<void> {
	const pane = process.env.TMUX_PANE;
	if (!pane) return;
	try {
		await pi.exec("tmux", ["set-option", "-p", "-t", pane, "@pi_sid", sid], {});
	} catch {}
}

/** True only once the peer labels its pane (its session_start writes it — proof of boot). A gone pane means pi exited: fail at once. */
async function waitForBoot(
	pi: ExtensionAPI,
	sid: string,
	pane: string,
	signal?: AbortSignal,
	budgetMs: number = SPAWN_BOOT_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline && !signal?.aborted) {
		let labels: Map<string, string>;
		try {
			labels = await paneLabels(pi);
		} catch {
			return false; // tmux unreachable mid-boot: the boot can no longer be confirmed
		}
		const label = labels.get(pane);
		if (label === sid) return true;
		if (label === undefined) return false;
		await sleep(500);
	}
	return false;
}

const registryDir = () => path.join(getAgentDir(), "peer", "registry");

/** Expand a leading ~/ — fs.* and pi's prompt resolution do not. */
function expandPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

// Peer identity lives ONLY here, never in session files — a fork cannot pollute it by
// file copying, and no scan can miss it. The spawner writes before launching, newest-wins.
function writePeerRecord(sid: string, rec: PeerRecord): void {
	fs.mkdirSync(registryDir(), { recursive: true });
	const norm: PeerRecord = rec.appendPrompt ? { ...rec, appendPrompt: expandPath(rec.appendPrompt) } : rec;
	const file = path.join(registryDir(), `${sid}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(norm));
	fs.renameSync(tmp, file); // tmp+rename: readers never see a half-written record
}

// Records are write-once, so this cache (negatives included) never goes stale.
const recordCache = new Map<string, PeerRecord | null>();

function readPeerRecord(sid: string): PeerRecord | null {
	const hit = recordCache.get(sid);
	if (hit !== undefined) return hit;
	let rec: PeerRecord | null = null;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(registryDir(), `${sid}.json`), "utf-8"));
		if (raw && typeof raw.creatorSessionId === "string") rec = raw as PeerRecord;
	} catch {}
	recordCache.set(sid, rec);
	return rec;
}

function deletePeerRecord(sid: string): void {
	try {
		fs.unlinkSync(path.join(registryDir(), `${sid}.json`));
	} catch {}
	recordCache.delete(sid);
}

function listPeerRecords(): Map<string, PeerRecord> {
	const out = new Map<string, PeerRecord>();
	let names: string[];
	try {
		names = fs.readdirSync(registryDir());
	} catch {
		return out;
	}
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		const sid = n.slice(0, -".json".length);
		const rec = readPeerRecord(sid);
		if (rec) out.set(sid, rec);
	}
	return out;
}

/** Sessions on disk joined with the registry. Uses pi's listAll(): its parser lets the LAST session_info win, naming a fork after itself, not its parent. */
async function scanAllSessions(pi: ExtensionAPI): Promise<SessionRecord[]> {
	const infos = await SessionManager.listAll();
	const alive = new Set((await paneLabels(pi)).values());
	const records: SessionRecord[] = infos.map((info) => {
		const started = info.created.getTime();
		return {
			sessionId: info.id,
			name: info.name ?? null,
			cwd: info.cwd,
			startedAt: Number.isNaN(started) ? info.modified.getTime() : started,
			alive: alive.has(info.id),
		};
	});
	const peers = listPeerRecords();
	for (const r of records) {
		const rec = peers.get(r.sessionId);
		if (rec) r.peer = rec;
	}
	records.sort((a, b) => b.startedAt - a.startedAt);
	return records;
}

// Exact match only: ids are time-ordered UUIDs, so a prefix match is ambiguous.
function findSessionById(records: SessionRecord[], sessionId: string): SessionRecord | undefined {
	return records.find((r) => r.sessionId === sessionId);
}
const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** Uniform failed-tool result: "<code>: <detail>" text plus structured { code, message, …extra }. */
function errResult(code: string, detail: string, extra?: Record<string, unknown>) {
	const message = `${code}: ${detail}`;
	return {
		content: [{ type: "text" as const, text: message }],
		details: { code, message, ...extra },
		isError: true,
	};
}

// Letters: <agentDir>/peer/letters/<recipientSid>/<hex>.md — one file per letter, no lock, no
// ordering. The recipient's poll injects only the summary + file path (merged into one message)
// and marks the letter announced by RENAMING it to acknowledged-<name>.md — the filename is the
// dedup state, so a letter is announced at most once ever. The recipient reads and deletes the
// file itself.

const boxDir = (sid: string) => path.join(getAgentDir(), "peer", "letters", sid);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Parse a letter's frontmatter header (from + summary), as written by post(). */
function parseLetterHeader(text: string): { from: string | null; summary: string | null } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return { from: null, summary: null };
	const pick = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(m[1])?.[1]?.trim() || null;
	return { from: pick("from"), summary: pick("summary") };
}

function formatNotice(file: string, text: string): string {
	const { from, summary } = parseLetterHeader(text);
	return [
		`New letter received.`,
		`From: ${from ?? "unknown sender"}`,
		`Summary: ${summary ?? "(no summary header)"}`,
		`Full letter file: "${file}" — read it yourself with the read tool, delete the letter file (rm) after reading so letters won't pile up.`,
	].join("\n");
}

/** Unique names mean writers never coordinate; tmp+rename means readers never see a half-write. */
async function post(sid: string, message: string, header: { from: string; summary: string }): Promise<string> {
	const dir = boxDir(sid);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${randomBytes(8).toString("hex")}.md`);
	const text = `---\nfrom: ${oneLine(header.from)}\nsummary: ${oneLine(header.summary)}\n---\n\n${message}\n`;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
	return file;
}

const ACK = "acknowledged-"; // filename prefix: this letter has already been announced

/** Order means nothing — one tick delivers them all merged. */
function pendingLetters(dir: string): string[] {
	try {
		return fs.readdirSync(dir)
			.filter((n) => n.endsWith(".md") && !n.startsWith(ACK))
			.sort();
	} catch {
		return [];
	}
}

/** Returns the renamed path (where the recipient finds it), or null if already deleted. */
function acknowledge(dir: string, name: string): string | null {
	try {
		fs.renameSync(path.join(dir, name), path.join(dir, `${ACK}${name}`));
		return path.join(dir, `${ACK}${name}`);
	} catch {
		return null;
	}
}

/** Announce waiting letters merged — steer while running, followUp when idle. */
function startInboxLoop(pi: ExtensionAPI, sid: string, isIdle: () => boolean): () => void {
	const dir = boxDir(sid);
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		try {
			const batch: string[] = [];
			for (const name of pendingLetters(dir)) {
				let text: string;
				try {
					text = fs.readFileSync(path.join(dir, name), "utf-8");
				} catch {
					continue; // unreadable right now: retry on a later tick
				}
				const file = acknowledge(dir, name);
				if (!file) continue; // deleted underneath us: already read
				batch.push(formatNotice(file, text));
			}
			if (batch.length === 0) return;
			pi.sendUserMessage(batch.join(BATCH_SEP), { deliverAs: isIdle() ? "followUp" : "steer" });
		} catch {}
	};

	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	const timer = setInterval(tick, POLL_MS);
	timer.unref?.();
	// Deferred: a synchronous tick would deliver letters from inside the session_start
	// dispatch — the first turn could start before the role hook has run.
	setTimeout(() => tick(), POLL_MS);

	return () => {
		stopped = true;
		clearInterval(timer);
		try {
			fs.rmdirSync(dir);
		} catch {}
	};
}

/**
 * Revive via `pi --session <sid>` — never `--session-id` to CONTINUE: it is project-scoped
 * and silently creates an empty same-id session from the wrong cwd. pi's own resume logic is
 * the only judge: no label within the budget (pi exited, or waits at an interactive prompt
 * in the detached pane) → fail and close the window. No diagnosis, no remediation.
 */
async function revivePeer(pi: ExtensionAPI, sid: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
	const fail = (stage: string, detail: string) => ({ ok: false, message: `revive failed at ${stage}: ${detail}` });

	const cmdStr = buildCommand({ args: ["--session", sid] });
	const launched = await launchPane(pi, cmdStr, cwd, signal);
	if (!launched.ok) return fail("tmux", launched.message);
	const pane = launched.pane;

	const up = await waitForBoot(pi, sid, pane, signal, REVIVE_TIMEOUT_MS);
	if (up) return { ok: true, message: `session revived via pi --session: sessionId=${sid} | pane=${pane}` };
	await killPane(pi, pane);
	return fail(
		"boot",
		signal?.aborted
			? "revive cancelled while waiting for the session to come up"
			: `the session did not come up within ${REVIVE_TIMEOUT_MS}ms — pi exited, or stopped at an interactive prompt in the detached pane (window closed)`,
	);
}

export default function piPeer(pi: ExtensionAPI) {
	// On a revive the role must be resolved before any pending letter can start a turn —
	// session_start does both, in that order.

	// Role file of the current session, null for plain sessions; records store absolute paths.
	let roleSid: string | null = null;
	let appendPromptPath: string | null = null;
	const loadOwnRole = (sid: string) => {
		roleSid = sid;
		appendPromptPath = readPeerRecord(sid)?.appendPrompt ?? null;
	};

	// A fork keeps the branched session's role; an existing record is never copied over —
	// the spawner's own write (copy, then override) is newer and wins.
	const inheritRoleFromFork = (event: { reason?: string; previousSessionFile?: string }, ownSid: string) => {
		if (event.reason !== "fork" || !event.previousSessionFile) return;
		const file = path.basename(event.previousSessionFile);
		const srcSid = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length).split("_").pop() : undefined;
		if (!srcSid || fs.existsSync(path.join(registryDir(), `${ownSid}.json`))) return;
		const src = readPeerRecord(srcSid);
		if (!src?.appendPrompt) return;
		writePeerRecord(ownSid, { ...src });
		recordCache.delete(ownSid); // a lookup may already have cached "no record" for this sid
	};

	let stopLoop: (() => void) | null = null;

	pi.on("session_start", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		inheritRoleFromFork(event, sid);
		loadOwnRole(sid);
		// Only a TUI owns a pane: a nested print/json pi inherits $TMUX_PANE and would steal it.
		if (ctx.mode === "tui") await labelPane(pi, sid);
		stopLoop?.();
		stopLoop = startInboxLoop(pi, sid, () => ctx.isIdle());
	});

	// pi persists no system prompt (--append-system-prompt vanishes on resume), so the role is
	// re-applied EVERY turn from the file the registry points at. Identity follows the SESSION,
	// not the process: /new inside a peer's pane runs plain; a fork inherits the branched
	// session's role. Idempotent: skips when already present.
	pi.on("before_agent_start", async (event, ctx) => {
		// Re-resolve on session switch so the role never leaks across sessions.
		const sid = ctx.sessionManager.getSessionId();
		if (sid !== roleSid) loadOwnRole(sid);
		if (!appendPromptPath) return;
		let text: string;
		try {
			text = fs.readFileSync(appendPromptPath, "utf-8").trim();
		} catch {
			return; // role file gone: run without it rather than fail the turn
		}
		if (!text || event.systemPrompt.includes(text)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
	});

	pi.registerTool({
		name: "peer_spawn",
		label: "Spawn peer",
		description:
			`Spawn an equal pi peer in a tmux pane with a pre-assigned sessionId. ${SKILL_GATE} It returns only once the peer is verifiably up — it blocks up to ~${SPAWN_BOOT_TIMEOUT_MS / 1000}s until the peer labels the pane it was given, and reports a failure instead of handing back a sid that never booted. The returned sid becomes disk-durable a few seconds after return, when the peer submits its first message (pi persists the session file then, not at boot); a peer killed before that leaves no session — its sid goes dark (mail queues, resume reports not found). The task is delivered at launch as the peer's first user message. Use peer_send_mail for follow-up letters. prompt: path to a role file that stays with the peer across every start — standard roles: critic, researcher, scout — the role files ship inside the peer-orchestrator skill under roles/ (the skill, resolvable from its directory, lists them; any other file path works for a custom role). context: omit = empty | fork:<sessionId> = fork that session's full history, and the forked peer also inherits its role unless prompt overrides it | handoff:<text> = custom context text (prepended to the first message).`,
		promptGuidelines: [
			"Use peer_spawn only when the user asked for parallel/independent work or a task clearly warrants a separate context; every letter sent via peer_send_mail costs the recipient one LLM turn.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Session topic; the peer is named '[peer]<topic>'" }),
			task: Type.String({ description: "Self-contained first message; delivered at launch as the peer's first user message" }),
			prompt: Type.Optional(
				Type.String({
					description:
						"Path to a role-prompt file (errors if it does not exist). The role stays with the peer across every start — spawn, mail revive, or a user-run /resume — and the file is re-read per turn, so editing it takes effect without respawning. Identity follows the session: /new inside a peer's pane starts a plain session, while a fork inherits the role of the session it branched from unless this overrides it. Standard roles: critic / researcher / scout (files bundled in the peer-orchestrator skill's roles/ directory; any other file path works for a custom role); omit for a plain peer.",
				}),
			),
			context: Type.Optional(
				Type.String({
					description:
						"fork:<sessionId> | handoff:<text>; omit for empty context. fork: takes the exact lowercase 36-character sessionId (peer_list shows them); the forked peer inherits that session's role",
				}),
			),
			model: Type.Optional(Type.String({ description: "Override model (provider/model-id)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const fail = (code: string, detail: string) => errResult(code, detail, { ok: false });

			const tmuxProblem = await tmuxGuard(pi);
			if (tmuxProblem) return fail("no_tmux", tmuxProblem);

			// Pre-assigned id: --session-id creates exactly this session; the wait after launch only confirms it.
			const sid = uuidv7();
			const name = `[peer]${params.topic}`.slice(0, 60);

			let mode = "empty";
			let forkSid: string | undefined;
			let inherited: PeerRecord | undefined;
			let payload: string | undefined;
			const ctxArg = (params.context ?? "").trim();
			if (ctxArg) {
				const sep = ctxArg.indexOf(":");
				const kind = sep === -1 ? ctxArg : ctxArg.slice(0, sep);
				const rest = sep === -1 ? "" : ctxArg.slice(sep + 1);
				if (kind === "fork") {
					const src = rest.trim();
					if (!UUID_RE.test(src)) return fail("bad_context", `fork: expects an exact lowercase sessionId, got "${rest}"`);
					const source = findSessionById(await scanAllSessions(pi), src);
					if (!source) return fail("unknown_session", `fork: no session with id ${src} (try peer_list)`);
					mode = "fork";
					forkSid = src;
					inherited = source.peer; // the forked session's registry fields, overridden below
				} else if (kind === "handoff") {
					mode = "handoff";
					payload = rest;
				} else {
					return fail("bad_context", `cannot parse context "${params.context}"; supported: fork:<sessionId> | handoff:<text> | omit for empty`);
				}
			}

			let appendPrompt: string | undefined;
			if (params.prompt) {
				appendPrompt = expandPath(params.prompt);
				if (!fs.existsSync(appendPrompt)) return fail("prompt_file_missing", `prompt file not found: ${params.prompt}`);
			}
			// Newest-wins: a fork copies the source record, this spawn's fields override it.
			writePeerRecord(sid, {
				...(inherited ?? {}),
				creatorSessionId: ctx.sessionManager.getSessionId(),
				...(appendPrompt ? { appendPrompt } : {}),
			});

			// No --append-system-prompt: the role hook re-applies the role file every turn.
			const piArgs: string[] = ["--session-id", sid, "--name", name];
			let parentModel: string | undefined;
			try {
				const m = (ctx as any).model;
				if (m?.id) parentModel = m.provider ? `${m.provider}/${m.id}` : m.id;
			} catch {}
			const model = params.model ?? parentModel;
			if (model) piArgs.push("--model", model);
			if (forkSid) piArgs.push("--fork", forkSid);

			// Every failure path below removes the record, so a sid that never booted never lingers.
			const launched = await launchPane(
				pi,
				buildCommand({
					args: piArgs,
					firstMessage: payload ? `${payload}\n\n---\n\n${params.task}` : params.task,
				}),
				ctx.cwd,
				signal,
			);
			if (!launched.ok) {
				deletePeerRecord(sid);
				return fail("boot_failed", launched.message);
			}

			// No sid is reported until the peer labels its pane.
			if (!(await waitForBoot(pi, sid, launched.pane, signal))) {
				const why = signal?.aborted
					? "spawn cancelled while waiting for the peer to start"
					: `the peer did not come up: its pane vanished, or never labelled the session within ${SPAWN_BOOT_TIMEOUT_MS}ms`;
				deletePeerRecord(sid);
				await killPane(pi, launched.pane);
				return fail("boot_failed", `${why} — pane=${launched.pane} (closed)`);
			}
			const message = `peer launched: ${name} | sessionId=${sid} | context=${mode} | pane=${launched.pane} — the peer is up and the task was delivered as its first message; use peer_send_mail for follow-up letters`;
			return {
				content: [{ type: "text" as const, text: message }],
				details: { ok: true, name, sessionId: sid, pane: launched.pane, contextMode: mode, message },
			};
		},
	});

	pi.registerTool({
		name: "peer_list",
		label: "List sessions",
		description:
			"List pi sessions, alive or exited. " + SKILL_GATE + " The first line summarises the total count and the current page (40 sessions per page, newest first; pass page for older ones). Then one line per session: name | creator (`created by sessionId: <id>` for a spawned peer, `created by user manually` for a human-started one) | alive | not alive | absolute cwd | YYYY-MM-DD HH:MM | sessionId. parent:'self' filters to peers spawned by this session. To read a session's transcript, resolve its file by sessionId: `find <agentDir>/sessions -name '*_<sessionId>.jsonl'`.",
		parameters: Type.Object({
			parent: Type.Optional(
				Type.String({ description: 'Creator sessionId (exact lowercase 36-character UUID), or "self" for this session; peers only' }),
			),
			alive: Type.Optional(Type.Boolean({ description: "true = only alive, false = only not alive" })),
			page: Type.Optional(
				Type.Number({ description: `1-based page number, ${LIST_PAGE_SIZE} sessions per page (default: 1)` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const tmuxProblem = await tmuxGuard(pi);
			if (tmuxProblem) return errResult("no_tmux", tmuxProblem, { total: 0 });
			const self = ctx.sessionManager.getSessionId();
			let recs = await scanAllSessions(pi);
			if (params.parent) {
				const creator = params.parent === "self" ? self : params.parent.trim();
				if (!UUID_RE.test(creator)) {
					return errResult(
						"bad_parent",
						`"${params.parent}" is not a sessionId. Pass "self" or the exact lowercase 36-character UUID as peer_list prints it.`,
						{ total: 0 },
					);
				}
				recs = recs.filter((r) => r.peer?.creatorSessionId === creator);
			}
			if (params.alive !== undefined) recs = recs.filter((r) => r.alive === params.alive);

			const total = recs.length;
			const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
			const page = params.page ?? 1;
			if (!Number.isInteger(page) || page < 1) {
				return errResult(
					"bad_page",
					`"${params.page}" is not a page number. Pass an integer >= 1 (there ${totalPages === 1 ? "is 1 page" : `are ${totalPages} pages`}).`,
					{ total, page: 0, totalPages },
				);
			}
			const start = (page - 1) * LIST_PAGE_SIZE;
			const lines = recs.slice(start, start + LIST_PAGE_SIZE).map((r) => {
				const by = r.peer ? `created by sessionId: ${r.peer.creatorSessionId}` : "created by user manually";
				return `${r.name ?? "—"} | ${by} | ${r.alive ? "alive" : "not alive"} | ${r.cwd} | ${fmtTime(r.startedAt)} | ${r.sessionId}`;
			});
			const shown = lines.length;
			const header = `total: ${total} matching session${total === 1 ? "" : "s"} | page ${page}/${totalPages}${shown > 0 ? ` | showing ${start + 1}-${start + shown}` : ""}`;
			const text = shown > 0 ? [header, ...lines].join("\n") : `${header}\n(no matching sessions on this page)`;
			return { content: [{ type: "text", text }], details: { total, page, totalPages } };
		},
	});

	pi.on("session_shutdown", async () => {
		stopLoop?.();
		stopLoop = null;
	});

	pi.registerTool({
		name: "peer_send_mail",
		label: "Send letter",
		description:
			`Deliver a letter to another session's mailbox (ANY pi session — peers and human-started). ${SKILL_GATE} The letter is stored as a .md file whose frontmatter header (from + summary) you write via the summary parameter. The recipient's poll injects ONLY the summary plus the file path — never the full text; the recipient reads the full letter from that path itself and deletes the file afterwards. Notices reach a running session within ~${POLL_MS / 1000}s — via steer while it is running, via followUp when it is idle — and multiple pending notices are merged into one message. A dead recipient is revived automatically, whether it was spawned as a peer or started by a human (this tool blocks up to ~${REVIVE_TIMEOUT_MS / 1000}s and reports whether the revive succeeded), and reads the notice at boot; if the revive fails the letter stays queued and is read when it next starts. The summary must be self-contained: state who you are (name/sessionId) and what the letter is about; the letter body should also say whether a reply is needed and where to send it.`,
		promptGuidelines: [
			"Batch peer_send_mail letters and keep them substantive: never send acknowledgements or small talk. Multiple pending notices are merged into one message, so one letter per topic is enough. Write a good summary — it is all the recipient sees before deciding to open the letter file.",
		],
		parameters: Type.Object({
			to: Type.String({
				description:
					"Recipient sessionId: the exact lowercase 36-character UUID as peer_list prints it. May target a session that is not on disk yet (e.g. a just-spawned peer). Prefixes, a different case and any other variant are rejected — an id is never normalised into a match.",
			}),
			summary: Type.String({
				description:
					"One-paragraph summary written into the letter's header and injected into the recipient (the full text is NOT injected): your identity (name/sessionId) + the letter's main content/ask. Keep it to one or two lines.",
			}),
			message: Type.String({ description: "Full letter text; stored in the letter file for the recipient to read" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const tmuxProblem = await tmuxGuard(pi);
			if (tmuxProblem) return errResult("no_tmux", tmuxProblem, { state: "no_tmux" });
			// A full id not on disk yet is fine — it may be a just-spawned peer still booting.
			const sid = params.to.trim();
			if (!UUID_RE.test(sid)) {
				return errResult(
					"bad_sessionId",
					`"${params.to}" is not a sessionId. Pass the exact lowercase 36-character UUID as peer_list prints it.`,
					{ state: "bad_sessionId" },
				);
			}
			const records = await scanAllSessions(pi);
			const target = findSessionById(records, sid);
			const self = ctx.sessionManager.getSessionId();
			const selfName = findSessionById(records, self)?.name;
			const from = selfName ? `${selfName} (sessionId: ${self})` : `sessionId: ${self}`;
			const letterFile = await post(sid, params.message, { from, summary: params.summary });
			const label = target?.name ?? sid;
			const done = (state: string, text: string) => ({
				content: [{ type: "text" as const, text: `${text} | letter file: ${letterFile}` }],
				details: { recipient: label, sessionId: sid, state, letterFile },
			});

			if (!target) {
				return done("queued_no_session", `sent → ${label} — no session on disk yet; the letter is queued and will be read when it starts`);
			}
			if (target.alive) {
				return done("alive", `sent → ${label} — alive; it picks the letter up within ~${POLL_MS / 1000}s`);
			}
			// Empty recorded cwd (old sessions) falls back to the sender's.
			const r = await revivePeer(pi, sid, target.cwd || ctx.cwd, signal);
			return r.ok
				? done("revived", `sent → ${label} — it was not alive and has now been revived (${r.message}); it reads the letter at boot`)
				: done(
						"revive_failed",
						`sent → ${label} — not alive and the revive FAILED (${r.message}); the letter is queued and will be read whenever it next starts`,
					);
		},
	});
}
