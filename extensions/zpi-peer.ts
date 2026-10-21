import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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
const LIST_PAGE_SIZE = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface PeerRecord {
	/** Absolute role-file path — a record exists only for sessions WITH a role. */
	appendPrompt: string;
}

interface SessionRecord {
	sessionId: string;
	name: string | null;
	cwd: string;
	startedAt: number;
	peer?: PeerRecord;
	/** Sessions it spawned or exchanged letters with (both directions); ghost ids filtered out. */
	contactIds: string[];
}

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

/** Resolved tmux binary, cached for the process lifetime. On macOS, Homebrew's tmux
 *  (/opt/homebrew/bin, /usr/local/bin) is routinely missing from the PATH a GUI-launched
 *  process inherits, so the resolver falls back to those locations. */
let tmuxBin: string | null = null;
let tmuxResolved = false;
const TMUX_FALLBACKS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];

function tmuxNotFoundMessage(): string {
	const mac = process.platform === "darwin";
	return `tmux was not found${mac ? " on PATH or in the usual Homebrew locations (/opt/homebrew/bin, /usr/local/bin)" : " on PATH"}.
${mac ? "Install it with `brew install tmux`, then restart this pi inside tmux." : "Install tmux, then restart this pi inside tmux."}
peer_spawn / peer_list / peer_send_mail cannot work without tmux.`;
}

async function tmux(pi: ExtensionAPI): Promise<string | null> {
	if (tmuxResolved) return tmuxBin;
	tmuxResolved = true;
	try {
		if ((await pi.exec("tmux", ["-V"], {})).code === 0) {
			tmuxBin = "tmux";
			return tmuxBin;
		}
	} catch {}
	if (process.platform === "darwin") {
		for (const p of TMUX_FALLBACKS) {
			try {
				fs.accessSync(p, fs.constants.X_OK);
				tmuxBin = p;
				return tmuxBin;
			} catch {}
		}
	}
	return null;
}

/** Every tmux call goes through here so the resolved binary is used consistently —
 *  a fallback path found by the resolver must not break later calls that still said "tmux". */
async function tx(pi: ExtensionAPI, args: string[], opts?: Record<string, unknown>) {
	const bin = await tmux(pi);
	if (!bin) throw new Error(tmuxNotFoundMessage());
	return pi.exec(bin, args, opts ?? {});
}

/** First gate of the tools that touch tmux (spawn / send_mail): this pi must run inside tmux. A throw reads as "server down". */
async function tmuxGuard(pi: ExtensionAPI): Promise<string | null> {
	if (process.env.TMUX) return null;
	if (!(await tmux(pi))) return tmuxNotFoundMessage();
	let serverUp = false;
	try {
		serverUp = (await tx(pi, ["list-sessions"])).code === 0;
	} catch {}
	return serverUp ? NOT_IN_TMUX_SERVER_UP : NOT_IN_TMUX_SERVER_DOWN;
}

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** pi + optional first user message. Works under node, bun and the compiled binary; PI_PEER_CMD,
 *  when set, overrides the launcher (a deployment pin). Nothing holds the pane open, so a
 *  peer's window closes with its pi. */
function buildCommand(opts: { args: string[]; firstMessage?: string }): string {
	const script = process.argv[1];
	const launcher =
		script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)
			? [process.execPath, script]
			: /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
				? ["pi"]
				: [process.env.PI_PEER_CMD || process.execPath];
	const msg = opts.firstMessage;
	const positional = msg === undefined || msg === "" ? "" : ` -- ${shq(/^[-@]/.test(msg) ? ` ${msg}` : msg)}`;
	return `${[...launcher, ...opts.args].map(shq).join(" ")}${positional}`;
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
		const r = await tx(pi, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, cmdStr], { signal });
		if (r.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim() || `tmux exited ${r.code}` };
		return { ok: true, pane: r.stdout.trim().split("\n").pop() ?? "" };
	} catch (e: any) {
		return { ok: false, message: `tmux could not be run: ${String(e?.message ?? e)}` };
	}
}

/** Best-effort pane kill: never throws, ignores abort. */
async function killPane(pi: ExtensionAPI, pane: string): Promise<void> {
	try {
		await tx(pi, ["kill-pane", "-t", pane]); // no signal: cleanup must run even when aborted
	} catch {}
}

