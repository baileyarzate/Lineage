// Chains, encrypts, spools and uploads events.
//
// Every event is linked to the previous one by hash, then batches are encrypted
// for the course server and appended to a spool file in the extension's global
// storage (outside the project, unreadable to the student). The spool is drained
// to the server whenever it's reachable, so recording works offline.
import { constants, createCipheriv, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { genesis, hashEvent } from './chain';

export interface Envelope {
	wrappedKey: string;
	iv: string;
	tag: string;
	data: string;
}

export function seal(publicKey: string, payload: object): Envelope {
	const key = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
	return {
		wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64'),
	};
}

export interface TransportOptions {
	server: string;
	token: string;
	publicKey: string;
	spoolDir: string;
	spoolName: string;
	log: (msg: string) => void;
}

export class Transport {
	readonly sessionId = randomUUID();
	private seq = 0;
	private prev: string;
	private queue: object[] = [];
	private serial: Promise<void> = Promise.resolve();
	private timer: NodeJS.Timeout | undefined;
	private spoolPath: string;
	private opts: TransportOptions;
	sent = 0;
	lastError: string | undefined;

	constructor(opts: TransportOptions) {
		this.opts = opts;
		this.prev = genesis(this.sessionId);
		this.spoolPath = join(opts.spoolDir, `${opts.spoolName}.spool`);
	}

	start() {
		this.timer = setInterval(() => void this.flush(), 3000);
	}

	get pending() {
		return this.queue.length;
	}

	/** Add an event to the chain. `fields` must not contain seq/t/prev/hash. */
	record(fields: Record<string, unknown>) {
		const body = { seq: this.seq++, t: Date.now(), ...fields, prev: this.prev };
		const hash = hashEvent(this.prev, body);
		this.prev = hash;
		this.queue.push({ ...body, hash });
		if (this.queue.length >= 500) void this.flush();
	}

	/**
	 * Encrypt queued events into the spool, then try to upload the spool.
	 * Flushes run one at a time so spool rewrites never race with appends.
	 */
	flush(): Promise<void> {
		this.serial = this.serial.then(() => this.flushNow()).catch((err) => this.opts.log(`flush failed: ${err}`));
		return this.serial;
	}

	private async flushNow() {
		if (this.queue.length) {
			const events = this.queue;
			this.queue = [];
			const line = JSON.stringify({ sessionId: this.sessionId, envelope: seal(this.opts.publicKey, { events }) });
			await fs.mkdir(this.opts.spoolDir, { recursive: true });
			await fs.appendFile(this.spoolPath, line + '\n', { mode: 0o600 });
		}
		await this.drain();
	}

	async stop() {
		if (this.timer) clearInterval(this.timer);
		await this.flush();
	}

	private async drain() {
		let lines: string[];
		try {
			lines = (await fs.readFile(this.spoolPath, 'utf8')).split('\n').filter(Boolean);
		} catch {
			return; // no spool yet
		}
		{
			let done = 0;
			for (const line of lines) {
				const res = await this.post('/api/events', line).catch((err: Error) => err);
				if (res instanceof Error) {
					this.lastError = `server unreachable (${res.message}); recording offline`;
					break;
				}
				if (res.ok) {
					this.sent += 1;
					this.lastError = undefined;
				} else {
					// The server refused this batch for good (e.g. chain mismatch). Keep a copy and move on.
					const detail = await res.text();
					this.lastError = `server rejected a batch: ${res.status} ${detail}`;
					this.opts.log(this.lastError);
					await fs.appendFile(this.spoolPath + '.rejected', line + '\n', { mode: 0o600 });
				}
				done++;
			}
			if (done) {
				const rest = lines.slice(done);
				if (rest.length) await fs.writeFile(this.spoolPath, rest.join('\n') + '\n', { mode: 0o600 });
				else await fs.rm(this.spoolPath, { force: true });
			}
		}
	}

	post(path: string, body: string) {
		return fetch(this.opts.server.replace(/\/$/, '') + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` },
			body,
			signal: AbortSignal.timeout(10_000),
		});
	}
}
