// Notices AI coding agents used on this assignment, without looking outside it.
//
// Lineage does NOT list processes, read other folders, or inspect the rest of the
// computer. It only looks at things tied to this project:
//
//  1. Lineage's own terminal: commands run there that start a known agent
//     (see the terminal hook in extension.ts, which uses `identifyCommand`).
//  2. Per-project agent folders, checked by EXACT path. Agents name these after the
//     project path (e.g. ~/.claude/projects/<project path>), so Lineage computes the
//     path for this project and its subfolders and checks only whether it exists and
//     when it last changed. Directories are never listed and contents are never read.
//  3. Agent files inside the repo (CLAUDE.md, .aider*, ...).
//
// Results go into the encrypted event stream and are never shown to the student.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentDef { id: string; name: string; match: RegExp }

export const AGENTS: AgentDef[] = [
	{ id: 'claude', name: 'Claude Code', match: /^(claude|@anthropic-ai\/claude-code)$/ },
	{ id: 'codex', name: 'Codex CLI', match: /^(codex|@openai\/codex)$/ },
	{ id: 'aider', name: 'Aider', match: /^(aider|aider-chat)$/ },
	{ id: 'gemini', name: 'Gemini CLI', match: /^(gemini|@google\/gemini-cli)$/ },
	{ id: 'opencode', name: 'opencode', match: /^(opencode|opencode-ai)$/ },
	{ id: 'cursor-agent', name: 'Cursor Agent', match: /^cursor-agent$/ },
	{ id: 'goose', name: 'Goose', match: /^goose$/ },
	{ id: 'qwen', name: 'Qwen Code', match: /^(qwen|@qwen-code\/qwen-code)$/ },
	{ id: 'crush', name: 'Crush', match: /^crush$/ },
];

/** Agent config/history files that show up inside a repo. */
const REPO_MARKERS: { [file: string]: string } = {
	'CLAUDE.md': 'Claude Code', '.claude': 'Claude Code', 'AGENTS.md': 'Codex / agents', '.codex': 'Codex CLI',
	'GEMINI.md': 'Gemini CLI', '.gemini': 'Gemini CLI', '.aider.chat.history.md': 'Aider', '.aider.input.history': 'Aider',
	'.aider.tags.cache.v4': 'Aider', '.aider.tags.cache.v3': 'Aider', '.cursor': 'Cursor', '.cursorrules': 'Cursor',
	'.opencode': 'opencode', '.goosehints': 'Goose',
};

const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'sudo', 'env', 'exec', 'time', 'nohup', 'command']);

/**
 * Which agent, if any, a terminal command line starts. Looks at the program being run
 * (skipping launchers like npx and VAR=value prefixes), in every part of a && / ; / | chain.
 */
export function identifyCommand(commandLine: string): AgentDef | undefined {
	for (const part of commandLine.split(/&&|\|\||[;|]/)) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < tokens.length && (/^\w+=/.test(tokens[i]) || LAUNCHERS.has(tokens[i]) || (tokens[i].startsWith('-') && i > 0))) i++;
		const program = (tokens[i] ?? '').replace(/^.*[/\\]/, '').replace(/\.(exe|cmd|ps1)$/i, '').replace(/@[\d.]+$|@latest$/, '');
		const pkg = (tokens[i] ?? '').replace(/@[\d.]+$|@latest$/, '');
		const agent = AGENTS.find((a) => a.match.test(program) || a.match.test(pkg));
		if (agent) return agent;
	}
	return undefined;
}

const TRACE_POLL_MS = 60_000;
const MAX_FOLDERS = 300;

type RecordFn = (fields: { [k: string]: unknown }) => void;

export class AgentTraces {
	private root: string;
	private folders: () => string[];
	private record: RecordFn;
	private timer: NodeJS.Timeout | undefined;
	private seen = new Map<string, number>(); // trace key -> last recorded mtime

	/** `folders` returns project-relative folder paths ('src', 'src/utils', ...). */
	constructor(root: string, folders: () => string[], record: RecordFn) {
		this.root = root;
		this.folders = folders;
		this.record = record;
	}

	start() {
		void this.check();
		this.timer = setInterval(() => void this.check(), TRACE_POLL_MS);
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
	}

	private async check() {
		const home = homedir();
		const found: { key: string; agent: string; name: string; where: string; inRepo: boolean; mtime: number }[] = [];

		// Claude Code names its per-project folder after the absolute path, with every
		// non-alphanumeric character replaced by "-". Check this project and its subfolders only.
		const folders = ['', ...this.folders().slice(0, MAX_FOLDERS)];
		for (const rel of folders) {
			const abs = rel ? join(this.root, rel) : this.root;
			const dir = join(home, '.claude', 'projects', abs.replace(/[^A-Za-z0-9]/g, '-'));
			const mtime = await mtimeOf(dir);
			if (mtime) found.push({ key: `claude:${rel}`, agent: 'claude', name: 'Claude Code', where: rel ? `session history for ${rel}/` : 'session history for this project', inRepo: false, mtime });
		}

		// Gemini CLI keeps per-project data under ~/.gemini/tmp/<sha256 of the project path>.
		const gemini = await mtimeOf(join(home, '.gemini', 'tmp', createHash('sha256').update(this.root).digest('hex')));
		if (gemini) found.push({ key: 'gemini', agent: 'gemini', name: 'Gemini CLI', where: 'project data for this folder', inRepo: false, mtime: gemini });

		for (const [file, name] of Object.entries(REPO_MARKERS)) {
			const mtime = await mtimeOf(join(this.root, file));
			if (mtime) found.push({ key: `repo:${file}`, agent: 'repo', name, where: file, inRepo: true, mtime });
		}

		for (const t of found) {
			const last = this.seen.get(t.key);
			if (last !== undefined && t.mtime - last < 30_000) continue;
			this.seen.set(t.key, t.mtime);
			this.record({ kind: 'agent_trace', agent: t.agent, name: t.name, where: t.where, inRepo: t.inRepo, lastActive: Math.round(t.mtime) });
		}
	}
}

/** Last-modified time of one exact path (no listing, no reading), or undefined if it doesn't exist. */
async function mtimeOf(path: string): Promise<number | undefined> {
	try {
		return (await fs.stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}