// A pane's @pi_sid is written by the TUI pi that owns it and dies with it — no TTL needed.

/** pane_id -> @pi_sid of every live pane. THROWS when tmux is unreachable — never silently "nothing is alive". */
async function paneLabels(pi: ExtensionAPI): Promise<Map<string, string>> {
	const r = await tx(pi, ["list-panes", "-a", "-F", "#{pane_id}|#{@pi_sid}|#{pane_dead}"]);
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
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

const registryDir = () => path.join(getAgentDir(), "peer", "registry");

const peerRolesDir = () => path.join(getAgentDir(), "peer");
const BUNDLED_ROLES = ["AGENTS.investigator.md", "AGENTS.strategist.md", "AGENTS.auditor.md"];
const RETIRED_ROLES = ["AGENTS.scout.md", "AGENTS.researcher.md", "AGENTS.critic.md"];

/** Mirror the bundled role files (which sit next to the extension's parent directory) directly
 * into <agentDir>/peer. An edited or older copy is kept as `<name>.backup` before the bundled
 * version is written, so every start reconciles the roles — each role independently: a missing
 * source file skips only that role. Retired role files are moved aside the same way — a stale
 * role must not linger as a usable role. */
function syncRoles(): void {
	try {
		const dir = peerRolesDir();
		fs.mkdirSync(dir, { recursive: true });
		for (const name of RETIRED_ROLES) {
			const stale = path.join(dir, name);
			if (fs.existsSync(stale)) fs.renameSync(stale, `${stale}.backup`);
		}
		for (const name of BUNDLED_ROLES) {
			try {
				const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", name);
				const dst = path.join(dir, name);
				const bundled = fs.readFileSync(src);
				if (fs.existsSync(dst)) {
					if (fs.readFileSync(dst).equals(bundled)) continue;
					fs.renameSync(dst, `${dst}.backup`);
				}
				fs.copyFileSync(src, dst);
			} catch {} // one role's missing file must not block the other two
		}
	} catch {}
}

/** Expand a leading ~/ — fs.* and pi's prompt resolution do not. */
function expandPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

// Peer role identity lives ONLY here, never in session files — a fork cannot pollute it by
// file copying, and no scan can miss it. A record exists only for sessions WITH a role;
// plain peers carry no role.json at all.
const sessionDir = (sid: string) => path.join(registryDir(), sid);
const roleFile = (sid: string) => path.join(sessionDir(sid), "role.json");

function writePeerRecord(sid: string, rec: PeerRecord): void {
	fs.mkdirSync(sessionDir(sid), { recursive: true });
	const tmp = `${roleFile(sid)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ appendPrompt: expandPath(rec.appendPrompt) }));
	fs.renameSync(tmp, roleFile(sid)); // tmp+rename: readers never see a half-written record
}

// Role records are write-once (the role path never changes), so this cache (negatives included) never goes stale.
const recordCache = new Map<string, PeerRecord | null>();

function readPeerRecord(sid: string): PeerRecord | null {
	const hit = recordCache.get(sid);
	if (hit !== undefined) return hit;
	let rec: PeerRecord | null = null;
	try {
		const raw = JSON.parse(fs.readFileSync(roleFile(sid), "utf-8"));
		if (raw && typeof raw.appendPrompt === "string") rec = { appendPrompt: raw.appendPrompt };
	} catch {}
	recordCache.set(sid, rec);
	return rec;
}

const contactsFile = (sid: string) => path.join(sessionDir(sid), "contacts.txt");

/** Append-only contact log: one sessionId per line, both directions written by whoever acts
 *  (spawn or letter). A single short O_APPEND write is atomic under the kernel's inode lock, so
 *  concurrent writers never overwrite each other — there is no read-modify-write to race. A
 *  crash mid-write leaves at most a partial line, which readContacts drops via the UUID check;
 *  duplicates are harmless because reads dedupe. */
function addContact(a: string, b: string): void {
	try {
		fs.mkdirSync(sessionDir(a), { recursive: true });
		fs.mkdirSync(sessionDir(b), { recursive: true });
		fs.appendFileSync(contactsFile(a), `${b}\n`);
		fs.appendFileSync(contactsFile(b), `${a}\n`);
	} catch {} // best effort: a lost line only narrows a future peer_list filter
}

function readContacts(sid: string): string[] {
	let raw: string;
	try {
		raw = fs.readFileSync(contactsFile(sid), "utf-8");
	} catch {
		return [];
	}
	return [...new Set(raw.split("\n").filter((l) => UUID_RE.test(l)))];
}

// Removes the whole session folder: spawn-failure paths call this before any contact exists,
// so the folder holds at most role.json — a sid that never booted never lingers.
function deletePeerRecord(sid: string): void {
	try {
		fs.rmSync(sessionDir(sid), { recursive: true, force: true });
	} catch {}
	recordCache.delete(sid);
}

/** Sessions on disk joined with the registry — a pure disk read, no tmux. pi's listAll() parser
 *  lets the LAST session_info win, naming a fork after itself, not its parent. Liveness is
 *  deliberately absent: a pane-level fact, queried per sid only where it matters (send_mail). */
async function scanAllSessions(pi: ExtensionAPI): Promise<SessionRecord[]> {
	const infos = await SessionManager.listAll();
	const records: SessionRecord[] = infos.map((info) => {
		const started = info.created.getTime();
		return {
			sessionId: info.id,
			name: info.name ?? null,
			cwd: info.cwd,
			startedAt: Number.isNaN(started) ? info.modified.getTime() : started,
			contactIds: [],
		};
	});
	const known = new Set(records.map((r) => r.sessionId));
	for (const r of records) {
		const rec = readPeerRecord(r.sessionId);
		if (rec) r.peer = rec;
		r.contactIds = readContacts(r.sessionId).filter((id) => known.has(id));
	}
	records.sort((a, b) => b.startedAt - a.startedAt);
	return records;
}

// Exact match only: ids are time-ordered UUIDs, so a prefix match is ambiguous.
function findSessionById(records: SessionRecord[], sessionId: string): SessionRecord | undefined {
	return records.find((r) => r.sessionId === sessionId);
}

/** This session's file, located the way the tools tell models to: the <timestamp>_<sid>.jsonl file somewhere under <agentDir>/sessions/. */
function findSessionFile(sid: string): string | null {
	const root = path.join(getAgentDir(), "sessions");
	try {
		for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			for (const f of fs.readdirSync(path.join(root, dir.name))) {
				if (f.endsWith(`_${sid}.jsonl`)) return path.join(root, dir.name, f);
			}
		}
	} catch {}
	return null;
}

/** The name as every external reader sees it: the LAST session_info entry of the session file.
 *  The file is the single source of truth — pi's in-memory copy is deliberately never consulted. */
function readNameFromFile(sid: string): { name: string | null; file: string | null } {
	const file = findSessionFile(sid);
	if (!file) return { name: null, file: null };
	let name: string | null = null;
	try {
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session_info") name = typeof entry.name === "string" ? entry.name : null;
			} catch {} // a torn trailing line is not a rename; the only writer of the file is pi itself
		}
	} catch {
		return { name: null, file };
	}
	return { name, file };
}

/** Uniform failed-tool result: "<code>: <detail>" text plus structured { code, message, …extra }. */
function errResult(code: string, detail: string, extra?: Record<string, unknown>) {
	const message = `${code}: ${detail}`;
	return {
		content: [{ type: "text" as const, text: message }],
		details: { code, message, ...extra },
		isError: true,
	};
}

// Letters: <agentDir>/peer/letters/<recipientSid>/pending-<hex>.md — one file per letter,
// no lock, no ordering. The recipient's poll injects only the summary + file path (merged into
// one message) and delivers by REMOVING the pending- prefix after issuing the notice — a
// one-way valve: the prefix is only ever removed, never re-added; a new letter carries a
// fresh name. pending- is the retry state: a letter still carrying it is re-considered on
// every poll. The notice announces the prefix-less final path, which exists before any
// consumer can look (the strip is the synchronous statement right after the send call — no
// consumer sees the notice before this tick yields). The recipient reads and deletes the file
// itself.

const boxDir = (sid: string) => path.join(getAgentDir(), "peer", "letters", sid);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function formatNotice(file: string, text: string): string {
	// frontmatter (from + summary) as written by post()
	const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const pick = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(header)?.[1]?.trim() || null;
	return [
		`New letter received.`,
		`From: ${pick("from") ?? "unknown sender"}`,
		`Summary: ${pick("summary") ?? "(no summary header)"}`,
		`Full letter file: "${file}" — read it yourself with the read tool, delete the letter file (rm) after reading so letters won't pile up.`,
	].join("\n");
}

