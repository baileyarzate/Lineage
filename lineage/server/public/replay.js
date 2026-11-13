// Replay engine shared by the server (coverage reports) and the dashboard (visual replay).
// Plain ES module with no dependencies so it runs unchanged in Node and the browser.
//
// Every character in every file carries the source that put it there. Replaying a
// student's event stream rebuilds their files and, alongside, who/what wrote each char.

/** Where a character came from. Order is also the display order. */
export const SOURCES = [
	'typed', //           keystrokes in the editor
	'editor', //          editor-generated edits right after user input (autocomplete, format, undo/redo)
	'paste_internal', //  pasted text that was copied inside the editor
	'starter', //         present in the starter code when the student first joined
	'citation', //        citation comments and REFERENCES.md, added by Lineage when the student cites a source
	'paste_cited', //     pasted from outside, and the student said where it came from
	'paste_external', //  pasted text that came from outside the editor
	'external_write', //  written to disk by another program (agents, scripts, other editors)
	'programmatic', //    changed inside the editor with no user input nearby (e.g. another extension)
	'unobserved', //      changed while Lineage wasn't running
];

/** Sources that count as "written by the student inside Lineage". */
export const AUTHORED = new Set(['typed', 'editor', 'paste_internal']);

/** Sources that need a human look. */
export const UNATTRIBUTED = new Set(['paste_external', 'external_write', 'programmatic', 'unobserved']);

/** Outside code the student disclosed with a citation. Not written by them, but accounted for. */
export const DISCLOSED = new Set(['paste_cited']);

/** Not the student's work in either direction: left out of every percentage. */
export const EXCLUDED = new Set(['starter', 'citation']);

const EDIT_SOURCE = {
	typed: 'typed',
	undo_redo: 'editor',
	edit_other: 'editor',
	paste_internal: 'paste_internal',
	paste_external: 'paste_external',
	programmatic: 'programmatic',
	citation: 'citation',
	delete: 'typed', // deletes insert nothing; source is irrelevant
};

/** @returns {{files: Map<string, {text: string, attr: string[]}>}} */
export function createState() {
	return { files: new Map() };
}

/**
 * Apply one recorded event.
 * @param {ReturnType<typeof createState>} state
 * @param {any} ev  recorded event
 * @param {{firstSession: boolean}} ctx  whether ev belongs to the student's first session
 */
export function applyEvent(state, ev, ctx) {
	const files = state.files;
	switch (ev.kind) {
		case 'baseline': {
			const joining = ctx.firstSession && ev.initial;
			const f = files.get(ev.file);
			if (joining && typeof ev.starterBase === 'string') {
				// The server compared this file with the instructor's starter code and it differed:
				// keep what matches the starter, and mark the rest as written before recording began.
				const g = { text: ev.starterBase, attr: fill(ev.starterBase.length, 'starter') };
				replaceDiff(g, ev.text, 'unobserved');
				files.set(ev.file, g);
			} else if (!f) files.set(ev.file, { text: ev.text, attr: fill(ev.text.length, joining ? 'starter' : 'unobserved') });
			else replaceDiff(f, ev.text, 'unobserved');
			return;
		}
		case 'external_write':
		case 'citation_file': {
			if (ev.deleted) { files.delete(ev.file); return; }
			const source = ev.kind === 'citation_file' ? 'citation' : 'external_write';
			const f = files.get(ev.file);
			if (!f) files.set(ev.file, { text: ev.text, attr: fill(ev.text.length, source) });
			else replaceDiff(f, ev.text, source);
			return;
		}
		case 'rename': {
			const f = files.get(ev.file);
			if (f) { files.delete(ev.file); files.set(ev.to, f); }
			return;
		}
		default: {
			const source = ev.kind === 'paste_external' && ev.cite ? 'paste_cited' : EDIT_SOURCE[ev.kind];
			if (!source) return; // session, focus, save, cite: no content change
			let f = files.get(ev.file);
			if (!f) { f = { text: '', attr: [] }; files.set(ev.file, f); }
			splice(f, ev.off, ev.del, ev.text ?? '', source);
		}
	}
}

