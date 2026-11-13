import { SOURCES, AUTHORED, CONTENT_KINDS, applyEvent, cloneState, createState, eventSource, fileCounts } from './replay.js';

// ============================================================================
// Shared helpers
// ============================================================================

const LABEL = {
	typed: 'Typed', editor: 'Editor assist', paste_internal: 'Internal paste', starter: 'Starter code',
	paste_external: 'External paste', external_write: 'Written by another program', programmatic: 'No user input',
	unobserved: 'Not recorded', delete: 'Deleted', paste_cited: 'Cited paste', citation: 'Citation (added by Lineage)',
};
const KIND_LABEL = {
	typed: 'typed', delete: 'deleted', paste_internal: 'pasted (internal)', paste_external: 'pasted from outside',
	edit_other: 'editor assist', undo_redo: 'undo / redo', programmatic: 'edit with no user input',
	external_write: 'written by another program', baseline: 'file state at session start', rename: 'renamed',
	citation: 'citation comment added by Lineage', citation_file: 'REFERENCES.md updated by Lineage',
};
/** Draw order, bottom to top, so suspicious sources sit on top of timeline columns. */
const STACK = ['typed', 'editor', 'paste_internal', 'delete', 'starter', 'citation', 'paste_cited', 'unobserved', 'programmatic', 'paste_external', 'external_write'];
const SEVERITY = ['external_write', 'paste_external', 'programmatic', 'unobserved', 'paste_cited'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => n.toLocaleString();
const fmtDateTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTimeSec = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtGap = (ms) => ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `+${Math.round(ms / 60_000)} min` : `+${(ms / 3_600_000).toFixed(1)} h`;
const fmtMinutes = (m) => m < 1 ? "< 1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const srcColor = (s) => cssVar(s === 'delete' ? '--faint' : `--${s}`) || '#888';

function dueLabel(dueAt) {
	if (!dueAt) return '';
	const now = DEMO ? DEMO.exportedAt : Date.now(); // the demo is a snapshot: keep "due in N days" as it was
	const days = Math.round((dueAt - now) / 86_400_000);
	if (dueAt < now) return `Closed ${fmtDate(dueAt)}`;
	return `Due ${fmtDate(dueAt)}${days <= 7 ? ` · in ${days} day${days === 1 ? '' : 's'}` : ''}`;
}

function bar(counts) {
	const keys = SOURCES.filter((s) => s !== 'starter' && s !== 'citation');
	const total = keys.reduce((a, s) => a + (counts?.[s] ?? 0), 0);
	if (!total) return '<div class="bar"></div>';
	return `<div class="bar">${keys.map((s) => counts[s] ? `<div style="width:${(100 * counts[s]) / total}%;background:var(--${s})" title="${LABEL[s]}: ${num(counts[s])}"></div>` : '').join('')}</div>`;
}

function crumbs(items) {
	return `<nav class="crumbs">${items.map(([label, href]) => href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`).join('<i>/</i>')}</nav>`;
}

function safeGet(store, k) { try { return store.getItem(k); } catch { return null; } }
function safeSet(store, k, v) { try { store.setItem(k, v); } catch {} }

// ============================================================================
// Auth, API, routing
// ============================================================================

let adminKey = safeGet(localStorage, 'lineage.adminKey');
{
	const m = location.hash.match(/key=([^&]+)/);
	if (m) {
		adminKey = decodeURIComponent(m[1]);
		safeSet(localStorage, 'lineage.adminKey', adminKey);
		history.replaceState(null, '', location.pathname + '#/');
	}
}

// Public demo: a static export of the demo data (see src/export-demo.ts). No server, no admin key;
// reviews and notes are kept in this browser only.
const DEMO = window.LINEAGE_DEMO;
const DEMO_REVIEWS = 'lineage.demo.reviews';

async function demoApi(path, body) {
	const url = new URL(path, location.href);
	const q = url.searchParams;
	const reviews = JSON.parse(safeGet(localStorage, DEMO_REVIEWS) ?? '{}');
	const review = (a, s, base) => (`${a}/${s}` in reviews ? reviews[`${a}/${s}`] : base);
	const load = async (file) => {
		const res = await fetch(file);
		if (!res.ok) throw new Error('Not part of the demo.');
		return res.json();
	};
	const students = async (a) => (await load(`data/students/${encodeURIComponent(a)}.json`))
		.map((r) => ({ ...r, review: review(a, r.studentId, r.review) }));

	if (body) {
		if (!url.pathname.endsWith('/review')) throw new Error('This is a read-only demo.');
		const r = body.status || body.note ? { status: body.status ?? null, note: body.note ?? '', updated_at: Date.now() } : null;
		reviews[`${body.assignmentId}/${body.studentId}`] = r;
		safeSet(localStorage, DEMO_REVIEWS, JSON.stringify(reviews));
		return { review: r };
	}
	if (url.pathname.endsWith('/students')) return students(q.get('assignment'));
	if (url.pathname.endsWith('/report')) {
		const a = q.get('assignment'), s = q.get('student');
		const r = await load(`data/report/${encodeURIComponent(a)}/${encodeURIComponent(s)}.json`);
		return { ...r, review: review(a, s, r.review) };
	}
	if (url.pathname.endsWith('/overview')) {
		// Queue counts depend on this visitor's own reviews, so recount them.
		const ov = await load('data/overview.json');
		for (const a of ov.assignments) {
			const rows = await students(a.id);
			a.needsReview = rows.filter((r) => r.needsReview && r.review?.status !== 'cleared').length;
			a.followUp = rows.filter((r) => r.review?.status === 'follow_up').length;
		}
		return ov;
	}
	throw new Error('Not part of the demo.');
}

async function api(path, body) {
	if (DEMO) return demoApi(path, body);
	const res = await fetch(path, {
		method: body ? 'POST' : 'GET',
		headers: { 'x-admin-key': adminKey ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

function showLogin() {
	$('#view').innerHTML = '';
	$('#login').hidden = false;
}

$('#loginForm').addEventListener('submit', (e) => {
	e.preventDefault();
	adminKey = $('#keyInput').value.trim();
	safeSet(localStorage, 'lineage.adminKey', adminKey);
	route();
});

const hrefAssignment = (a) => `#/a/${encodeURIComponent(a)}`;
const hrefStudent = (a, s) => `${hrefAssignment(a)}/s/${encodeURIComponent(s)}`;