/** Unique names mean writers never coordinate; tmp+rename means readers never see a half-write. */
async function post(sid: string, message: string, header: { from: string; summary: string }): Promise<string> {
	const dir = boxDir(sid);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${PENDING}${randomBytes(8).toString("hex")}.md`);
	const text = `---\nfrom: ${oneLine(header.from)}\nsummary: ${oneLine(header.summary)}\n---\n\n${message}\n`;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
	return file;
}

const PENDING = "pending-"; // filename prefix: not yet announced; removed once, never re-added

/** Order means nothing — one tick delivers them all merged. */
function pendingLetters(dir: string): string[] {
	try {
		return fs.readdirSync(dir)
			.filter((n) => n.startsWith(PENDING) && n.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

// Compaction state, tracked from session events. pi rejects every prompt submission
// while compaction runs ("Cannot submit a prompt while compaction is in progress"), and
// pi.sendUserMessage's binding swallows that rejection (fire-and-forget; the failure is
// only reported as a runtime extension error), so the extension cannot learn a send
// failed — it must simply not send during the window.
let compactionActive = false;

/** Announce waiting letters merged — steer while running or starting (pi 1.2.0 counts the
 * session busy from run start, so a letter landing there queues into the starting run
 * instead of racing it), followUp when idle. While compaction runs the tick does nothing:
 * pi rejects prompt submission then, the rejection is not observable through
 * pi.sendUserMessage, and letters stay pending — the prefix IS the retry state — for the
 * first tick after it ends.
 *
 * Delivery is one-way on the pending- prefix: it is stripped only AFTER the notice has been
 * issued, and never re-added. If the send call itself throws, the strip loop never runs and
 * the letters retry. Residual windows: a send that fails silently (the rejection is swallowed
 * by pi's binding) inside the check-to-send gap leaves an un-announced, un-pended letter —
 * an at-most-once loss, the only such window left; a crash after an effective send leaves the
 * prefix on, so the letter is re-announced — a benign duplicate instead of a loss. */
function startInboxLoop(pi: ExtensionAPI, sid: string, isIdle: () => boolean): () => void {
	const dir = boxDir(sid);
	let stopped = false;

	const tick = () => {
		if (stopped || compactionActive) return;
		try {
			const batch: Array<{ pendingPath: string; finalPath: string; text: string }> = [];
			for (const name of pendingLetters(dir)) {
				let text: string;
				try {
					text = fs.readFileSync(path.join(dir, name), "utf-8");
				} catch {
					continue; // unreadable right now: retry on a later tick
				}
				batch.push({
					pendingPath: path.join(dir, name),
					finalPath: path.join(dir, name.slice(PENDING.length)),
					text,
				});
			}
			if (batch.length === 0) return;
			pi.sendUserMessage(
					batch.map((b) => formatNotice(b.finalPath, b.text)).join("\n\n──────── next letter ────────\n\n"),
					{ deliverAs: isIdle() ? "followUp" : "steer" },
			);
			// Strip the pending- prefix — the one-way "notice issued" transition. Reached
			// only if the send call did not throw; no consumer can observe the notice before
			// this synchronous rename, so the announced (prefix-less) path already exists
			// when anyone looks.
			for (const b of batch) {
				try {
					fs.renameSync(b.pendingPath, b.finalPath);
				} catch {} // vanished underneath us: nothing to deliver
			}
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
	syncRoles();
	const roleDir = peerRolesDir();
	const ROLE_HINT = `Standard roles live in ${roleDir}: AGENTS.investigator.md (find out what is true, in the codebase or outside it), AGENTS.strategist.md (make the call: options, trade-offs, a committed recommendation and what would flip it), AGENTS.auditor.md (verify by reproducing, audit the path taken, then criticize — pours cold water on warm consensus).`;

	// On a revive the role must be resolved before any pending letter can start a turn —
	// session_start does both, in that order.

	// Role file of the current session, null for plain sessions; records store absolute paths.
	let roleSid: string | null = null;
	let appendPromptPath: string | null = null;
	const loadOwnRole = (sid: string) => {
		roleSid = sid;
		appendPromptPath = readPeerRecord(sid)?.appendPrompt ?? null;
	};

	// A fork keeps the branched session's role; an existing record (the spawner's write) is never overwritten.
	const inheritRoleFromFork = (event: { reason?: string; previousSessionFile?: string }, ownSid: string) => {
		if (event.reason !== "fork" || !event.previousSessionFile) return;
		const file = path.basename(event.previousSessionFile);
		const srcSid = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length).split("_").pop() : undefined;
		if (!srcSid || fs.existsSync(roleFile(ownSid))) return;
		const src = readPeerRecord(srcSid);
		if (!src) return;
		writePeerRecord(ownSid, { appendPrompt: src.appendPrompt }); // role only — contacts are never inherited
		recordCache.delete(ownSid); // a lookup may already have cached "no record" for this sid
	};

	let stopLoop: (() => void) | null = null;

	pi.on("session_start", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		inheritRoleFromFork(event, sid);
		loadOwnRole(sid);
		compactionActive = false;
		// Only a TUI owns a pane: a nested print/json pi inherits $TMUX_PANE and would steal it.
		// Best effort — without the label this session reads as dead.
		if (ctx.mode === "tui" && process.env.TMUX_PANE) {
			try {
				await tx(pi, ["set-option", "-p", "-t", process.env.TMUX_PANE, "@pi_sid", sid]);
			} catch {}
		}
		stopLoop?.();
		stopLoop = startInboxLoop(pi, sid, () => ctx.isIdle());
	});

	// Track the compaction window so the inbox tick can wait it out (see startInboxLoop):
	// session_compact_failed fires on failure AND abort — including an extension cancelling
	// in session_before_compact — so the flag always has a reset path.
	pi.on("session_before_compact", async () => {
		compactionActive = true;
	});
	const compactionOver = async () => {
		compactionActive = false;
	};
	pi.on("session_compact", compactionOver);
	pi.on("session_compact_failed", compactionOver);

	// pi persists no system prompt (--append-system-prompt vanishes on resume), so the role is
	// re-applied EVERY turn from the file the registry points at. Identity follows the SESSION,
	// not the process: /new inside a peer's pane runs plain; a fork inherits the branched
	// session's role. Idempotent: skips when already present.
	// pi 1.2.0: the event is a union on event.messageType — "user" runs (prompts,
	// sendUserMessage) carry prompt/images, "custom" runs (sendMessage with triggerTurn)
	// carry the starting message. The role deliberately applies to BOTH kinds: any turn the
	// peer runs carries its stance. The forced system prompt now also survives the run's
	// tool calls (1.2.0 fix), so the prompt cache no longer breaks mid-run over the role.
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
			`Spawn an equal pi peer in a tmux pane with a pre-assigned sessionId. ${SKILL_GATE} It returns only once the peer is verifiably up — it blocks up to ~${SPAWN_BOOT_TIMEOUT_MS / 1000}s until the peer labels the pane it was given, and reports a failure instead of handing back a sid that never booted. The returned sid becomes disk-durable a few seconds after return, when the peer submits its first message (pi persists the session file then, not at boot); a peer killed before that leaves no session — its sid goes dark (mail to it is rejected as unknown_session, resume reports not found). The task is delivered at launch as the peer's first user message. Use peer_send_mail for follow-up letters. prompt: path to a role file that stays with the peer across every start — ${ROLE_HINT} Pass a role whenever one fits the mission — it is the main way to shape a peer's stance. The peer-orchestrator skill describes what each role does; any other file path works for a custom role. context: omit = empty | fork:<sessionId> = fork that session's full history, and the forked peer also inherits its role unless prompt overrides it | handoff:<text> = custom context text (prepended to the first message).`,
		promptGuidelines: [
			"Use peer_spawn only when the user asked for parallel/independent work or a task clearly warrants a separate context; every letter sent via peer_send_mail costs the recipient one LLM turn.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Session name seed; the peer is named '[peer]<name>'" }),
			task: Type.String({ description: "Self-contained first message; delivered at launch as the peer's first user message" }),
			prompt: Type.Optional(
				Type.String({
					description:
						"Path to a role-prompt file (errors if it does not exist). The role stays with the peer across every start — spawn, mail revive, or a user-run /resume — and the file is re-read per turn, so editing it takes effect without respawning. Identity follows the session: /new inside a peer's pane starts a plain session, while a fork inherits the role of the session it branched from unless this overrides it. ${ROLE_HINT} Omit only when no role fits — a plain peer has no role discipline. Any other file path works for a custom role.",
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
			const name = `[peer]${params.name}`;

			let mode = "empty";
			let forkSid: string | undefined;
			let inheritedRole: string | undefined;
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
					inheritedRole = source.peer?.appendPrompt;
				} else if (kind === "handoff") {
					mode = "handoff";
					payload = rest;
				} else {
					return fail("bad_context", `cannot parse context "${params.context}"; supported: fork:<sessionId> | handoff:<text> | omit for empty`);
				}
			}

			let role: string | undefined;
			if (params.prompt) {
				role = expandPath(params.prompt);
				if (!fs.existsSync(role)) return fail("prompt_file_missing", `prompt file not found: ${params.prompt}`);
			}
			if (!role) role = inheritedRole;
			if (role) writePeerRecord(sid, { appendPrompt: role });

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

			if (!(await waitForBoot(pi, sid, launched.pane, signal))) {
				const why = signal?.aborted
					? "spawn cancelled while waiting for the peer to start"
					: `the peer did not come up: its pane vanished, or never labelled the session within ${SPAWN_BOOT_TIMEOUT_MS}ms`;
				deletePeerRecord(sid);
				await killPane(pi, launched.pane);
				return fail("boot_failed", `${why} — pane=${launched.pane} (closed)`);
			}
			addContact(ctx.sessionManager.getSessionId(), sid); // a spawn counts as contact
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
			"List pi sessions. " + SKILL_GATE + " The first line summarises the total count and the current page (15 sessions per page, newest first; pass page for older ones). Then one line per session: name | contacts (how many sessions it has spawned or exchanged letters with, either direction) | absolute cwd | YYYY-MM-DD HH:MM | sessionId. contact filters to the sessions that have communicated with one session — pass \"self\" or any exact lowercase 36-character sessionId; a spawn and an exchanged letter both count. To read a session's transcript, resolve its file by sessionId: `find <agentDir>/sessions -name '*_<sessionId>.jsonl'`.",
		parameters: Type.Object({
			contact: Type.Optional(
				Type.String({
					description:
						'Filter to sessions that have communicated with one session: "self" for this session, or the exact lowercase 36-character UUID of any session. A spawn or an exchanged letter counts, in either direction.',
				}),
			),
			page: Type.Optional(
				Type.Number({ description: `1-based page number, ${LIST_PAGE_SIZE} sessions per page (default: 1)` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const self = ctx.sessionManager.getSessionId();
			let recs = await scanAllSessions(pi);
			if (params.contact) {
				const target = params.contact === "self" ? self : params.contact.trim();
				if (!UUID_RE.test(target)) {
					return errResult(
						"bad_contact",
						`"${params.contact}" is not a sessionId. Pass "self" or the exact lowercase 36-character UUID as peer_list prints it.`,
						{ total: 0 },
					);
				}
				const ids = new Set(readContacts(target));
				recs = recs.filter((r) => ids.has(r.sessionId));
			}

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
				const time = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 16);
				return `${r.name ?? "—"} | contacts: ${r.contactIds.length || "none"} | ${r.cwd} | ${time} | ${r.sessionId}`;
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
			`Deliver a letter to another session's mailbox (ANY pi session — peers and human-started). ${SKILL_GATE} The recipient must already exist on disk: an id with no session file is rejected with an error and nothing is written or sent (a just-spawned peer becomes addressable a few seconds after peer_spawn returns, once it persists its session file). The letter is stored as a .md file whose frontmatter header (from + summary) you write via the summary parameter. The recipient's poll injects ONLY the summary plus the file path — never the full text; the recipient reads the full letter from that path itself and deletes the file afterwards. Notices reach a running session within ~${POLL_MS / 1000}s — via steer while it is running, via followUp when it is idle — and multiple pending notices are merged into one message. A dead recipient is revived automatically, whether it was spawned as a peer or started by a human (this tool blocks up to ~${REVIVE_TIMEOUT_MS / 1000}s and reports whether the revive succeeded), and reads the notice at boot; if the revive fails the letter stays queued and is read when it next starts. The summary must be self-contained: state who you are (name/sessionId) and what the letter is about; the letter body should also say whether a reply is needed and where to send it.`,
		promptGuidelines: [
			"Batch peer_send_mail letters and keep them substantive: never send acknowledgements or small talk. Multiple pending notices are merged into one message, so one letter per topic is enough. Write a good summary — it is all the recipient sees before deciding to open the letter file.",
		],
		parameters: Type.Object({
			to: Type.String({
				description:
					"Recipient sessionId: the exact lowercase 36-character UUID as peer_list prints it. The session must already exist on disk — an id with no session file is rejected and nothing is sent. Prefixes, a different case and any other variant are rejected — an id is never normalised into a match.",
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
			// The letter is composed but not yet on disk: a recipient that exists nowhere on disk is a typo (or a
			// peer that never booted), so refuse it before writing anything — an unreadable letter in a dead
			// mailbox is invisible to both sides.
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
			if (!target) {
				return errResult(
					"unknown_session",
					`no session with id ${sid} exists on disk; nothing was sent. Pass the exact sessionId of an existing session (peer_list shows them).`,
					{ state: "unknown_session", sessionId: sid },
				);
			}
			const self = ctx.sessionManager.getSessionId();
			const selfName = findSessionById(records, self)?.name;
			const from = selfName ? `${selfName} (sessionId: ${self})` : `sessionId: ${self}`;
			const letterFile = await post(sid, params.message, { from, summary: params.summary });
			addContact(self, sid); // an exchanged letter counts as contact
			const label = target.name ?? sid;
			const done = (state: string, text: string) => ({
				content: [{ type: "text" as const, text: `${text} | letter file: ${letterFile}` }],
				details: { recipient: label, sessionId: sid, state, letterFile },
			});

			// paneLabels throws if tmux died mid-call (we are behind tmuxGuard) — an honest error
			// beats a false "not alive" that would push a live peer down the revive path.
			if ([...(await paneLabels(pi)).values()].includes(sid)) {
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

	// Self-only by design: a rename of ANOTHER session is a request, not a write — it goes through a
	// letter (peer_send_mail), so the recipient also learns WHY its name changed. The read path is
	// the file tail on purpose: it is the same value every external reader (peer_list) sees.
	pi.registerTool({
		name: "peer_name",
		label: "Read or set own session name",
		description:
			"Read or set THIS session's name — a peer's identity carrier: it declares what this session does, what it is responsible for, and its current state; peer_list shows it first, and it is often the only thing a reader sees before deciding to mail, fork, or skip. " + SKILL_GATE + " Omit name to read the current name exactly as it exists on disk — the last session_info entry of this session's file, the same value every external reader sees; a session with no name entry reads as unnamed. Pass name to set it — effective immediately for this process and on disk. This tool never touches another session: to change another session's name (dead or alive — peer_send_mail revives a dead recipient), send a letter stating the reason and the new name; the recipient renames itself.",
		promptGuidelines: [
			"A name change is almost always a state change: update your own name with peer_name in the same run that changes your state (retirement, redirection, reassignment) — never rename another session, ask it by letter.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description: "New name for this session — function, responsibility, and state. Omit to read the current name.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sid = ctx.sessionManager.getSessionId();
			if (params.name === undefined) {
				const { name, file } = readNameFromFile(sid);
				const text = name
					? `this session's name: ${name}`
					: file
						? "this session has no name on disk yet — set one with peer_name (function, responsibility, state)."
						: "this session's file is not on disk yet (pi persists it with this session's first submitted message); a name set now takes effect in this process and lands on disk with the file.";
				return { content: [{ type: "text" as const, text }], details: { name, sessionId: sid, file } };
			}
			const name = params.name.trim();
			if (!name) {
				return errResult(
					"bad_name",
					"a name cannot be empty or whitespace-only — pass a non-empty name, or omit it to read the current name.",
				);
			}
			pi.setSessionName(name);
			const message = `session renamed: ${name} — effective immediately for this process and on disk; peer_list and every file reader see it from now on`;
			return {
				content: [{ type: "text" as const, text: message }],
				details: { name, sessionId: sid, message },
			};
		},
	});
}
