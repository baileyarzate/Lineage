import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLineageServer } from '../src/server.ts';
import { createAssignment } from '../src/db.ts';
import { genesis, hashEvent, sha256 } from '../src/chain.ts';

/** Minimal stand-in for the recorder extension: same chain + envelope format. */
class FakeRecorder {
	sessionId = randomUUID();
	seq = 0;
	prev: string;
	t: number;
	queue: any[] = [];
	base: string;
	token: string;
	publicKey: string;

	constructor(base: string, token: string, publicKey: string, startT = Date.now()) {
		this.base = base;
		this.token = token;
		this.publicKey = publicKey;
		this.prev = genesis(this.sessionId);
		this.t = startT;
	}

	push(fields: object, dt = 150) {
		this.t += dt;
		const body = { seq: this.seq++, t: this.t, ...fields, prev: this.prev };
		const hash = hashEvent(this.prev, body);
		this.prev = hash;
		this.queue.push({ ...body, hash });
	}

	type(file: string, off: number, text: string, gap = () => 80 + Math.random() * 200) {
		for (let i = 0; i < text.length; i++) this.push({ kind: 'typed', file, off: off + i, del: 0, text: text[i] }, gap());
	}

	seal(payload: object) {
		const key = randomBytes(32);
		const iv = randomBytes(12);
		const c = createCipheriv('aes-256-gcm', key, iv);
		const data = Buffer.concat([c.update(JSON.stringify(payload)), c.final()]);
		return {
			wrappedKey: publicEncrypt({ key: this.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
			iv: iv.toString('base64'),
			tag: c.getAuthTag().toString('base64'),
			data: data.toString('base64'),
		};
	}

	async flush(events = this.queue) {
		const res = await post(this.base, '/api/events', { sessionId: this.sessionId, envelope: this.seal({ events }) }, this.token);
		if (events === this.queue) this.queue = [];
		return res;
	}

	submit(files: Record<string, string>) {
		const hashes = Object.fromEntries(Object.entries(files).map(([p, text]) => [p, sha256(text)]));
		return post(this.base, '/api/submit', { envelope: this.seal({ files: hashes }) }, this.token);
	}
}

async function post(base: string, path: string, body: object, token?: string) {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() as any };
}

async function withServer(fn: (ctx: { base: string; adminKey: string; joinCode: string }) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), 'lineage-test-'));
	const { server, db, keys } = createLineageServer(dir);
	const joinCode = createAssignment(db, 'cs1-hw1');
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		await fn({ base, adminKey: keys.adminKey, joinCode });
	} finally {
		server.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function report(base: string, adminKey: string, student: string) {
	const res = await fetch(`${base}/api/admin/report?assignment=cs1-hw1&student=${student}`, { headers: { 'x-admin-key': adminKey } });
	return res.json() as Promise<any>;
}

test('join rejects a wrong code and accepts the right one', async () => {
	await withServer(async ({ base, joinCode }) => {
		const bad = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode: 'NOPE', studentId: 'alice' });
		assert.equal(bad.status, 403);
		const ok = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode: joinCode.toLowerCase(), studentId: 'alice' });
		assert.equal(ok.status, 200);
		assert.match(ok.body.publicKey, /BEGIN PUBLIC KEY/);
	});
});

test('honest student: typed code is attributed to them', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'alice' });
		const r = new FakeRecorder(base, body.token, body.publicKey);

		const starter = 'def add(a, b):\n    pass\n';
		r.push({ kind: 'session', app: 'test' });
		r.push({ kind: 'baseline', file: 'main.py', text: starter, initial: true });
		const at = starter.indexOf('pass');
		r.push({ kind: 'delete', file: 'main.py', off: at, del: 4, text: '' });
		r.type('main.py', at, 'return a + b');
		let text = starter.replace('pass', 'return a + b');
		r.push({ kind: 'save', file: 'main.py', sha256: sha256(text) });
		assert.equal((await r.flush()).status, 200);
		assert.equal((await r.submit({ 'main.py': text })).status, 200);

		const rep = await report(base, adminKey, 'alice');
		assert.equal(rep.chainOk, true);
		assert.deepEqual(rep.mismatched, []);
		assert.equal(rep.summary.counts.typed, 'returna+b'.length);
		assert.equal(rep.summary.authoredPct, 100);
		assert.equal(rep.flags.filter((f: any) => f.level !== 'info').length, 0, JSON.stringify(rep.flags));
	});
});