function splice(f, off, del, text, source) {
	off = Math.max(0, Math.min(off, f.text.length));
	f.text = f.text.slice(0, off) + text + f.text.slice(off + del);
	f.attr.splice(off, del, ...fill(text.length, source));
}

/** Replace a file's content, attributing only the changed middle region to `source`. */
function replaceDiff(f, next, source) {
	const prev = f.text;
	let start = 0;
	const max = Math.min(prev.length, next.length);
	while (start < max && prev[start] === next[start]) start++;
	let end = 0;
	while (end < max - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
	splice(f, start, prev.length - start - end, next.slice(start, next.length - end), source);
}

function fill(n, source) {
	return new Array(n).fill(source);
}

/** Collapse a per-char attribution array into [source, length] runs for display. */
export function runs(attr) {
	const out = [];
	for (const s of attr) {
		const last = out[out.length - 1];
		if (last && last[0] === s) last[1]++;
		else out.push([s, 1]);
	}
	return out;
}

/**
 * Character counts per source over the given files (default: all).
 * Whitespace is excluded so indentation and blank lines don't inflate anything.
 */
export function summarize(state, onlyFiles) {
	const counts = Object.fromEntries(SOURCES.map((s) => [s, 0]));
	for (const [path, f] of state.files) {
		if (onlyFiles && !onlyFiles.has(path)) continue;
		for (const [s, n] of Object.entries(fileCounts(f))) counts[s] += n;
	}
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	const written = total - [...EXCLUDED].reduce((a, s) => a + counts[s], 0); // added beyond the starter code
	const authored = [...AUTHORED].reduce((a, s) => a + counts[s], 0);
	const cited = [...DISCLOSED].reduce((a, s) => a + counts[s], 0);
	const pct = (n) => (written ? Math.round((1000 * n) / written) / 10 : 100);
	return {
		counts,
		total,
		written,
		authoredPct: pct(authored),
		citedPct: written ? pct(cited) : 0,
		/** Written in Lineage, or disclosed with a citation. */
		accountedPct: pct(authored + cited),
	};
}

/** Non-whitespace character counts per source for one file. */
export function fileCounts(f) {
	const counts = Object.fromEntries(SOURCES.map((s) => [s, 0]));
	for (let i = 0; i < f.text.length; i++) {
		const c = f.text.charCodeAt(i);
		if (c !== 32 && c !== 10 && c !== 9 && c !== 13) counts[f.attr[i]]++;
	}
	return counts;
}

/** Deep copy of a replay state (used for replay checkpoints). */
export function cloneState(state) {
	const files = new Map();
	for (const [path, f] of state.files) files.set(path, { text: f.text, attr: f.attr.slice() });
	return { files };
}

/** Event kinds that change file content (everything else is bookkeeping: session, focus, save). */
export const CONTENT_KINDS = new Set(['baseline', 'external_write', 'citation_file', 'rename', ...Object.keys(EDIT_SOURCE)]);

/** The source an event's inserted text is attributed to, for timeline coloring. */
export function eventSource(ev) {
	if (ev.kind === 'baseline') return ev.firstSession && ev.initial && typeof ev.starterBase !== 'string' ? 'starter' : 'unobserved';
	if (ev.kind === 'external_write') return 'external_write';
	if (ev.kind === 'citation_file') return 'citation';
	if (ev.kind === 'paste_external' && ev.cite) return 'paste_cited';
	if (ev.kind === 'delete') return 'delete';
	if (ev.kind === 'rename') return 'editor';
	return EDIT_SOURCE[ev.kind] ?? 'editor';
}

/** Replay a full ordered event list (as returned by the report API). */
export function replayAll(events, upTo = events.length) {
	const state = createState();
	for (let i = 0; i < upTo; i++) applyEvent(state, events[i], { firstSession: events[i].firstSession });
	return state;
}
