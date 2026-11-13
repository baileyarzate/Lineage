import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genesis, hashEvent } from './chain.ts';
import { addStarterVersion, listAssignments, listCourses, openDb, starterVersion, starterVersions, type DB } from './db.ts';
import { loadOrCreateKeys, openEnvelope, type Envelope } from './keys.ts';
import { buildReport } from './report.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 20 * 1024 * 1024;
const STATIC: Record<string, string> = {
	'/': 'index.html',
	'/app.js': 'app.js',
	'/replay.js': 'replay.js',
};
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8' };

class HttpError extends Error {
	status: number;
	body: object;
	constructor(status: number, message: string, extra: object = {}) {
		super(message);
		this.status = status;
		this.body = { error: message, ...extra };
	}
}

export function createLineageServer(dataDir: string) {
	const keys = loadOrCreateKeys(dataDir);
	const db = openDb(dataDir);
	const ctx: Ctx = { db, keys, cache: new Map() };

	const server = createHttpServer(async (req, res) => {
		try {
			await route(req, res, ctx);
		} catch (err) {
			if (err instanceof HttpError) send(res, err.status, err.body);
			else {
				console.error(err);
				send(res, 500, { error: 'internal error' });
			}
		}
	});

	return { server, db, keys };
}

interface Ctx {
	db: DB;
	keys: ReturnType<typeof loadOrCreateKeys>;
	cache: Map<string, { key: string; report: NonNullable<ReturnType<typeof buildReport>> }>;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Ctx) {
	const { db, keys } = ctx;
	const url = new URL(req.url ?? '/', 'http://localhost');
	const path = url.pathname;

	if (req.method === 'GET' && STATIC[path]) {
		const file = STATIC[path];
		res.writeHead(200, { 'content-type': MIME[file.split('.').pop()!], 'cache-control': 'no-store' });
		res.end(readFileSync(join(PUBLIC_DIR, file)));
		return;
	}

	// ---- student endpoints -------------------------------------------------

	if (req.method === 'POST' && path === '/api/join') {
		const { assignmentId, joinCode, studentId } = await readJson(req);
		if (!assignmentId || !joinCode || !studentId) throw new HttpError(400, 'assignmentId, joinCode and studentId are required');
		const a = db.prepare('SELECT join_code FROM assignments WHERE id = ?').get(assignmentId) as { join_code: string } | undefined;
		if (!a) throw new HttpError(404, `unknown assignment "${assignmentId}"`);
		if (String(joinCode).trim().toUpperCase() !== a.join_code) throw new HttpError(403, 'wrong join code');

		const existing = db.prepare('SELECT token FROM enrollments WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId) as { token: string } | undefined;
		const token = existing?.token ?? randomBytes(24).toString('base64url');
		if (!existing) {
			db.prepare('INSERT INTO enrollments (token, assignment_id, student_id, created_at) VALUES (?, ?, ?, ?)').run(token, assignmentId, studentId, Date.now());
		}
		send(res, 200, { token, publicKey: keys.publicKey });
		return;
	}

	if (req.method === 'POST' && path === '/api/events') {
		const token = studentToken(req, db);
		const { sessionId, envelope } = await readJson(req);
		if (typeof sessionId !== 'string' || sessionId.length < 8) throw new HttpError(400, 'bad sessionId');
		const { events } = JSON.parse(decrypt(keys.privateKey, envelope));
		if (!Array.isArray(events) || events.length === 0) throw new HttpError(400, 'no events');
		send(res, 200, ingest(db, token, sessionId, events));
		return;
	}

	if (req.method === 'POST' && path === '/api/submit') {
		const token = studentToken(req, db);
		const { envelope } = await readJson(req);
		const { files } = JSON.parse(decrypt(keys.privateKey, envelope));
		if (!files || typeof files !== 'object') throw new HttpError(400, 'no files');
		db.prepare('INSERT INTO submissions (token, server_t, files) VALUES (?, ?, ?)').run(token, Date.now(), JSON.stringify(files));
		send(res, 200, { ok: true, files: Object.keys(files).length });
		return;
	}

	// ---- instructor endpoints ----------------------------------------------

	if (path.startsWith('/api/admin/')) {
		requireAdmin(req, keys.adminKey);

		if (req.method === 'GET' && path === '/api/admin/overview') {
			const assignments = listAssignments(db).map((a) => {
				const rows = studentRows(ctx, a.id);
				const counts: Record<string, number> = {};
				for (const r of rows) for (const [k, v] of Object.entries(r.summary.counts as Record<string, number>)) counts[k] = (counts[k] ?? 0) + v;
				return {
					...a,
					submitted: rows.filter((r) => r.submittedAt).length,
					needsReview: rows.filter(inQueue).length,
					followUp: rows.filter((r) => r.review?.status === 'follow_up').length,
					counts,
				};
			});
			send(res, 200, { courses: listCourses(db), assignments });
			return;
		}

		if (req.method === 'GET' && path === '/api/admin/students') {
			send(res, 200, studentRows(ctx, url.searchParams.get('assignment') ?? ''));
			return;
		}

		if (req.method === 'GET' && path === '/api/admin/report') {
			const assignment = url.searchParams.get('assignment') ?? '';
			const student = url.searchParams.get('student') ?? '';
			const r = cachedReport(ctx, assignment, student);
			if (!r) throw new HttpError(404, 'no such student');
			send(res, 200, { ...r, review: getReview(db, assignment, student) });
			return;
		}

		if (req.method === 'GET' && path === '/api/admin/starter') {
			send(res, 200, { versions: starterVersions(db, url.searchParams.get('assignment') ?? '') });
			return;
		}

		if (req.method === 'POST' && path === '/api/admin/starter') {
			const { assignmentId, files } = await readJson(req);
			if (!db.prepare('SELECT 1 FROM assignments WHERE id = ?').get(String(assignmentId))) throw new HttpError(404, 'no such assignment');
			if (!files || typeof files !== 'object' || !Object.keys(files).length) throw new HttpError(400, 'no files');
			let version: number;
			try { version = addStarterVersion(db, assignmentId, files); } catch (err: any) { throw new HttpError(400, err.message); }
			send(res, 200, { version, versions: starterVersions(db, assignmentId) });
			return;
		}

		if (req.method === 'POST' && path === '/api/admin/review') {
			const { assignmentId, studentId, status, note } = await readJson(req);
			if (!['cleared', 'follow_up', null].includes(status ?? null)) throw new HttpError(400, 'status must be cleared, follow_up or null');
			if (!status && !note) {
				db.prepare('DELETE FROM reviews WHERE assignment_id = ? AND student_id = ?').run(assignmentId, studentId);
			} else {
				db.prepare(`INSERT INTO reviews (assignment_id, student_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (assignment_id, student_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`)
					.run(assignmentId, studentId, status ?? null, String(note ?? '').slice(0, 5000), Date.now());
			}
			send(res, 200, { review: getReview(db, assignmentId, studentId) });
			return;
		}
	}

	throw new HttpError(404, 'not found');
}

interface Review { status: string | null; note: string; updated_at: number }

function getReview(db: DB, assignment: string, student: string): Review | null {
	return (db.prepare('SELECT status, note, updated_at FROM reviews WHERE assignment_id = ? AND student_id = ?').get(assignment, student) as any) ?? null;
}

/** In the review queue: flagged by the report and not cleared by an instructor. */
function inQueue(row: { needsReview: boolean; review: Review | null }) {
	return row.needsReview && row.review?.status !== 'cleared';
}

/** Reports are rebuilt only when a student's event count or latest submission changes. */
function cachedReport(ctx: Ctx, assignment: string, student: string) {
	const meta = ctx.db.prepare(`
		SELECT
			(SELECT COUNT(*) FROM events ev JOIN sessions s ON s.id = ev.session_id WHERE s.token = e.token) AS n,
			(SELECT MAX(server_t) FROM submissions WHERE token = e.token) AS sub
		FROM enrollments e WHERE e.assignment_id = ? AND e.student_id = ?`).get(assignment, student) as { n: number; sub: number | null } | undefined;
	if (!meta) return undefined;
	const key = `${meta.n}:${meta.sub}:${starterVersion(ctx.db, assignment)}`;
	const id = `${assignment}\0${student}`;
	const hit = ctx.cache.get(id);
	if (hit?.key === key) return hit.report;
	const report = buildReport(ctx.db, assignment, student)!;
	ctx.cache.set(id, { key, report });
	return report;
}

function studentRows(ctx: Ctx, assignment: string) {
	const reviews = new Map((ctx.db.prepare('SELECT student_id, status, note, updated_at FROM reviews WHERE assignment_id = ?').all(assignment) as any[])
		.map((r) => [r.student_id, { status: r.status, note: r.note, updated_at: r.updated_at } as Review]));
	const students = ctx.db.prepare('SELECT student_id FROM enrollments WHERE assignment_id = ? ORDER BY student_id').all(assignment) as { student_id: string }[];
	return students.map(({ student_id }) => {
		const r = cachedReport(ctx, assignment, student_id)!;
		return {
			studentId: student_id,
			summary: r.summary,
			sessions: r.sessions,
			activeMinutes: r.activeMinutes,
			submittedAt: r.submittedAt,
			alerts: r.flags.filter((f) => f.level === 'alert').length,
			warnings: r.flags.filter((f) => f.level === 'warn').length,
			needsReview: r.needsReview,
			reasons: r.reasons,
			review: reviews.get(student_id) ?? null,
		};
	});
}

/** Verify a batch continues the session's hash chain, then store it. */
function ingest(db: DB, token: string, sessionId: string, events: any[]) {
	const now = Date.now();
	let session = db.prepare('SELECT token, last_seq, last_hash FROM sessions WHERE id = ?').get(sessionId) as
		{ token: string; last_seq: number; last_hash: string } | undefined;
	if (session && session.token !== token) throw new HttpError(403, 'session belongs to another student');

	let expectedSeq = session ? session.last_seq + 1 : 0;
	let prev = session ? session.last_hash : genesis(sessionId);

	// Idempotent retries: skip events already stored (client resent a batch after a dropped response).
	const fresh = events.filter((e) => typeof e?.seq === 'number' && e.seq >= expectedSeq);
	if (fresh.length === 0) return { ok: true, lastSeq: expectedSeq - 1, duplicate: true };

	// A gap (events deleted from the local spool before upload) is accepted so the rest of the
	// history isn't lost; the batch must still be internally consistent, and the report flags the gap.
	const first = fresh[0];
	if (first.seq > expectedSeq && hashEvent(first.prev, (({ hash, ...rest }) => rest)(first)) === first.hash) {
		expectedSeq = first.seq;
		prev = first.prev;
	}

	for (const ev of fresh) {
		const { hash, ...body } = ev;
		if (body.seq !== expectedSeq || body.prev !== prev || hashEvent(prev, body) !== hash) {
			throw new HttpError(409, 'event does not continue the hash chain', { expectedSeq, gotSeq: body.seq });
		}
		expectedSeq++;
		prev = hash;
	}

	const insert = db.prepare('INSERT INTO events (session_id, seq, server_t, json) VALUES (?, ?, ?, ?)');
	db.exec('BEGIN');
	try {
		if (!session) {
			db.prepare('INSERT INTO sessions (id, token, first_seen, last_seq, last_hash) VALUES (?, ?, ?, ?, ?)').run(sessionId, token, now, -1, genesis(sessionId));
		}
		for (const ev of fresh) insert.run(sessionId, ev.seq, now, JSON.stringify(ev));
		db.prepare('UPDATE sessions SET last_seq = ?, last_hash = ? WHERE id = ?').run(expectedSeq - 1, prev, sessionId);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	return { ok: true, lastSeq: expectedSeq - 1 };
}

function decrypt(privateKey: string, envelope: Envelope): string {
	try {
		return openEnvelope(privateKey, envelope);
	} catch {
		throw new HttpError(400, 'could not decrypt payload (was it encrypted for this server?)');
	}
}

function studentToken(req: IncomingMessage, db: DB): string {
	const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
	if (!token || !db.prepare('SELECT 1 FROM enrollments WHERE token = ?').get(token)) throw new HttpError(401, 'not enrolled');
	return token;
}

function requireAdmin(req: IncomingMessage, adminKey: string) {
	const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
	const want = Buffer.from(adminKey);
	if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'admin key required');
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, 'body too large');
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
	} catch {
		throw new HttpError(400, 'invalid JSON');
	}
}

function send(res: ServerResponse, status: number, body: object) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}