test('agent writes to disk and student pastes from outside: flagged and unattributed', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'bob' });
		const r = new FakeRecorder(base, body.token, body.publicKey);

		let text = '# hw1\n';
		r.push({ kind: 'baseline', file: 'main.py', text, initial: true });
		r.type('main.py', text.length, 'x = 1\n');
		text += 'x = 1\n';
		// Claude Code (or any agent) rewrites the file on disk:
		const agentCode = 'def solve(nums):\n    return sorted(set(nums))[-2]\n';
		text += agentCode;
		r.push({ kind: 'external_write', file: 'main.py', text }, 30_000);
		// ...and creates a brand new file the student never opened:
		const helper = 'import itertools\n\ndef helper():\n    return list(itertools.permutations([1, 2, 3]))\n';
		r.push({ kind: 'external_write', file: 'helper.py', text: helper });
		// A big paste from a browser:
		const pasted = '# ' + 'explanation copied from a website '.repeat(8) + '\n';
		r.push({ kind: 'paste_external', file: 'main.py', off: text.length, del: 0, text: pasted });
		text += pasted;
		await r.flush();
		await r.submit({ 'main.py': text, 'helper.py': helper });

		const rep = await report(base, adminKey, 'bob');
		const codes = rep.flags.map((f: any) => f.code);
		assert.ok(codes.includes('external_write'));
		assert.ok(codes.includes('big_paste'));
		assert.ok(rep.summary.counts.external_write > 50);
		assert.ok(rep.summary.authoredPct < 10, `authoredPct was ${rep.summary.authoredPct}`);
	});
});

test('tampering with the chain is rejected', async () => {
	await withServer(async ({ base, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'eve' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.push({ kind: 'baseline', file: 'a.py', text: '', initial: true });
		r.type('a.py', 0, 'print(1)');
		const events = r.queue;
		// Rewrite an external write as "typed" after the fact without recomputing hashes:
		events[3] = { ...events[3], text: 'X' };
		const res = await r.flush(events);
		assert.equal(res.status, 409);
	});
});

test('resending a batch is idempotent', async () => {
	await withServer(async ({ base, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'dan' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.type('a.py', 0, 'abc');
		const batch = r.queue;
		assert.equal((await r.flush(batch)).status, 200);
		const again = await r.flush(batch);
		assert.equal(again.status, 200);
		assert.equal(again.body.duplicate, true);
	});
});

test('later session that finds files changed while Lineage was closed marks them unobserved', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'carol' });
		const s1 = new FakeRecorder(base, body.token, body.publicKey);
		s1.push({ kind: 'baseline', file: 'a.py', text: 'x = 1\n', initial: true });
		await s1.flush();
		const s2 = new FakeRecorder(base, body.token, body.publicKey, Date.now() + 86_400_000);
		s2.push({ kind: 'baseline', file: 'a.py', text: 'x = 1\nprint(sum(range(100)))\n', initial: true });
		await s2.flush();
		const rep = await report(base, adminKey, 'carol');
		assert.ok(rep.summary.counts.unobserved > 10);
		assert.equal(rep.summary.counts.starter, 'x=1'.length);
	});
});

test('creating an empty file in the editor is not flagged as an external write', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'frank' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.push({ kind: 'external_write', file: 'new.py', text: '' });
		r.type('new.py', 0, 'x = 1');
		await r.flush();
		const rep = await report(base, adminKey, 'frank');
		assert.ok(!rep.flags.some((f: any) => f.code === 'external_write'), JSON.stringify(rep.flags));
		assert.equal(rep.summary.authoredPct, 100);
	});
});

test('overview counts the review queue, and clearing a student removes them from it', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'gina' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.push({ kind: 'external_write', file: 'a.py', text: 'print("written by an agent")\n' });
		await r.flush();
		const overview = async () => (await (await fetch(`${base}/api/admin/overview`, { headers: { 'x-admin-key': adminKey } })).json() as any).assignments[0];
		assert.equal((await overview()).needsReview, 1);
		const res = await fetch(`${base}/api/admin/review`, {
			method: 'POST',
			headers: { 'x-admin-key': adminKey, 'content-type': 'application/json' },
			body: JSON.stringify({ assignmentId: 'cs1-hw1', studentId: 'gina', status: 'cleared', note: 'talked to them' }),
		});
		assert.equal(res.status, 200);
		assert.equal((await overview()).needsReview, 0);
		const noKey = await fetch(`${base}/api/admin/review`, { method: 'POST', body: '{}' });
		assert.equal(noKey.status, 401);
	});
});

test('agents run in the Lineage terminal and agent traces are flagged', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'hank' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.push({ kind: 'baseline', file: 'a.py', text: '', initial: true });
		r.push({ kind: 'agent', agent: 'claude', name: 'Claude Code', state: 'start', scope: 'terminal', run: 1 });
		r.push({ kind: 'agent', agent: 'claude', name: 'Claude Code', state: 'stop', scope: 'terminal', run: 1 }, 25 * 60_000);
		r.push({ kind: 'agent_trace', agent: 'claude', name: 'Claude Code', where: 'session history for this project', inRepo: false, lastActive: r.t });
		r.push({ kind: 'agent_trace', agent: 'repo', name: 'Aider', where: '.aider.chat.history.md', inRepo: true, lastActive: r.t });
		await r.flush();
		const rep = await report(base, adminKey, 'hank');
		const run = rep.flags.find((f: any) => f.code === 'agent_run');
		assert.match(run?.message ?? '', /Claude Code was run in Lineage's terminal \(25 min\)/);
		assert.equal(rep.flags.find((f: any) => f.code === 'agent_trace')?.level, 'alert');
		assert.equal(rep.flags.find((f: any) => f.code === 'agent_file')?.level, 'warn');
		assert.equal(rep.agentRuns.length, 1);
		assert.equal(rep.needsReview, true);
	});
});