function parseRoute() {
	const [path, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
	const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
	if (parts[0] === 'a' && parts[1]) {
		if (parts[2] === 's' && parts[3]) return { view: 'student', assignment: parts[1], student: parts[3], frame: new URLSearchParams(qs).get('f') };
		return { view: 'assignment', assignment: parts[1] };
	}
	return { view: 'home' };
}

let overview;
async function getOverview(fresh) {
	if (!overview || fresh) overview = await api('/api/admin/overview');
	return overview;
}

function assignmentMeta(ov, id) {
	const a = ov.assignments.find((x) => x.id === id);
	if (!a) throw new Error(`No assignment "${id}".`);
	const course = ov.courses.find((c) => c.id === a.course_id);
	return { a, title: a.title || a.id, courseName: course?.name ?? 'Other' };
}

let active; // current view, so it can clean up listeners
let routeSeq = 0;

async function route() {
	active?.destroy?.();
	active = undefined;
	if (!adminKey && !DEMO) return showLogin();
	$('#login').hidden = true;
	const seq = ++routeSeq;
	const alive = () => seq === routeSeq;
	const r = parseRoute();
	const view = $('#view');
	try {
		if (r.view === 'home') active = await homeView(view, alive);
		else if (r.view === 'assignment') active = await assignmentView(view, r.assignment, alive);
		else active = await studentView(view, r, alive);
		window.scrollTo(0, 0);
	} catch (err) {
		if (err.message !== 'unauthorized' && alive()) view.innerHTML = `<div class="page"><div class="empty">${esc(err.message)}<br><br><a href="#/">Back to courses</a></div></div>`;
	}
}
window.addEventListener('hashchange', route);

if (DEMO) {
	$('header.top').insertAdjacentHTML('beforeend', `
		<span class="demo-note">Live demo with simulated students. Your reviews stay in this browser.
			<button class="link" id="demoReset">Reset</button> · <a href="${DEMO.about}">What is Lineage?</a></span>`);
	$('#demoReset').onclick = () => { try { localStorage.removeItem(DEMO_REVIEWS); } catch {} overview = undefined; route(); };
}

// ============================================================================
// Home: courses and assignments
// ============================================================================

async function homeView(el, alive) {
	const ov = await getOverview(true);
	if (!alive()) return;
	const groups = [...ov.courses, { id: null, name: 'Other' }]
		.map((c) => ({ c, list: ov.assignments.filter((a) => (a.course_id ?? null) === c.id) }))
		.filter((g) => g.list.length);
	const toReview = ov.assignments.reduce((n, a) => n + a.needsReview, 0);
	el.innerHTML = `
		<div class="page">
			<div class="pagehead">
				<div><h1>Courses</h1><p class="meta">${ov.assignments.length} assignments · ${toReview ? `<b>${toReview}</b> students waiting for review` : 'nothing waiting for review'}</p></div>
			</div>
			${groups.map((g) => `
				<section class="course">
					<h2>${esc(g.c.name)}</h2>
					<div class="agrid">${g.list.map(assignmentCard).join('')}</div>
				</section>`).join('') || '<div class="empty">No assignments yet. Run <code>npm run create-assignment -- my-hw</code>.</div>'}
		</div>`;
}

function assignmentCard(a) {
	const status = a.needsReview
		? `<span class="pill alert">${a.needsReview} to review</span>`
		: a.students ? '<span class="pill ok">All clear</span>' : '<span class="pill">No students yet</span>';
	return `
		<a class="acard" href="${hrefAssignment(a.id)}">
			<div class="acard-head"><b>${esc(a.title || a.id)}</b>${status}</div>
			<div class="meta">${esc(dueLabel(a.due_at) || a.id)}</div>
			${bar(a.counts)}
			<div class="acard-stats">
				<span><b>${a.students}</b> joined</span>
				<span><b>${a.submitted}</b> submitted</span>
				${a.followUp ? `<span><b>${a.followUp}</b> follow-up</span>` : ''}
			</div>
		</a>`;
}

// ============================================================================
// Assignment: triage table
// ============================================================================

const FILTERS = {
	review: { label: 'Needs review', test: (s) => s.needsReview && s.review?.status !== 'cleared' },
	all: { label: 'All', test: () => true },
	follow_up: { label: 'Follow-up', test: (s) => s.review?.status === 'follow_up' },
	unsubmitted: { label: 'Not submitted', test: (s) => !s.submittedAt },
};

const SORTS = {
	name: (s) => s.studentId,
	pct: (s) => (s.summary.written ? s.summary.authoredPct : 101),
	flags: (s) => -(s.alerts * 1000 + s.warnings),
	sessions: (s) => -s.sessions,
	active: (s) => -s.activeMinutes,
	submitted: (s) => s.submittedAt ?? Infinity,
	status: (s) => ({ follow_up: 0, cleared: 2 }[s.review?.status] ?? 1),
};

async function assignmentView(el, aid, alive) {
	const [ov, students] = await Promise.all([getOverview(), api(`/api/admin/students?assignment=${encodeURIComponent(aid)}`)]);
	if (!alive()) return;
	const { a, title, courseName } = assignmentMeta(ov, aid);
	const saved = JSON.parse(safeGet(sessionStorage, `lineage.table:${aid}`) ?? 'null');
	const ui = saved ?? { filter: students.some(FILTERS.review.test) ? 'review' : 'all', q: '', sort: 'pct', dir: 1 };

	el.innerHTML = `
		<div class="page">
			<div class="pagehead">
				<div>${crumbs([['Courses', '#/'], [courseName]])}<h1>${esc(title)}</h1>
					<p class="meta">${esc(dueLabel(a.due_at))}${a.due_at ? ' · ' : ''}${students.length} joined · ${students.filter((s) => s.submittedAt).length} submitted</p></div>
				<div class="headside">
					${a.join_code ? `<div class="meta">Join code <span class="joincode">${esc(a.join_code)}</span></div>` : ''}
					<div class="meta starter">${a.starter_version
						? `Starter code <span class="pill ok">version ${a.starter_version}</span>${DEMO ? '' : ' <button class="link" data-upload>Upload new version</button>'}`
						: `<span class="pill warn" title="Without it, work done before a student joins counts as starter code">No starter code</span>${DEMO ? '' : ' <button class="link" data-upload>Upload starter folder</button>'}`}
						<input type="file" webkitdirectory multiple hidden data-starter>
					</div>
				</div>
			</div>
			<div class="toolbar">
				<div class="chips">${Object.entries(FILTERS).map(([k, f]) => `<button data-f="${k}">${f.label} <span class="n">${students.filter(f.test).length}</span></button>`).join('')}</div>
				<input type="search" placeholder="Search students" aria-label="Search students" value="${esc(ui.q)}">
			</div>
			<div class="tablewrap"><table>
				<thead><tr>
					<th data-sort="name">Student</th><th data-sort="pct">Written in Lineage</th><th data-sort="flags">Flags</th>
					<th data-sort="sessions">Sessions</th><th data-sort="active">Active time</th><th data-sort="submitted">Submitted</th><th data-sort="status">Review</th>
				</tr></thead>
				<tbody></tbody>
			</table></div>
			<p class="meta" style="margin-top:10px">“Needs review” means any alert, or under 70% of the student's code either written in Lineage or pasted with a citation. Clearing a student removes them from the queue.</p>
		</div>`;

	const rows = () => {
		const q = ui.q.trim().toLowerCase();
		const key = SORTS[ui.sort];
		return students
			.filter(FILTERS[ui.filter].test)
			.filter((s) => !q || s.studentId.toLowerCase().includes(q))
			.sort((x, y) => {
				const a = key(x), b = key(y);
				return (a < b ? -1 : a > b ? 1 : x.studentId.localeCompare(y.studentId)) * ui.dir;
			});
	};

	const render = () => {
		safeSet(sessionStorage, `lineage.table:${aid}`, JSON.stringify(ui));
		$$('.chips button', el).forEach((b) => b.classList.toggle('on', b.dataset.f === ui.filter));
		$$('th[data-sort]', el).forEach((th) => {
			th.querySelector('.dir')?.remove();
			if (th.dataset.sort === ui.sort) th.insertAdjacentHTML('beforeend', `<span class="dir"> ${ui.dir > 0 ? '↑' : '↓'}</span>`);
		});
		const list = rows();
		$('tbody', el).innerHTML = list.length ? list.map((s) => `
			<tr data-id="${esc(s.studentId)}" tabindex="0">
				<td><b>${esc(s.studentId)}</b></td>
				<td><div class="pctcell"><span class="pct ${s.summary.written && (s.summary.accountedPct ?? s.summary.authoredPct) < 70 ? 'low' : ''}">${s.summary.written ? s.summary.authoredPct + '%' : '–'}</span>${bar(s.summary.counts)}${s.summary.citedPct ? `<span class="meta" title="Pasted from outside with a citation">+${s.summary.citedPct}% cited</span>` : ''}</div></td>
				<td>${s.alerts ? `<span class="badge alert" title="alerts">${s.alerts}</span> ` : ''}${s.warnings ? `<span class="badge warn" title="warnings">${s.warnings}</span>` : ''}${!s.alerts && !s.warnings ? '<span class="meta">–</span>' : ''}</td>
				<td class="num">${s.sessions}</td>
				<td class="num">${fmtMinutes(s.activeMinutes)}</td>
				<td>${s.submittedAt ? fmtDateTime(s.submittedAt) : '<span class="meta">Not submitted</span>'}</td>
				<td>${reviewPill(s.review)}</td>
			</tr>`).join('') : `<tr><td colspan="7"><div class="empty">${ui.filter === 'review' ? 'Nothing left to review.' : 'No students match.'}</div></td></tr>`;
		$$('tbody tr[data-id]', el).forEach((tr) => {
			const open = () => {
				saveQueue(aid, FILTERS[ui.filter].label, list.map((s) => s.studentId));
				location.hash = hrefStudent(aid, tr.dataset.id);
			};
			tr.onclick = open;
			tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
		});
	};

	$$('.chips button', el).forEach((b) => b.onclick = () => { ui.filter = b.dataset.f; render(); });
	$$('th[data-sort]', el).forEach((th) => th.onclick = () => {
		ui.dir = ui.sort === th.dataset.sort ? -ui.dir : 1;
		ui.sort = th.dataset.sort;
		render();
	});
	$('input[type=search]', el).oninput = (e) => { ui.q = e.target.value; render(); };
	const picker = $('input[data-starter]', el);
	if ($('[data-upload]', el)) $('[data-upload]', el).onclick = () => picker.click();
	picker.onchange = async () => {
		const btn = $('[data-upload]', el);
		btn.disabled = true;
		btn.textContent = 'Uploading…';
		try {
			const files = await readStarterFolder([...picker.files]);
			const n = Object.keys(files).length;
			if (!n) throw new Error('No text files found in that folder.');
			const { version } = await api('/api/admin/starter', { assignmentId: aid, files });
			await getOverview(true);
			if (alive()) await route();
			alert(`Saved ${n} starter files as version ${version}. Students who joined with an earlier version still match it.`);
		} catch (err) {
			if (err.message !== 'unauthorized') alert(`Couldn't upload starter code: ${err.message}`);
			btn.disabled = false;
			btn.textContent = 'Try again';
		}
	};
	render();
}

// Same rules as the recorder's project scan (recorder/src/recorder.ts).
const STARTER_EXCLUDE = new Set(['node_modules', '.git', 'out', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode-test', 'target']);
const STARTER_MAX_FILE = 512 * 1024;

/** Read a folder picked with <input webkitdirectory> into {relative path: text}. */
async function readStarterFolder(list) {
	const files = {};
	for (const file of list) {
		const parts = file.webkitRelativePath.split('/').slice(1); // drop the picked folder's own name
		if (!parts.length || parts.slice(0, -1).some((p) => STARTER_EXCLUDE.has(p)) || file.size > STARTER_MAX_FILE) continue;
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.subarray(0, 8000).includes(0)) continue; // binary
		files[parts.join('/')] = new TextDecoder().decode(bytes);
	}
	return files;
}

/** The student's cited sources (from REFERENCES.md), each with where it was used. Sources are as given by the student. */
function citationsPanel(report) {
	const list = report.citations ?? [];
	if (!list.length) return '';
	const link = (u) => /^https?:\/\//.test(u ?? '') ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">open</a>` : '';
	return `
		<div class="panel sources">
			<h3>Sources cited (${list.length})</h3>
			<ol>${list.map((c) => `
				<li><span class="ref">${esc(c.ref)}</span>
					<span class="meta">${c.uses.map((u) => `${esc(u.file)}${u.forPaste ? '' : ' (selection)'}`).join(', ')}${c.source?.url ? ' · ' + link(c.source.url) : ''}</span></li>`).join('')}
			</ol>
			<p class="meta" style="margin:8px 0 0">Sources are as the student gave them. The pasted text itself is in the replay.</p>
		</div>`;
}

function reviewPill(review) {
	if (review?.status === 'cleared') return '<span class="pill ok">Cleared</span>';
	if (review?.status === 'follow_up') return '<span class="pill warn">Follow-up</span>';
	return review?.note ? '<span class="pill">Note</span>' : '<span class="meta">–</span>';
}

function saveQueue(aid, label, ids) {
	safeSet(sessionStorage, `lineage.queue:${aid}`, JSON.stringify({ label, ids }));
}

async function loadQueue(aid, student) {
	const saved = JSON.parse(safeGet(sessionStorage, `lineage.queue:${aid}`) ?? 'null');
	if (saved?.ids.includes(student)) return saved;
	const students = await api(`/api/admin/students?assignment=${encodeURIComponent(aid)}`);
	students.sort((x, y) => SORTS.pct(x) - SORTS.pct(y));
	return { label: 'All students', ids: students.map((s) => s.studentId) };
}

// ============================================================================
// Student: summary, review, replay
// ============================================================================

async function studentView(el, r, alive) {
	const aid = r.assignment;
	const sid = r.student;
	const [ov, report, queue] = await Promise.all([
		getOverview(),
		api(`/api/admin/report?assignment=${encodeURIComponent(aid)}&student=${encodeURIComponent(sid)}`),
		loadQueue(aid, sid),
	]);
	if (!alive()) return;
	const { title, courseName } = assignmentMeta(ov, aid);
	const idx = queue.ids.indexOf(sid);
	const prev = idx > 0 ? queue.ids[idx - 1] : null;
	const next = idx >= 0 && idx < queue.ids.length - 1 ? queue.ids[idx + 1] : null;
	const s = report.summary;
	const authored = [...AUTHORED].reduce((n, k) => n + s.counts[k], 0);

	el.innerHTML = `
		<div class="page wide">
			<div class="pagehead">
				<div>${crumbs([['Courses', '#/'], [courseName], [title, hrefAssignment(aid)]])}<h1>${esc(sid)}</h1></div>
				<div class="switcher">
					<a class="btn ${prev ? '' : 'disabled'}" href="${prev ? hrefStudent(aid, prev) : '#'}" title="Previous student ( [ )">‹ Prev</a>
					<span class="meta">${idx >= 0 ? `${idx + 1} of ${queue.ids.length}` : ''} · ${esc(queue.label)}</span>
					<a class="btn ${next ? '' : 'disabled'}" href="${next ? hrefStudent(aid, next) : '#'}" title="Next student ( ] )">Next ›</a>
				</div>
			</div>
			<div class="summary">
				<div class="panel">
					<div class="cards">
						<div class="stat"><div class="v big ${s.written && (s.accountedPct ?? s.authoredPct) < 70 ? 'bad' : ''}">${s.written ? s.authoredPct + '%' : '–'}</div><div class="k">written in Lineage</div></div>
						<div class="stat"><div class="v">${num(authored)}</div><div class="k">authored chars</div></div>
						${s.counts.paste_cited ? `<div class="stat"><div class="v">${s.citedPct}%</div><div class="k">pasted with a citation</div></div>` : ''}
						<div class="stat"><div class="v">${num(s.written - authored - (s.counts.paste_cited ?? 0))}</div><div class="k">unattributed chars</div></div>
						<div class="stat"><div class="v">${fmtMinutes(report.activeMinutes)}</div><div class="k">active · ${report.sessions} session${report.sessions === 1 ? '' : 's'}</div></div>
						<div class="stat"><div class="v ${report.chainOk ? '' : 'bad'}">${report.chainOk ? 'Intact' : 'Broken'}</div><div class="k">hash chain</div></div>
					</div>
					${bar(s.counts)}
					<div class="legend">${SOURCES.filter((k) => s.counts[k]).map((k) => `<span><i style="background:var(--${k})"></i>${LABEL[k]} <b>${num(s.counts[k])}</b></span>`).join('')}</div>
					<div class="meta">${report.submittedAt ? `Submitted ${fmtDateTime(report.submittedAt)}.` : 'Not submitted yet.'} Counts exclude whitespace and Lineage's own citation text.</div>
				</div>
				<div class="panel">
					<h3>Flags (${report.flags.length})</h3>
					${report.flags.length ? `<ul class="flags">${report.flags.map((f, i) => `<li class="${f.level}"><span>${esc(f.message)}</span>${f.at ? `<button class="link" data-flag="${i}">${fmtDateTime(f.at)} ↗</button>` : ''}</li>`).join('')}</ul>` : '<p class="meta">No flags.</p>'}
				</div>
				<div class="panel review">
					<h3>Your review</h3>
					<div class="review-buttons">
						<button data-status="cleared">✓ Clear</button>
						<button data-status="follow_up">⚑ Follow up</button>
					</div>
					<textarea placeholder="Private note (saved automatically)"></textarea>
					<div class="meta review-saved"></div>
				</div>
			</div>
			${citationsPanel(report)}
			<div id="player"></div>
			<div class="hints">
				<span><kbd>←</kbd> <kbd>→</kbd> step one change</span><span><kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> step 10</span>
				<span><kbd>Space</kbd> play / pause</span><span><kbd>-</kbd> <kbd>+</kbd> zoom timeline</span><span><kbd>[</kbd> <kbd>]</kbd> previous / next student</span>
			</div>
		</div>`;

	// ---- review status ----
	let review = report.review ?? { status: null, note: '' };
	const note = $('.review textarea', el);
	note.value = review.note ?? '';
	const paintReview = (msg) => {
		$$('.review-buttons button', el).forEach((b) => b.className = b.dataset.status === review.status ? `on ${review.status}` : '');
		$('.review-saved', el).textContent = msg ?? (review.updated_at ? `Updated ${fmtDateTime(review.updated_at)}` : '');
	};
	const saveReview = async (patch) => {
		review = { ...review, ...patch };
		paintReview('Saving…');
		const res = await api('/api/admin/review', { assignmentId: aid, studentId: sid, status: review.status ?? null, note: review.note ?? '' });
		review = res.review ?? { status: null, note: '' };
		overview = undefined; // queue counts changed
		paintReview('Saved');
	};
	$$('.review-buttons button', el).forEach((b) => b.onclick = () => saveReview({ status: review.status === b.dataset.status ? null : b.dataset.status }));
	note.onchange = () => saveReview({ note: note.value });
	paintReview();

	// ---- replay ----
	const player = new Player($('#player'), report, (frame) => {
		history.replaceState(null, '', hrefStudent(aid, sid) + (frame == null ? '' : `?f=${frame}`));
	});
	$$('[data-flag]', el).forEach((b) => b.onclick = () => {
		const f = report.flags[Number(b.dataset.flag)];
		player.seekToTime(f.at, f.file);
		$('#player').scrollIntoView({ behavior: 'smooth', block: 'start' });
	});
	player.seek(r.frame != null ? Number(r.frame) : player.frames.length, 'center');

	const onKey = (e) => {
		if (e.target.closest('input, textarea, select')) return;
		if (e.key === '[' && prev) location.hash = hrefStudent(aid, prev);
		if (e.key === ']' && next) location.hash = hrefStudent(aid, next);
	};
	document.addEventListener('keydown', onKey);
	return { destroy() { player.destroy(); document.removeEventListener('keydown', onKey); } };
}

// ============================================================================
// Replay player: overview + detail timeline, file tree, code view with minimap
// ============================================================================

const CHECKPOINT_EVERY = 100;
const ZOOMS = [25, 100, 400, 1600, 6400];
const SPEEDS = [['1×', 1], ['4×', 4], ['16×', 16], ['Max', 0]];

class Player {
	constructor(root, report, onFrame) {
		this.root = root;
		this.onFrame = onFrame;
		this.flags = report.flags;
		this.agentRuns = report.agentRuns ?? [];
		this.submitted = report.submittedFiles ? new Set(report.submittedFiles) : null;
		// Frames: events that change content. Focus / save / session events are bookkeeping.
		this.frames = report.events.filter((e) => CONTENT_KINDS.has(e.kind) && e.file !== '.lineage.json');
		this.frame = this.frames.length;
		this.speed = 4;
		this.pinned = null;
		this.zoom = ZOOMS.findIndex((z) => z >= Math.min(this.frames.length, 400));
		if (this.zoom < 0) this.zoom = ZOOMS.length - 1;
		this.winStart = 0;
		this.collapsed = new Set();
		this.changedOnly = false;
		this.prepare();
		this.renderShell();
	}

	// ---- data ----

	prepare() {
		this.checkpoints = [];
		this.weights = new Float32Array(this.frames.length);
		this.sources = this.frames.map(eventSource);
		const edits = new Map(); // path -> edits after the starter baseline
		const state = createState();
		this.frames.forEach((ev, i) => {
			if (i % CHECKPOINT_EVERY === 0) this.checkpoints.push(cloneState(state));
			const before = state.files.get(ev.file)?.text ?? '';
			applyEvent(state, ev, ev);
			const after = state.files.get(ev.kind === 'rename' ? ev.to : ev.file)?.text ?? '';
			let w;
			if (typeof ev.off === 'number') w = (ev.text?.length ?? 0) || ev.del || 0;
			else { const [a, b] = changedRange(before, after); w = Math.max(b - a, before.length - after.length, 0); }
			this.weights[i] = this.sources[i] === 'starter' || this.sources[i] === 'citation' ? 0 : w;
			if (this.sources[i] !== 'starter' && this.sources[i] !== 'citation' && w > 0) edits.set(ev.file, (edits.get(ev.file) ?? 0) + 1);
		});
		this.checkpoints.push(cloneState(state));
		this.notable = this.frames.map((_, i) => {
			const s = this.sources[i];
			return (s === 'external_write' && this.weights[i] > 0) || ((s === 'paste_external' || s === 'paste_cited' || s === 'programmatic' || s === 'unobserved') && this.weights[i] >= 20);
		});
		this.sessionStarts = this.frames.map((e, i) => i === 0 || e.session !== this.frames[i - 1].session);
		// Agent runs as frame ranges (an agent that changed nothing still gets a sliver at its position).
		this.agentSpans = this.agentRuns.map((run) => {
			let a = this.frames.findIndex((e) => e.t >= run.start);
			if (a < 0) a = this.frames.length;
			let b = a;
			while (b < this.frames.length && this.frames[b].t <= run.end) b++;
			return { ...run, a, b: Math.max(b, a + 1) };
		});

		// Every file that ever existed, with final stats.
		const paths = new Set();
		for (const ev of this.frames) { paths.add(ev.file); if (ev.to) paths.add(ev.to); }
		this.fileInfo = new Map([...paths].sort().map((p) => {
			const f = state.files.get(p);
			const counts = f ? fileCounts(f) : Object.fromEntries(SOURCES.map((s) => [s, 0]));
			const written = SOURCES.reduce((n, s) => n + (s === 'starter' || s === 'citation' ? 0 : counts[s]), 0);
			return [p, {
				path: p, counts, written,
				worst: SEVERITY.find((s) => counts[s] > 0) ?? null,
				exists: !!f,
				changed: (edits.get(p) ?? 0) > 0,
				flags: this.flags.filter((fl) => fl.file === p && fl.level !== 'info'), // info (e.g. a cited paste) isn't a problem to badge
			}];
		}));
		// Start with folders that contain no changed files collapsed.
		for (const dir of this.dirs()) {
			if (![...this.fileInfo.values()].some((f) => f.changed && f.path.startsWith(dir + '/'))) this.collapsed.add(dir);
		}
	}

	dirs() {
		const out = new Set();
		for (const p of this.fileInfo.keys()) {
			const parts = p.split('/');
			for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
		}
		return out;
	}

	stateAt(n) {
		const cp = Math.min(Math.floor(n / CHECKPOINT_EVERY), this.checkpoints.length - 1);
		const state = cloneState(this.checkpoints[cp]);
		for (let i = cp * CHECKPOINT_EVERY; i < n; i++) applyEvent(state, this.frames[i], this.frames[i]);
		return state;
	}

	get winSize() {
		return Math.max(1, Math.min(ZOOMS[this.zoom], this.frames.length));
	}

	// ---- layout ----

	renderShell() {
		this.root.innerHTML = `
			<div class="player">
				<div class="controls">
					<button data-a="first" title="First change (Home)" aria-label="First change">⏮</button>
					<button data-a="prev" title="Previous change (←)" aria-label="Previous change">◀</button>
					<button data-a="play" class="play" title="Play / pause (Space)">▶ Play</button>
					<button data-a="next" title="Next change (→)" aria-label="Next change">▶</button>
					<button data-a="last" title="Final state (End)" aria-label="Final state">⏭</button>
					<div class="seg" role="group" aria-label="Playback speed">${SPEEDS.map(([l, v]) => `<button data-speed="${v}" class="${v === this.speed ? 'on' : ''}">${l}</button>`).join('')}</div>
					<span class="counter"></span>
				</div>
				<div class="track ov" title="Whole history. Click or drag to jump anywhere."><canvas></canvas><div class="win"></div><div class="head"></div></div>
				<div class="sessions"></div>
				<div class="track detail" title="Zoomed view of the highlighted window. Drag for fine control; scroll to zoom."><canvas></canvas><div class="head"></div></div>
				<div class="trackrow"><span class="range"></span>
					<span class="zoom">Zoom <button data-z="1" title="Zoom out (-)">−</button><span class="zl"></span><button data-z="-1" title="Zoom in (+)">+</button></span>
				</div>
				<div class="event"></div>
			</div>
			<div class="workspace">
				<aside class="tree">
					<div class="tree-head"><b>Files <span class="meta tree-count"></span></b><label><input type="checkbox" class="changed-only"> Changed only</label></div>
					<div class="tree-body"></div>
				</aside>
				<div class="editor">
					<div class="editor-head"><span class="path"></span><span class="follow"></span></div>
					<div class="code-wrap">
						<div class="code"><div class="lines"></div></div>
						<div class="mini-map" title="Whole file. Colored marks are code that wasn't written in Lineage. Click to jump."><canvas></canvas><div class="vp"></div></div>
					</div>
				</div>
			</div>`;
		const q = (s) => $(s, this.root);
		this.el = {
			play: q('[data-a=play]'), counter: q('.counter'),
			ov: q('.track.ov'), ovCanvas: q('.track.ov canvas'), ovHead: q('.track.ov .head'), win: q('.track.ov .win'),
			detail: q('.track.detail'), dCanvas: q('.track.detail canvas'), dHead: q('.track.detail .head'),
			range: q('.range'), zl: q('.zl'), sessions: q('.sessions'), event: q('.event'),
			treeBody: q('.tree-body'), treeCount: q('.tree-count'), changedOnly: q('.changed-only'),
			path: q('.path'), follow: q('.follow'), code: q('.code'), lines: q('.lines'),
			mini: q('.mini-map'), miniCanvas: q('.mini-map canvas'), vp: q('.mini-map .vp'),
		};

		$$('[data-a]', this.root).forEach((b) => b.onclick = () => this.action(b.dataset.a));
		$$('[data-speed]', this.root).forEach((b) => b.onclick = () => {
			this.speed = Number(b.dataset.speed);
			$$('[data-speed]', this.root).forEach((x) => x.classList.toggle('on', x === b));
		});
		$$('[data-z]', this.root).forEach((b) => b.onclick = () => this.setZoom(this.zoom + Number(b.dataset.z)));
		this.el.changedOnly.onchange = () => { this.changedOnly = this.el.changedOnly.checked; this.buildTree(); this.render(); };

		this.onKey = (e) => {
			if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
			const map = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last', ' ': 'play' };
			if (map[e.key]) { e.preventDefault(); this.action(map[e.key], e.shiftKey); }
			if (e.key === '-' || e.key === '_') this.setZoom(this.zoom + 1);
			if (e.key === '+' || e.key === '=') this.setZoom(this.zoom - 1);
		};
		document.addEventListener('keydown', this.onKey);

		// Overview: jump anywhere in the whole history (fast scroll).
		this.drag(this.el.ov, (x) => { this.pinned = null; this.seek(x * this.frames.length, 'center'); });
		// Detail: fine control inside the zoom window.
		this.drag(this.el.detail, (x) => this.seek(this.winStart + x * this.winSize, 'keep'));
		this.el.detail.addEventListener('wheel', (e) => {
			if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
			e.preventDefault();
			this.setZoom(this.zoom + (e.deltaY > 0 ? 1 : -1));
		}, { passive: false });
		// Minimap: jump within the file.
		this.drag(this.el.mini, (_, y) => {
			const pane = this.el.code;
			const mapH = (this.lineInfo?.length ?? 0) * (this.miniScale ?? 1);
			const frac = Math.min(1, (y * this.el.mini.clientHeight) / (mapH || 1));
			pane.scrollTop = frac * pane.scrollHeight - pane.clientHeight / 2;
		}, { pause: false });
		this.el.code.addEventListener('scroll', () => this.paintViewport());

		this.resize = new ResizeObserver(() => { this.drawOverview(); this.drawDetail(); this.drawMinimap(); });
		this.resize.observe(this.el.ov);
		this.resize.observe(this.el.mini);
		this.drawSessions();
		this.buildTree();
	}

	/** Pointer drag helper: calls fn with x, y as fractions of the element's box. */
	drag(el, fn, { pause = true } = {}) {
		const at = (e) => {
			const r = el.getBoundingClientRect();
			fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
		};
		el.onpointerdown = (e) => {
			if (pause) this.pause();
			el.setPointerCapture(e.pointerId);
			el.classList.add('dragging');
			at(e);
		};
		el.onpointermove = (e) => { if (el.hasPointerCapture(e.pointerId)) at(e); };
		el.onpointerup = el.onpointercancel = (e) => { el.releasePointerCapture(e.pointerId); el.classList.remove('dragging'); };
	}

	destroy() {
		this.pause();
		document.removeEventListener('keydown', this.onKey);
		this.resize?.disconnect();
	}

	// ---- transport ----

	action(a, big) {
		if (a === 'play') return this.playing ? this.pause() : this.play();
		this.pause();
		const step = big ? 10 : 1;
		if (a === 'first') this.seek(0, 'center');
		if (a === 'last') this.seek(this.frames.length, 'center');
		if (a === 'prev') this.seek(this.frame - step, 'keep');
		if (a === 'next') this.seek(this.frame + step, 'keep');
	}

	setZoom(z) {
		this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, z));
		this.placeWindow('center');
		this.render();
	}

	seekToTime(t, file) {
		this.pause();
		const i = this.frames.findIndex((e) => e.t >= t);
		this.pinned = file && this.fileInfo.has(file) ? file : null;
		this.seek(i < 0 ? this.frames.length : i + 1, 'center');
	}

	play() {
		if (!this.frames.length) return;
		if (this.frame >= this.frames.length) this.seek(0, 'center');
		this.playing = true;
		this.pinned = null;
		this.el.play.textContent = '⏸ Pause';
		const tick = () => {
			if (!this.playing) return;
			if (this.frame >= this.frames.length) return this.pause();
			if (this.speed === 0) {
				this.seek(this.frame + Math.max(1, Math.round(this.frames.length / 500)), 'page');
				this.timer = requestAnimationFrame(tick);
				return;
			}
			this.seek(this.frame + 1, 'page');
			// Wait about as long as the student did, with long pauses compressed.
			const cur = this.frames[this.frame - 1];
			const nxt = this.frames[this.frame];
			const gap = nxt ? Math.max(0, nxt.t - cur.t) : 0;
			this.timeout = setTimeout(tick, Math.min(Math.max(gap, 40), 700) / this.speed);
		};
		tick();
	}

	pause() {
		this.playing = false;
		cancelAnimationFrame(this.timer);
		clearTimeout(this.timeout);
		if (this.el) this.el.play.textContent = '▶ Play';
	}

	seek(n, mode = 'keep') {
		this.frame = Math.max(0, Math.min(this.frames.length, Math.round(n)));
		this.placeWindow(mode);
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
	}

	/** Keep the playhead inside the zoom window. */
	placeWindow(mode) {
		const size = this.winSize;
		const inside = this.frame >= this.winStart && this.frame <= this.winStart + size;
		if (mode === 'center' || !inside) {
			this.winStart = this.frame - (mode === 'page' ? Math.floor(size * 0.1) : Math.floor(size / 2));
		}
		this.winStart = Math.max(0, Math.min(this.frames.length - size, this.winStart));
	}

	// ---- rendering ----

	render() {
		const n = this.frame;
		const total = this.frames.length;
		const ev = n > 0 ? this.frames[n - 1] : undefined;

		const state = this.stateAt(Math.max(0, n - 1));
		const before = ev?.file ? state.files.get(ev.file)?.text : undefined;
		if (ev) applyEvent(state, ev, ev);
		const changedFile = ev?.kind === 'rename' ? ev.to : ev?.file;

		let current = this.pinned ?? (changedFile && this.fileInfo.has(changedFile) && state.files.has(changedFile) ? changedFile : undefined);
		if (!current) {
			current = state.files.has(this.lastFile) ? this.lastFile
				: [...this.fileInfo.values()].find((f) => f.changed && state.files.has(f.path))?.path
				?? [...state.files.keys()].find((p) => this.fileInfo.has(p));
		}
		this.lastFile = current;
		this.expandTo(current);

		// Code
		const f = state.files.get(current);
		let hl;
		if (f && ev && current === changedFile && ev.kind !== 'rename') {
			hl = typeof ev.off === 'number' ? [ev.off, ev.off + (ev.text?.length ?? 0)] : changedRange(before ?? '', f.text);
		}
		const out = f ? renderLines(f, hl) : { html: '', lines: [], curLine: -1 };
		this.el.lines.innerHTML = f ? out.html : `<div class="empty">${current ? 'This file doesn’t exist at this point in the history.' : 'No files recorded.'}</div>`;
		this.lineInfo = out.lines;
		this.curLine = out.curLine;
		if (out.curLine >= 0) {
			const row = this.el.lines.children[out.curLine];
			const pane = this.el.code;
			if (row && (row.offsetTop < pane.scrollTop + 30 || row.offsetTop > pane.scrollTop + pane.clientHeight - 60)) {
				pane.scrollTop = Math.max(0, row.offsetTop - pane.clientHeight / 3);
			}
		}
		this.drawMinimap();

		// Editor header
		this.el.path.textContent = current ?? '';
		const notSubmitted = current && this.submitted && !this.submitted.has(current) ? '<span class="meta">Not in submission · </span>' : '';
		this.el.follow.innerHTML = notSubmitted + (this.pinned
			? '<button class="link" data-follow>Pinned · follow changes</button>'
			: '<span class="meta">Following changes</span>');
		const fb = $('[data-follow]', this.el.follow);
		if (fb) fb.onclick = () => { this.pinned = null; this.render(); };

		// Tree state at this frame
		for (const row of this.treeRows) {
			const p = row.dataset.path;
			row.classList.toggle('current', p === current);
			row.classList.toggle('editing', p === changedFile && !!ev);
			row.classList.toggle('absent', !state.files.has(p));
		}

		// Timeline
		this.el.counter.textContent = `${num(n)} / ${num(total)} changes`;
		const pct = (x) => (total ? (100 * x) / total : 0);
		this.el.ovHead.style.left = `${pct(n)}%`;
		this.el.win.style.left = `${pct(this.winStart)}%`;
		this.el.win.style.width = `${pct(this.winSize)}%`;
		this.el.dHead.style.left = `${(100 * (n - this.winStart)) / this.winSize}%`;
		if (this.drawnWin !== `${this.winStart}:${this.winSize}`) this.drawDetail();
		const a = this.frames[this.winStart];
		const b = this.frames[Math.min(total, this.winStart + this.winSize) - 1];
		this.el.range.textContent = a && b ? `${fmtTimeSec(a.t)} → ${fmtTimeSec(b.t)}` : '';
		this.el.zl.textContent = this.winSize >= total ? `all ${num(total)}` : `${num(this.winSize)} changes`;

		// Event description
		if (ev) {
			const p = n > 1 ? this.frames[n - 2] : undefined;
			const src = this.sources[n - 1];
			const w = this.weights[n - 1];
			const size = ev.kind === 'delete' ? `−${ev.del} chars` : w ? `${num(w)} char${w === 1 ? '' : 's'}` : '';
			this.el.event.innerHTML = `
				<span class="chip ${src === 'citation' || src === 'starter' ? 'light' : ''}" style="--c:${srcColor(src)}">${esc(KIND_LABEL[ev.kind] ?? ev.kind)}</span>
				<b>${esc(changedFile ?? '')}</b>
				${size ? `<span class="meta">${size}</span>` : ''}
				<span class="meta">${fmtTimeSec(ev.t)}${p && p.session === ev.session ? ` · ${fmtGap(ev.t - p.t)}` : ` · start of session ${ev.session}`}</span>
				${this.agentRuns.filter((run) => ev.t >= run.start && ev.t <= run.end).map((run) => `<span class="chip" style="--c:var(--agent)">${esc(run.name)} running</span>`).join('')}`;
		} else {
			this.el.event.innerHTML = '<span class="meta">Starter code, before any changes. Press → or Play.</span>';
		}
		this.onFrame(n === total ? null : n);
	}

	// ---- file tree ----

	expandTo(path) {
		if (!path) return;
		const parts = path.split('/');
		let changed = false;
		for (let i = 1; i < parts.length; i++) {
			const d = parts.slice(0, i).join('/');
			if (this.collapsed.delete(d)) changed = true;
		}
		if (changed) this.buildTree();
	}

	buildTree() {
		const infos = [...this.fileInfo.values()];
		const files = infos.filter((f) => !this.changedOnly || f.changed);
		this.el.treeCount.textContent = `${infos.length} · ${infos.filter((f) => f.changed).length} changed`;

		const root = { dirs: new Map(), files: [] };
		for (const f of files) {
			const parts = f.path.split('/');
			let node = root;
			for (let i = 0; i < parts.length - 1; i++) {
				if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { key: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
				node = node.dirs.get(parts[i]);
			}
			node.files.push(f);
		}
		const all = (node) => [...node.files, ...[...node.dirs.values()].flatMap(all)];
		const renderNode = (node, depth) => [
			...[...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, d]) => {
				const inner = all(d);
				const worst = SEVERITY.find((s) => inner.some((f) => f.worst === s));
				const open = !this.collapsed.has(d.key);
				return `<div class="trow dir ${inner.some((f) => f.changed) ? '' : 'untouched'}" data-dir="${esc(d.key)}" style="--d:${depth}">
						<span class="caret">${open ? '▾' : '▸'}</span><span class="nm">${esc(name)}</span>${worst ? `<span class="dot" style="--c:var(--${worst})" title="Contains ${LABEL[worst].toLowerCase()}"></span>` : ''}
					</div><div class="children ${open ? '' : 'collapsed'}">${renderNode(d, depth + 1)}</div>`;
			}),
			...node.files.sort((a, b) => a.path.localeCompare(b.path)).map((f) => {
				const name = f.path.split('/').pop();
				const authored = [...AUTHORED].reduce((n, s) => n + f.counts[s], 0);
				const tip = f.changed
					? `${f.path}\n${num(f.written)} chars written · ${f.written ? Math.round((100 * authored) / f.written) : 100}% in Lineage${f.flags.length ? ` · ${f.flags.length} flag${f.flags.length === 1 ? '' : 's'}` : ''}${f.exists ? '' : '\nDeleted'}`
					: `${f.path}\nUnchanged starter file`;
				const flagLevel = f.flags.some((fl) => fl.level === 'alert') ? 'alert' : 'warn';
				return `<div class="trow file ${f.changed ? 'changed' : 'untouched'}" data-path="${esc(f.path)}" style="--d:${depth}" title="${esc(tip)}">
						<span class="caret"></span>
						<span class="dot ${f.worst ? '' : 'none'}" style="--c:var(--${f.worst ?? 'typed'})"></span>
						<span class="nm">${esc(name)}</span>
						${f.changed ? `<span class="mini">${miniBar(f.counts)}</span><span class="n">+${compact(f.written)}</span>` : ''}
						${f.flags.length ? `<span class="badge ${flagLevel}">${f.flags.length}</span>` : ''}
					</div>`;
			}),
		].join('');
		this.el.treeBody.innerHTML = renderNode(root, 0) || '<div class="empty">No files.</div>';
		this.treeRows = $$('.trow.file', this.el.treeBody);
		$$('.trow.dir', this.el.treeBody).forEach((row) => row.onclick = () => {
			const k = row.dataset.dir;
			this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
			this.buildTree();
			this.render();
		});
		this.treeRows.forEach((row) => row.onclick = () => {
			this.pinned = row.dataset.path;
			this.el.code.scrollTop = 0;
			this.render();
		});
	}

	// ---- canvases ----

	canvas(c, host) {
		const w = host.clientWidth;
		const h = host.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		c.width = Math.max(1, Math.round(w * dpr));
		c.height = Math.max(1, Math.round(h * dpr));
		c.style.width = `${w}px`;
		c.style.height = `${h}px`;
		const ctx = c.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		return { ctx, w, h };
	}

	/** Whole history, binned into pixel columns. Height = activity, color = source mix. */
	drawOverview() {
		const n = this.frames.length;
		const { ctx, w, h } = this.canvas(this.el.ovCanvas, this.el.ov);
		if (!n) return;
		const cols = Math.max(1, Math.floor(w));
		const bins = Array.from({ length: cols }, () => ({}));
		const totals = new Float32Array(cols);
		for (let i = 0; i < n; i++) {
			const c = Math.min(cols - 1, Math.floor((i / n) * cols));
			const s = this.sources[i];
			const wgt = Math.sqrt(this.weights[i]) || (s === 'delete' ? 0.5 : 0);
			bins[c][s] = (bins[c][s] ?? 0) + wgt;
			totals[c] += wgt;
		}
		let max = 0;
		for (const t of totals) if (t > max) max = t;
		const colW = w / cols;
		for (let c = 0; c < cols; c++) {
			if (!totals[c]) continue;
			const height = Math.max(2, Math.sqrt(totals[c] / (max || 1)) * (h - 10));
			let y = h;
			for (const s of STACK) {
				if (!bins[c][s]) continue;
				const part = (bins[c][s] / totals[c]) * height;
				ctx.fillStyle = srcColor(s);
				ctx.fillRect(c * colW, y - part, Math.ceil(colW), part);
				y -= part;
			}
		}
		// Notable events always get a marker, however much binning squashed them.
		for (let i = 0; i < n; i++) {
			if (!this.notable[i]) continue;
			const x = ((i + 0.5) / n) * w;
			ctx.fillStyle = srcColor(this.sources[i]);
			ctx.globalAlpha = 0.35;
			ctx.fillRect(x - 0.75, 0, 1.5, h);
			ctx.globalAlpha = 1;
			ctx.beginPath();
			ctx.moveTo(x - 4.5, 0); ctx.lineTo(x + 4.5, 0); ctx.lineTo(x, 7); ctx.closePath();
			ctx.fill();
		}
		ctx.fillStyle = cssVar('--faint');
		for (let i = 1; i < n; i++) if (this.sessionStarts[i]) ctx.fillRect((i / n) * w - 0.5, 0, 1, h);
		this.drawAgentBand(ctx, w, h, 0, n);
	}

	/** Bottom band over the frames during which an AI agent was running in Lineage's terminal. */
	drawAgentBand(ctx, w, h, from, size) {
		ctx.fillStyle = cssVar('--agent');
		for (const s of this.agentSpans) {
			const a = Math.max(s.a, from) - from;
			const b = Math.min(s.b, from + size) - from;
			if (b <= a && !(s.a >= from && s.a <= from + size)) continue;
			const x = (a / size) * w;
			ctx.fillRect(x, h - 4, Math.max(3, ((b - a) / size) * w), 4);
		}
	}

	/** The zoom window, one tick per change. */
	drawDetail() {
		const { ctx, w, h } = this.canvas(this.el.dCanvas, this.el.detail);
		const size = this.winSize;
		this.drawnWin = `${this.winStart}:${size}`;
		const tw = w / size;
		for (let k = 0; k < size; k++) {
			const i = this.winStart + k;
			if (i >= this.frames.length) break;
			const s = this.sources[i];
			const full = this.notable[i] || s === 'paste_external' || (s === 'external_write' && this.weights[i] > 0);
			ctx.fillStyle = srcColor(s);
			ctx.globalAlpha = s === 'delete' ? 0.7 : 1;
			const bh = full ? h - 4 : s === 'delete' ? h * 0.3 : h * 0.5;
			ctx.fillRect(k * tw + (tw > 3 ? 0.5 : 0), (h - bh) / 2, Math.max(1, tw - (tw > 3 ? 1 : 0)), bh);
			if (this.sessionStarts[i] && i > 0) {
				ctx.globalAlpha = 1;
				ctx.fillStyle = cssVar('--ink');
				ctx.fillRect(k * tw - 0.5, 0, 1.5, h);
			}
		}
		ctx.globalAlpha = 1;
		this.drawAgentBand(ctx, w, h, this.winStart, size);
	}

	drawSessions() {
		const n = this.frames.length;
		const marks = [];
		let lastPct = -100;
		this.frames.forEach((ev, i) => {
			if (!this.sessionStarts[i]) return;
			const pct = (100 * i) / n;
			if (pct - lastPct < 9) return; // avoid overlapping labels
			lastPct = pct;
			marks.push(`<span style="left:${pct}%">S${ev.session} · ${fmtDate(ev.t)}</span>`);
		});
		this.el.sessions.innerHTML = marks.join('');
	}

	/** Whole-file overview: one row per line, colored by where the line's code came from. */
	drawMinimap() {
		const { ctx, w, h } = this.canvas(this.el.miniCanvas, this.el.mini);
		const lines = this.lineInfo ?? [];
		if (!lines.length) { this.el.vp.style.display = 'none'; return; }
		this.el.vp.style.display = '';
		const scale = Math.min(4, h / lines.length);
		this.miniScale = scale;
		const faint = cssVar('--faint');
		const muted = cssVar('--muted');
		lines.forEach((ln, i) => {
			if (ln.len <= ln.indent) return;
			const x = 4 + ln.indent * 0.6;
			const width = Math.max(3, Math.min(w - 4 - x, (ln.len - ln.indent) * 0.6));
			ctx.fillStyle = ln.flag ? srcColor(ln.flag) : ln.src === 'starter' ? faint : muted;
			ctx.globalAlpha = ln.flag ? 1 : ln.src === 'starter' ? 0.45 : 0.75;
			ctx.fillRect(x, i * scale, width, Math.max(1, scale - (scale > 2 ? 1 : 0)));
		});
		ctx.globalAlpha = 1;
		if (this.curLine >= 0) {
			ctx.fillStyle = cssVar('--accent');
			ctx.fillRect(0, this.curLine * scale - 1, 3, Math.max(3, scale + 2));
		}
		this.paintViewport();
	}

	paintViewport() {
		const pane = this.el.code;
		const lines = this.lineInfo?.length ?? 0;
		if (!lines || !pane.scrollHeight) return;
		const mapH = lines * (this.miniScale ?? 1);
		this.el.vp.style.top = `${(pane.scrollTop / pane.scrollHeight) * mapH}px`;
		this.el.vp.style.height = `${Math.max(6, (pane.clientHeight / pane.scrollHeight) * mapH)}px`;
	}
}

