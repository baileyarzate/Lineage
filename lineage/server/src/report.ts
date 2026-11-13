// Builds a student's report: replays their whole event history, re-verifies the hash
// chain, checks save checkpoints, compares against their submission, and raises flags.
import { loadStarter, starterHash, type DB } from './db.ts';
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
const PRE_JOIN_ALERT = 20; // non-whitespace chars: about one line of code written before joining
const LATE_DELIVERY_MS = 10 * 60_000;

/**
 * Flag codes from most to least telling, with the short label the review queue shows.
 * Flags are listed in this order so the strongest evidence is read first.
 */
export const FLAG_LABELS: Record<string, string> = {
	chain_broken: 'Recording altered',
	gap: 'Missing events',
	submission_mismatch: 'Submission differs',
	agent_run: 'AI agent ran',
	agent_trace: 'AI agent history',
	external_write: 'Written by another program',
	pre_join: 'Work before joining',
	big_paste: 'Uncited paste',
	unobserved: 'Changed while closed',
	programmatic: 'Edits with no input',
	big_editor_edit: 'Large untyped edit',
	save_mismatch: 'Edits not captured',
	agent_file: 'Agent file in project',
	cited_paste: 'Cited paste',
	late_delivery: 'Late delivery',
	no_starter: 'No starter code',
};
const FLAG_ORDER = Object.keys(FLAG_LABELS);
const LEVEL_ORDER = { alert: 0, warn: 1, info: 2 };

