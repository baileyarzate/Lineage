// Hash chain shared by the recorder and the server.
// Keep this file byte-for-byte identical to lineage/recorder/src/chain.ts.
import { createHash } from 'node:crypto';

/** The `prev` value of the first event in a session. */
export function genesis(sessionId: string): string {
	return sha256('lineage-genesis:' + sessionId);
}

/**
 * Hash of one event. `body` is the event without its `hash` field, and must
 * include `prev`. Key order matters: JSON.parse preserves it, so the server
 * re-serializes exactly what the client hashed.
 */
export function hashEvent(prev: string, body: object): string {
	return sha256(prev + '\n' + JSON.stringify(body));
}

export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
