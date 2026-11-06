// Builds a student's report: replays their whole event history, re-verifies the hash
// chain, checks save checkpoints, compares against their submission, and raises flags.
import type { DB } from './db.ts';
import { genesis, hashEvent, sha256 } from './chain.ts';
// @ts-ignore: plain JS module shared with the browser
import { applyEvent, createState, summarize } from '../public/replay.js';

export interface Flag {
	level: 'info' | 'warn' | 'alert';
	code: string;
	message: string;
	file?: string;
	at?: number;
}

const BIG_PASTE = 80; // chars: a few lines of code
const LATE_DELIVERY_MS = 10 * 60_000;

/** A student lands in the review queue with any alert, or when most of their code wasn't written in Lineage. */
export const REVIEW_BELOW_PCT = 70;
const REVIEW_MIN_WRITTEN = 50;

function countSource(f: { text: string; attr: string[] } | undefined, source: string): number {
	if (!f) return 0;
	let n = 0;
	for (let i = 0; i < f.text.length; i++) if (f.attr[i] === source && !/\s/.test(f.text[i])) n++;
	return n;
}

export function buildReport(db: DB, assignmentId: string, studentId: string) {
	const enrollment = db.prepare('SELECT token FROM enrollments WHERE assignment_id = ? AND student_id = ?')
		.get(assignmentId, studentId) as { token: string } | undefined;
	if (!enrollment) return undefined;

	const sessions = db.prepare('SELECT id, first_seen FROM sessions WHERE token = ? ORDER BY first_seen')
		.all(enrollment.token) as { id: string; first_seen: number }[];

	const flags: Flag[] = [];
	const events: any[] = [];
	const state = createState();
	let chainOk = true;
	const agentRuns: { agent: string; name: string; scope: string; start: number; end: number; session: number }[] = [];
	const traces = new Map<string, any>(); // latest agent_trace per (name, where)

	sessions.forEach((session, sessionIndex) => {
		const rows = db.prepare('SELECT seq, server_t, json FROM events WHERE session_id = ? ORDER BY seq')
			.all(session.id) as { seq: number; server_t: number; json: string }[];
		let prev = genesis(session.id);
		let expectedSeq = 0;
		const open = new Map<string, (typeof agentRuns)[number]>();
		let lastT = 0;
		for (const row of rows) {
			const ev = JSON.parse(row.json);
			const { hash, ...body } = ev;
			if (hashEvent(body.prev, body) !== hash || body.seq !== row.seq) {
				chainOk = false;
				flags.push({ level: 'alert', code: 'chain_broken', message: `Hash chain broken in session ${sessionIndex + 1} at event ${row.seq}. The stored history was altered.` });
				break;
			}
			if (body.prev !== prev) {
				if (body.seq > expectedSeq) {
					// Events were removed before upload (e.g. the local spool was edited). The rest still verifies.
					chainOk = false;
					flags.push({ level: 'alert', code: 'gap', at: ev.t, message: `${body.seq - expectedSeq} recorded events from session ${sessionIndex + 1} never reached the server (deleted or lost before upload).` });
				} else {
					chainOk = false;
					flags.push({ level: 'alert', code: 'chain_broken', message: `Hash chain broken in session ${sessionIndex + 1} at event ${row.seq}. The stored history was altered.` });
					break;
				}
			}
			prev = hash;
			expectedSeq = body.seq + 1;
			lastT = ev.t;

			if (ev.kind === 'agent') {
				const key = `${ev.scope}:${ev.run ?? ev.pid}`;
				if (ev.state === 'start') open.set(key, { agent: ev.agent, name: ev.name, scope: ev.scope, start: ev.t, end: ev.t, session: sessionIndex + 1 });
				else if (open.has(key)) { const run = open.get(key)!; run.end = ev.t; agentRuns.push(run); open.delete(key); }
			}
			if (ev.kind === 'agent_trace') {
				const key = `${ev.name}:${ev.where}`;
				if (!traces.has(key) || traces.get(key).lastActive < ev.lastActive) traces.set(key, ev);
			}

			const firstSession = sessionIndex === 0;
			const tracked = ev.kind === 'external_write' ? 'external_write' : ev.kind === 'baseline' ? 'unobserved' : undefined;
			const before = tracked ? countSource(state.files.get(ev.file), tracked) : 0;
			applyEvent(state, ev, { firstSession });

			if (ev.kind === 'save') {
				const f = state.files.get(ev.file);
				if (f && sha256(f.text) !== ev.sha256) {
					flags.push({ level: 'warn', code: 'save_mismatch', file: ev.file, at: ev.t, message: `Replayed content of ${ev.file} didn't match the editor at save time; some edits weren't captured.` });
				}
			}
			if (ev.kind === 'paste_external' && (ev.text?.length ?? 0) >= BIG_PASTE) {
				flags.push({ level: 'warn', code: 'big_paste', file: ev.file, at: ev.t, message: `Pasted ${ev.text.length} characters from outside the editor into ${ev.file}.` });
			}
			if (ev.kind === 'edit_other' && (ev.text?.length ?? 0) >= BIG_PASTE) {
				// Autocomplete/snippets are short. A big block here is usually a menu paste the keybinding didn't see.
				flags.push({ level: 'warn', code: 'big_editor_edit', file: ev.file, at: ev.t, message: `${ev.text.length} characters appeared in ${ev.file} in one edit without typing (possibly a right-click paste).` });
			}
			if (tracked) {
				// Only flag when the write actually added content (a new empty file is not interesting).
				const added = countSource(state.files.get(ev.file), tracked) - before;
				if (added > 0 && ev.kind === 'external_write') {
					flags.push({ level: 'alert', code: 'external_write', file: ev.file, at: ev.t, message: `${ev.file} was written by another program (+${added} chars).` });
				}
				if (added > 0 && ev.kind === 'baseline') {
					flags.push({ level: 'warn', code: 'unobserved', file: ev.file, at: ev.t, message: `${added} characters in ${ev.file} changed while Lineage wasn't running.` });
				}
			}
			if (ev.kind === 'programmatic') {
				flags.push({ level: 'warn', code: 'programmatic', file: ev.file, at: ev.t, message: `${ev.file} was edited inside the editor with no user input nearby (${ev.text?.length ?? 0} chars).` });
			}
			if (row.server_t - ev.t > LATE_DELIVERY_MS) ev.late = true;

			events.push({ ...ev, firstSession, serverT: row.server_t, session: sessionIndex + 1 });
		}
		// Agent still running when the session ended: count it until the last recorded event.
		for (const run of open.values()) { run.end = Math.max(run.start, lastT); agentRuns.push(run); }
	});

	const firstT = events[0]?.t ?? 0;
	for (const run of agentRuns) {
		const mins = Math.round((run.end - run.start) / 60_000);
		flags.push({ level: 'alert', code: 'agent_run', at: run.start, message: `${run.name} was run in Lineage's terminal (${mins < 1 ? 'under a minute' : `${mins} min`}).` });
	}
	for (const t of traces.values()) {
		const before = t.lastActive < firstT ? ' Last changed before Lineage started recording.' : '';
		flags.push(t.inRepo
			? { level: 'warn', code: 'agent_file', at: Math.max(t.lastActive, firstT), message: `The project contains ${t.where}, a ${t.name} file.${before}` }
			: { level: 'alert', code: 'agent_trace', at: Math.max(t.lastActive, firstT), message: `${t.name} has ${t.where} on this computer.${before}` });
	}

	const lateCount = events.filter((e) => e.late).length;
	if (lateCount) {
		flags.push({ level: 'info', code: 'late_delivery', message: `${lateCount} events reached the server more than 10 minutes after they were recorded (worked offline, or the clock was changed).` });
	}

	mergeRepeated(flags);

	// Compare against the latest submission, if any.
	const sub = db.prepare('SELECT server_t, files FROM submissions WHERE token = ? ORDER BY server_t DESC LIMIT 1')
		.get(enrollment.token) as { server_t: number; files: string } | undefined;
	let submitted: Record<string, string> | undefined;
	const mismatched: string[] = [];
	if (sub) {
		submitted = JSON.parse(sub.files) as Record<string, string>;
		for (const [path, hash] of Object.entries(submitted)) {
			const f = state.files.get(path);
			if (!f || sha256(f.text) !== hash) {
				mismatched.push(path);
				flags.push({ level: 'alert', code: 'submission_mismatch', file: path, message: f ? `Submitted ${path} differs from what was recorded.` : `Submitted ${path} was never recorded.` });
			}
		}
	}

	const scope = submitted ? new Set(Object.keys(submitted).filter((p) => !mismatched.includes(p))) : undefined;
	const summary = summarize(state, scope);
	const alerts = flags.filter((f) => f.level === 'alert').length;

	return {
		assignmentId,
		studentId,
		sessions: sessions.length,
		activeMinutes: activeTime(events),
		chainOk,
		submittedAt: sub?.server_t,
		submittedFiles: submitted ? Object.keys(submitted) : null,
		mismatched,
		summary,
		needsReview: alerts > 0 || (summary.written >= REVIEW_MIN_WRITTEN && summary.authoredPct < REVIEW_BELOW_PCT),
		flags,
		agentRuns,
		events,
	};
}

