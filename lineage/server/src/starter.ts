// Reads a starter-code folder the same way the recorder scans a project, so the
// snapshot covers exactly the files a student's baseline will contain.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { STARTER_MAX_FILE, STARTER_MAX_FILES } from './db.ts';

/** Keep in sync with EXCLUDE_DIRS in recorder/src/recorder.ts. */
export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode-test', 'target']);

export function readStarterDir(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	let count = 0;
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDE_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (!entry.isFile() || statSync(full).size > STARTER_MAX_FILE) continue;
			const bytes = readFileSync(full);
			if (bytes.subarray(0, 8000).includes(0)) continue; // binary
			if (++count > STARTER_MAX_FILES) throw new Error(`more than ${STARTER_MAX_FILES} files in ${root}`);
			files[relative(root, full).split(sep).join('/')] = bytes.toString('utf8');
		}
	};
	walk(root);
	return files;
}
