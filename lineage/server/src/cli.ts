import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createAssignment, createCourse, listAssignments, listCourses, openDb } from './db.ts';
import { loadOrCreateKeys } from './keys.ts';

const USAGE = `usage:
  npm run create-course -- <course-id> "<name>"
  npm run create-assignment -- <assignment-id> [--course <course-id>] [--title "<title>"] [--due YYYY-MM-DD]
  npm run list`;

const dataDir = resolve(process.env.LINEAGE_DATA ?? 'data');
mkdirSync(dataDir, { recursive: true });
loadOrCreateKeys(dataDir);
const db = openDb(dataDir);

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { course: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' } },
});
const [command, id, ...rest] = positionals;

if (command === 'create-course' && id && rest.length) {
	createCourse(db, id, rest.join(' '));
	console.log(`Created course "${id}": ${rest.join(' ')}`);
} else if (command === 'create-assignment' && id) {
	if (values.course && !listCourses(db).some((c) => c.id === values.course)) {
		console.error(`No course "${values.course}". Create it first with: npm run create-course -- ${values.course} "<name>"`);
		process.exit(1);
	}
	const dueAt = values.due ? new Date(`${values.due}T23:59:00`).getTime() : undefined;
	if (values.due && Number.isNaN(dueAt)) {
		console.error('--due must look like 2026-12-01');
		process.exit(1);
	}
	const code = createAssignment(db, id, { courseId: values.course, title: values.title, dueAt });
	console.log(`Created assignment "${id}"  join code: ${code}\n`);
	console.log('Put this .lineage.json in the root of the starter repo:\n');
	console.log(JSON.stringify({ assignmentId: id, server: `http://localhost:${process.env.PORT ?? 4747}` }, null, 2));
} else if (command === 'list') {
	console.table(listCourses(db));
	console.table(listAssignments(db).map((a) => ({ ...a, due_at: a.due_at ? new Date(a.due_at).toLocaleDateString() : '' })));
} else {
	console.log(USAGE);
	process.exit(1);
}