/** Collapse many identical flag codes on one file into one line so the list stays readable. */
function mergeRepeated(flags: Flag[]) {
	const seen = new Map<string, { flag: Flag; n: number }>();
	const out: Flag[] = [];
	for (const f of flags) {
		if (f.code !== 'programmatic') { out.push(f); continue; }
		const key = f.code + ':' + f.file;
		const hit = seen.get(key);
		if (hit) { hit.n++; continue; }
		const entry = { flag: { ...f }, n: 1 };
		seen.set(key, entry);
		out.push(entry.flag);
	}
	for (const { flag, n } of seen.values()) if (n > 1) flag.message = `${flag.file} was edited inside the editor with no user input nearby (${n} times).`;
	flags.splice(0, flags.length, ...out);
}

/** Minutes with at least one content event, counting gaps under 5 minutes as active. */
function activeTime(events: any[]): number {
	let ms = 0;
	let last: number | undefined;
	for (const ev of events) {
		if (!['typed', 'delete', 'paste_internal', 'paste_external', 'edit_other', 'undo_redo'].includes(ev.kind)) continue;
		if (last !== undefined && ev.t - last < 5 * 60_000 && ev.t > last) ms += ev.t - last;
		last = ev.t;
	}
	return Math.round(ms / 60_000);
}
