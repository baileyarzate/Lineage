import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
	const db = new DatabaseSync(join(dataDir, 'lineage.sqlite'));
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS courses (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS assignments (
			id TEXT PRIMARY KEY,
			join_code TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS enrollments (
			token TEXT PRIMARY KEY,
			assignment_id TEXT NOT NULL REFERENCES assignments(id),
			student_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			UNIQUE (assignment_id, student_id)
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			token TEXT NOT NULL REFERENCES enrollments(token),
			first_seen INTEGER NOT NULL,
			last_seq INTEGER NOT NULL,
			last_hash TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS events (
			session_id TEXT NOT NULL REFERENCES sessions(id),
			seq INTEGER NOT NULL,
			server_t INTEGER NOT NULL,
			json TEXT NOT NULL,
			PRIMARY KEY (session_id, seq)
		);
		CREATE TABLE IF NOT EXISTS submissions (
			token TEXT NOT NULL REFERENCES enrollments(token),
			server_t INTEGER NOT NULL,
			files TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS reviews (
			assignment_id TEXT NOT NULL,
			student_id TEXT NOT NULL,
			status TEXT,
			note TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (assignment_id, student_id)
		);
		CREATE TABLE IF NOT EXISTS starter_files (
			assignment_id TEXT NOT NULL REFERENCES assignments(id),
			version INTEGER NOT NULL,
			path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			text TEXT NOT NULL,
			PRIMARY KEY (assignment_id, version, path)
		);
		CREATE TABLE IF NOT EXISTS starter_versions (
			assignment_id TEXT NOT NULL REFERENCES assignments(id),
			version INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			files INTEGER NOT NULL,
			PRIMARY KEY (assignment_id, version)
		);
		CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token);
		CREATE INDEX IF NOT EXISTS submissions_token ON submissions(token);
	`);
	// Columns added after the first release.
	const cols = new Set((db.prepare('PRAGMA table_info(assignments)').all() as { name: string }[]).map((c) => c.name));
	for (const [col, type] of [['course_id', 'TEXT'], ['title', 'TEXT'], ['due_at', 'INTEGER']]) {
		if (!cols.has(col)) db.exec(`ALTER TABLE assignments ADD COLUMN ${col} ${type}`);
	}
	return db;
}

export function createCourse(db: DB, id: string, name: string) {
	db.prepare('INSERT INTO courses (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
}

export interface AssignmentOptions {
	courseId?: string;
	title?: string;
	dueAt?: number;
}

export function createAssignment(db: DB, id: string, opts: AssignmentOptions = {}): string {
	const joinCode = randomBytes(4).toString('hex').toUpperCase();
	db.prepare('INSERT INTO assignments (id, join_code, created_at, course_id, title, due_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, joinCode, Date.now(), opts.courseId ?? null, opts.title ?? null, opts.dueAt ?? null);
	return joinCode;
}

export interface AssignmentRow {
	id: string;
	join_code: string;
	course_id: string | null;
	title: string | null;
	due_at: number | null;
	students: number;
	starter_version: number;
}

export function listAssignments(db: DB): AssignmentRow[] {
	return db.prepare(`
		SELECT a.id, a.join_code, a.course_id, a.title, a.due_at, COUNT(e.token) AS students,
			(SELECT COALESCE(MAX(version), 0) FROM starter_versions sv WHERE sv.assignment_id = a.id) AS starter_version
		FROM assignments a LEFT JOIN enrollments e ON e.assignment_id = a.id
		GROUP BY a.id ORDER BY a.course_id, COALESCE(a.due_at, a.created_at)
	`).all() as any;
}

export function listCourses(db: DB): { id: string; name: string }[] {
	return db.prepare('SELECT id, name FROM courses ORDER BY id').all() as any;
}

// ---- starter code -----------------------------------------------------------
// The instructor uploads the starter folder once. Each upload becomes a new version, so
// students who joined before a fix still match the version they started from.

export const STARTER_MAX_FILE = 512 * 1024; // same limits as the recorder
export const STARTER_MAX_FILES = 2000;

const normalizeText = (s: string) => s.replace(/\r\n/g, '\n');
export const starterHash = (s: string) => createHash('sha256').update(normalizeText(s), 'utf8').digest('hex');

/** Store a new starter version. Returns its number (1, 2, ...). */
export function addStarterVersion(db: DB, assignmentId: string, files: Record<string, string>): number {
	const entries = Object.entries(files).filter(([p, t]) => typeof t === 'string' && t.length <= STARTER_MAX_FILE && !t.includes('\0') && p);
	if (entries.length > STARTER_MAX_FILES) throw new Error(`too many files (max ${STARTER_MAX_FILES})`);
	const row = db.prepare('SELECT MAX(version) AS v FROM starter_versions WHERE assignment_id = ?').get(assignmentId) as { v: number | null };
	const version = (row.v ?? 0) + 1;
	const ins = db.prepare('INSERT INTO starter_files (assignment_id, version, path, sha256, text) VALUES (?, ?, ?, ?, ?)');
	db.exec('BEGIN');
	try {
		for (const [path, text] of entries) ins.run(assignmentId, version, path.replace(/\\/g, '/').replace(/^\.\//, ''), starterHash(text), normalizeText(text));
		db.prepare('INSERT INTO starter_versions (assignment_id, version, created_at, files) VALUES (?, ?, ?, ?)').run(assignmentId, version, Date.now(), entries.length);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	return version;
}

export interface StarterIndex {
	version: number; // latest version, 0 if none
	/** path -> starter texts across versions (newest first) */
	files: Map<string, { sha256: string; text: string }[]>;
}

export function loadStarter(db: DB, assignmentId: string): StarterIndex {
	const rows = db.prepare('SELECT version, path, sha256, text FROM starter_files WHERE assignment_id = ? ORDER BY version DESC')
		.all(assignmentId) as { version: number; path: string; sha256: string; text: string }[];
	const files = new Map<string, { sha256: string; text: string }[]>();
	for (const r of rows) {
		const list = files.get(r.path) ?? [];
		if (!list.some((x) => x.sha256 === r.sha256)) list.push({ sha256: r.sha256, text: r.text });
		files.set(r.path, list);
	}
	return { version: starterVersion(db, assignmentId), files };
}

export function starterVersion(db: DB, assignmentId: string): number {
	return (db.prepare('SELECT MAX(version) AS v FROM starter_versions WHERE assignment_id = ?').get(assignmentId) as { v: number | null }).v ?? 0;
}

export function starterVersions(db: DB, assignmentId: string): { version: number; created_at: number; files: number }[] {
	return db.prepare('SELECT version, created_at, files FROM starter_versions WHERE assignment_id = ? ORDER BY version').all(assignmentId) as any;
}