function compact(n) {
	return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function miniBar(counts) {
	const keys = SOURCES.filter((s) => s !== 'starter' && s !== 'citation');
	const total = keys.reduce((a, s) => a + counts[s], 0) || 1;
	return keys.map((s) => counts[s] ? `<div style="width:${(100 * counts[s]) / total}%;background:var(--${s})"></div>` : '').join('');
}

/** Smallest [start, end) range in `after` that differs from `before` (end === start for pure deletes). */
function changedRange(before, after) {
	let start = 0;
	const max = Math.min(before.length, after.length);
	while (start < max && before[start] === after[start]) start++;
	let end = 0;
	while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
	return [start, after.length - end];
}

/**
 * Code as numbered lines with per-source spans. The current change is wrapped in
 * <mark class="cur"> (or shown as a caret for deletions). Also returns per-line
 * stats for the minimap and gutter.
 */
function renderLines(f, hl) {
	const [hs, he] = hl ?? [-1, -1];
	const { text, attr } = f;
	const lines = [];
	let html = '';
	let line = '';
	let seg = '';
	let segSrc = null;
	let inMark = false;
	let curLine = -1;
	let counts = {};
	let len = 0;
	let indent = 0;
	let leading = true;

	const flush = () => {
		if (seg) line += `<span class="s-${segSrc}">${esc(seg)}</span>`;
		seg = '';
	};
	const endLine = () => {
		flush();
		if (inMark) line += '</mark>';
		const flag = SEVERITY.find((s) => counts[s] > 0) ?? null;
		const src = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
		const no = lines.length;
		lines.push({ flag, src, len, indent });
		html += `<div class="ln${flag ? ` f-${flag}` : ''}${no === curLine ? ' cur-line' : ''}"><span class="no">${no + 1}</span><span class="tx">${line || ' '}</span></div>`;
		line = inMark ? '<mark class="cur">' : '';
		counts = {};
		len = 0;
		indent = 0;
		leading = true;
	};

	for (let i = 0; i <= text.length; i++) {
		if (i === hs && he === hs) { flush(); line += '<span class="caret"></span>'; curLine = lines.length; }
		if (i === he && inMark) { flush(); line += '</mark>'; inMark = false; }
		if (i === hs && he > hs) { flush(); line += '<mark class="cur">'; inMark = true; curLine = lines.length; }
		if (i === text.length) break;
		const ch = text[i];
		if (ch === '\n') { endLine(); continue; }
		const src = attr[i];
		if (src !== segSrc) { flush(); segSrc = src; }
		seg += ch;
		len++;
		if (ch === ' ' || ch === '\t') { if (leading) indent++; }
		else { leading = false; counts[src] = (counts[src] ?? 0) + 1; }
	}
	endLine();
	return { html, lines, curLine };
}

route();