test('a batch deleted before upload is reported as a gap, and later batches are still accepted', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId: 'iris' });
		const r = new FakeRecorder(base, body.token, body.publicKey);
		r.push({ kind: 'baseline', file: 'a.py', text: '', initial: true });
		r.type('a.py', 0, 'ok');
		assert.equal((await r.flush()).status, 200);
		r.push({ kind: 'paste_external', file: 'a.py', off: 2, del: 0, text: 'evidence the student wants gone' });
		r.queue = []; // the student deletes this batch from the spool
		r.type('a.py', 2, '!');
		assert.equal((await r.flush()).status, 200);
		const rep = await report(base, adminKey, 'iris');
		assert.equal(rep.chainOk, false);
		assert.ok(rep.flags.some((f: any) => f.code === 'gap' && f.level === 'alert'), JSON.stringify(rep.flags));
	});
});

test('the recording is unreadable without the server private key', async () => {
	const { generateKeyPairSync } = await import('node:crypto');
	const { openEnvelope } = await import('../src/keys.ts');
	const server = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
	const student = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
	const r = new FakeRecorder('http://unused', 'token', server.publicKey);
	r.push({ kind: 'paste_external', file: 'a.py', off: 0, del: 0, text: 'def secret_solution(): pass' });
	const envelope = r.seal({ events: r.queue });
	assert.ok(!JSON.stringify(envelope).includes('secret_solution'));
	assert.throws(() => openEnvelope(student.privateKey, envelope));
	assert.match(openEnvelope(server.privateKey, envelope), /secret_solution/);
});

test('starter code: work done before joining is caught, and starter updates keep earlier students matching', async () => {
	await withServer(async ({ base, adminKey, joinCode }) => {
		const v1 = 'def add(a, b):\n    pass\n';
		const v2 = 'def add(a, b):\n    """Return a + b."""\n    pass\n';
		const upload = (files: Record<string, string>) => fetch(`${base}/api/admin/starter`, {
			method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
			body: JSON.stringify({ assignmentId: 'cs1-hw1', files }),
		}).then((r) => r.json() as Promise<any>);
		const join = async (studentId: string, files: Record<string, string>) => {
			const { body } = await post(base, '/api/join', { assignmentId: 'cs1-hw1', joinCode, studentId });
			const r = new FakeRecorder(base, body.token, body.publicKey);
			r.push({ kind: 'session', app: 'test' });
			for (const [file, text] of Object.entries(files)) r.push({ kind: 'baseline', file, text, initial: true });
			assert.equal((await r.flush()).status, 200);
			return report(base, adminKey, studentId);
		};

		// Without uploaded starter code, everything present at join counts as starter (and the report says so).
		const before = await join('early', { 'main.py': v1.replace('pass', 'return a + b') });
		assert.ok(before.flags.some((f: any) => f.code === 'no_starter'));
		assert.equal(before.summary.written, 0);

		assert.equal((await upload({ 'main.py': v1 })).version, 1);
		const early = await report(base, adminKey, 'early'); // re-evaluated once the starter exists
		assert.ok(early.flags.some((f: any) => f.code === 'pre_join' && f.file === 'main.py'));

		assert.equal((await upload({ 'main.py': v2 })).version, 2);
		const onV1 = await join('on-v1', { 'main.py': v1 });
		const onV2 = await join('on-v2', { 'main.py': v2 });
		for (const rep of [onV1, onV2]) {
			assert.equal(rep.flags.filter((f: any) => f.level !== 'info').length, 0, JSON.stringify(rep.flags));
			assert.equal(rep.summary.written, 0);
		}

		// Solved the assignment (and added a helper file) before ever opening Lineage.
		const solution = v2.replace('pass', 'result = a + b\n    print("adding", a, b)\n    return result');
		const cheat = await join('cheat', { 'main.py': solution, 'helper.py': 'def mul(a, b):\n    return a * b\n' });
		const pre = cheat.flags.filter((f: any) => f.code === 'pre_join');
		assert.deepEqual(pre.map((f: any) => f.file).sort(), ['helper.py', 'main.py']);
		assert.ok(pre.some((f: any) => f.level === 'alert'));
		assert.equal(cheat.summary.authoredPct, 0);
		assert.equal(cheat.needsReview, true);
		// Starter text is still credited as starter, not as unrecorded work.
		assert.ok(cheat.summary.counts.starter >= 'defadd(a,b):"""Returna+b."""'.length);
	});
});
