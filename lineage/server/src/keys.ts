// Server key pair and envelope decryption.
// Clients encrypt each batch with a fresh AES-256-GCM key, and wrap that key
// with the server's RSA public key (RSA-OAEP/SHA-256). Only the server can read it.
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Envelope {
	wrappedKey: string; // base64
	iv: string; // base64
	tag: string; // base64
	data: string; // base64
}

export interface ServerKeys {
	publicKey: string;
	privateKey: string;
	adminKey: string;
}

export function loadOrCreateKeys(dataDir: string): ServerKeys {
	mkdirSync(dataDir, { recursive: true });
	const pubPath = join(dataDir, 'server-public.pem');
	const privPath = join(dataDir, 'server-private.pem');
	const adminPath = join(dataDir, 'admin.key');

	if (!existsSync(privPath)) {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		writeFileSync(pubPath, publicKey);
		writeFileSync(privPath, privateKey, { mode: 0o600 });
	}
	if (!existsSync(adminPath)) {
		writeFileSync(adminPath, randomBytes(18).toString('base64url'), { mode: 0o600 });
	}

	return {
		publicKey: readFileSync(pubPath, 'utf8'),
		privateKey: readFileSync(privPath, 'utf8'),
		adminKey: readFileSync(adminPath, 'utf8').trim(),
	};
}

export function openEnvelope(privateKey: string, env: Envelope): string {
	const key = privateDecrypt(
		{ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		Buffer.from(env.wrappedKey, 'base64'),
	);
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
}
