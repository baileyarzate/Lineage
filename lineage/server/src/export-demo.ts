// Builds the public demo: a static copy of the dashboard plus every API response it needs,
// generated from fresh demo data. Host the output on any static host (Cloudflare Pages, GitHub Pages).
//
//   npm run export-demo [-- <out-dir>]      (default: ../demo-site)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createLineageServer } from './server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const OUT = resolve(process.argv[2] ?? join(HERE, '..', '..', 'demo-site'));
const ABOUT = process.env.LINEAGE_ABOUT_URL ?? 'https://github.com/baileyarzate/Lineage';

const dataDir = mkdtempSync(join(tmpdir(), 'lineage-demo-'));
execFileSync(process.execPath, [join(HERE, 'seed.ts'), dataDir], { stdio: 'inherit' });
const exportedAt = Date.now();

const { server, db, keys } = createLineageServer(dataDir);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = async (path: string) => {
	const res = await fetch(base + path, { headers: { 'x-admin-key': keys.adminKey } });
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json() as Promise<any>;
};

rmSync(OUT, { recursive: true, force: true });
const write = (rel: string, data: unknown) => {
	const file = join(OUT, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(data));
};

try {
	const overview = await get('/api/admin/overview');
	for (const a of overview.assignments) delete a.join_code; // not meaningful in a demo
	write('data/overview.json', overview);
	let reports = 0;
	for (const a of overview.assignments) {
		const students = await get(`/api/admin/students?assignment=${encodeURIComponent(a.id)}`);
		write(`data/students/${encodeURIComponent(a.id)}.json`, students);
		for (const s of students) {
			const report = await get(`/api/admin/report?assignment=${encodeURIComponent(a.id)}&student=${encodeURIComponent(s.studentId)}`);
			write(`data/report/${encodeURIComponent(a.id)}/${encodeURIComponent(s.studentId)}.json`, report);
			reports++;
		}
	}

	for (const f of ['app.js', 'replay.js']) cpSync(join(PUBLIC, f), join(OUT, f));
	const demo = JSON.stringify({ exportedAt, about: ABOUT });
	const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
		.replace('<title>', '<title>Demo · ')
		.replace('<script type="module" src="app.js">', `<script>window.LINEAGE_DEMO = ${demo};</script>\n<script type="module" src="app.js">`);
	writeFileSync(join(OUT, 'index.html'), html);
	// Cloudflare Pages: let browsers cache the (immutable) report files for a while.
	writeFileSync(join(OUT, '_headers'), '/data/*\n  Cache-Control: public, max-age=3600\n');

	const size = execFileSync('du', ['-sh', OUT]).toString().split('\t')[0];
	console.log(`\nDemo site written to ${OUT} (${overview.assignments.length} assignments, ${reports} student reports, ${size}).`);
} finally {
	server.close();
	db.close();
	rmSync(dataDir, { recursive: true, force: true });
}
