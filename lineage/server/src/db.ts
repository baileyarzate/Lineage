import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

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
}

export function listAssignments(db: DB): AssignmentRow[] {
	return db.prepare(`
		SELECT a.id, a.join_code, a.course_id, a.title, a.due_at, COUNT(e.token) AS students
		FROM assignments a LEFT JOIN enrollments e ON e.assignment_id = a.id
		GROUP BY a.id ORDER BY a.course_id, COALESCE(a.due_at, a.created_at)
	`).all() as any;
}

export function listCourses(db: DB): { id: string; name: string }[] {
	return db.prepare('SELECT id, name FROM courses ORDER BY id').all() as any;
}