/** Short reasons a student needs a look, strongest first (alerts and warnings only). */
export function reviewReasons(flags: Flag[], lowPct: boolean): string[] {
	const out = [...new Set(flags.filter((f) => f.level !== 'info').map((f) => FLAG_LABELS[f.code] ?? f.code))];
	if (!out.length && lowPct) out.push('Mostly not written in Lineage');
	return out;
}

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
	const starter = loadStarter(db, assignmentId);
	if (!starter.version) {
		flags.push({ level: 'info', code: 'no_starter', message: 'No starter code was uploaded for this assignment, so work done before the student joined counts as starter code.' });
	}
	const state = createState();
	let chainOk = true;
	const agentRuns: { agent: string; name: string; scope: string; start: number; end: number; session: number }[] = [];
	const traces = new Map<string, any>(); // latest agent_trace per (name, where)
	const citations: { n: number; ref: string; source: any; file: string; at: number; chars: number; forPaste: boolean; session: number }[] = [];

	sessions.forEach((session, sessionIndex) => {
		const rows = (db.prepare('SELECT seq, server_t, json FROM events WHERE session_id = ? ORDER BY seq')
			.all(session.id) as { seq: number; server_t: number; json: string }[]).map((r) => ({ ...r, ev: JSON.parse(r.json) }));
		// Citations come after the paste they cite; index them so the paste can be labeled when it's replayed.
		const citeFor = new Map<number, any>();
		for (const { ev } of rows) if (ev.kind === 'cite' && Number.isInteger(ev.paste)) citeFor.set(ev.paste, ev);
		let prev = genesis(session.id);
		let expectedSeq = 0;
		const open = new Map<string, (typeof agentRuns)[number]>();
		let lastT = 0;
		for (const row of rows) {
			const ev = row.ev;
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
			if (ev.kind === 'paste_external' && citeFor.has(ev.seq)) {
				const c = citeFor.get(ev.seq); // set after the hash check above, so verification sees the original event
				ev.cite = c.n;
				ev.citeRef = c.ref;
			}
			if (ev.kind === 'cite') {
				citations.push({ n: ev.n, ref: String(ev.ref ?? ''), source: ev.source ?? {}, file: ev.file, at: ev.t, chars: ev.len ?? 0, forPaste: Number.isInteger(ev.paste), session: sessionIndex + 1 });
			}
			if (ev.kind === 'agent_trace') {
				const key = `${ev.name}:${ev.where}`;
				if (!traces.has(key) || traces.get(key).lastActive < ev.lastActive) traces.set(key, ev);
			}

			const firstSession = sessionIndex === 0;
			if (firstSession && ev.kind === 'baseline' && ev.initial && starter.version) {
				// Check the file against the instructor's starter code (any version).
				const candidates = starter.files.get(ev.file) ?? [];
				if (!candidates.some((c) => c.sha256 === starterHash(ev.text))) ev.starterBase = closest(candidates, ev.text)?.text ?? '';
			}
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
				flags.push(ev.cite
					? { level: 'info', code: 'cited_paste', file: ev.file, at: ev.t, message: `Pasted ${ev.text.length} characters from outside into ${ev.file}, cited as [${ev.cite}] ${sourceName(citeFor.get(ev.seq)?.source)}.` }
					: { level: 'warn', code: 'big_paste', file: ev.file, at: ev.t, message: `Pasted ${ev.text.length} characters from outside the editor into ${ev.file}. No source was given.` });
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
				if (added > 0 && ev.kind === 'baseline' && typeof ev.starterBase === 'string') {
					flags.push(ev.starterBase
						? { level: added >= PRE_JOIN_ALERT ? 'alert' : 'warn', code: 'pre_join', file: ev.file, at: ev.t, message: `When the student joined, ${ev.file} already had ${added} characters that aren't in the starter code (written before Lineage was recording).` }
						: { level: added >= PRE_JOIN_ALERT ? 'alert' : 'warn', code: 'pre_join', file: ev.file, at: ev.t, message: `${ev.file} isn't part of the starter code but already existed with ${added} characters when the student joined.` });
				} else if (added > 0 && ev.kind === 'baseline') {
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

	// Strongest evidence first: alerts before warnings before notes, then by kind, then in time order.
	const rank = (f: Flag) => [LEVEL_ORDER[f.level], FLAG_ORDER.indexOf(f.code) < 0 ? 99 : FLAG_ORDER.indexOf(f.code), f.at ?? 0];
	flags.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });

	const scope = submitted ? new Set(Object.keys(submitted).filter((p) => !mismatched.includes(p))) : undefined;
	const summary = summarize(state, scope);
	const alerts = flags.filter((f) => f.level === 'alert').length;
	const lowPct = summary.written >= REVIEW_MIN_WRITTEN && summary.accountedPct < REVIEW_BELOW_PCT;

	return {
		assignmentId,
		studentId,
		sessions: sessions.length,
		activeMinutes: activeTime(events),
		chainOk,
		starterVersion: starter.version,
		submittedAt: sub?.server_t,
		submittedFiles: submitted ? Object.keys(submitted) : null,
		mismatched,
		summary,
		// Cited pastes count as accounted for: a course that allows AI with citation shouldn't fill the queue with students who followed the rules.
		needsReview: alerts > 0 || lowPct,
		reasons: reviewReasons(flags, lowPct),
		flags,
		agentRuns,
		citations: dedupeCitations(citations),
		events,
	};
}

/** The starter version that shares the most text with `text` at its start and end. */
function closest(candidates: { text: string }[], text: string) {
	let best: { text: string } | undefined;
	let bestScore = -1;
	for (const c of candidates) {
		let a = 0;
		const max = Math.min(c.text.length, text.length);
		while (a < max && c.text[a] === text[a]) a++;
		let b = 0;
		while (b < max - a && c.text[c.text.length - 1 - b] === text[text.length - 1 - b]) b++;
		if (a + b > bestScore) { bestScore = a + b; best = c; }
	}
	return best;
}

/** "ChatGPT", "Stack Overflow: How do I…", "psf/requests on GitHub" */
function sourceName(src: any): string {
	if (!src) return '';
	if (src.kind === 'ai') return `(${src.title})`;
	if (src.kind === 'code' && src.author) return `(${src.author}/${src.title} on ${src.site ?? 'GitHub'})`;
	if (src.site) return `(${src.site}: ${src.title})`;
	return `(${src.title})`;
}

/** One entry per reference number, with every place it was used. */
function dedupeCitations(list: { n: number; ref: string; source: any; file: string; at: number; chars: number; forPaste: boolean; session: number }[]) {
	const byN = new Map<number, { n: number; ref: string; source: any; uses: { file: string; at: number; chars: number; forPaste: boolean; session: number }[] }>();
	for (const c of list) {
		const entry = byN.get(c.n) ?? { n: c.n, ref: c.ref, source: c.source, uses: [] };
		entry.uses.push({ file: c.file, at: c.at, chars: c.chars, forPaste: c.forPaste, session: c.session });
		byN.set(c.n, entry);
	}
	return [...byN.values()].sort((a, b) => a.n - b.n);
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
