// Turns "where did this paste come from?" into a citation. Pure functions with no editor
// dependency, so they can be tested directly. Nothing here fetches a URL: sources are
// recognized from the link itself, which keeps citing fast, private and offline-friendly.

export interface Source {
	kind: 'ai' | 'qa' | 'code' | 'web' | 'other';
	/** Who made it: "OpenAI", a GitHub user. Left out when unknown (Q&A posts, most web pages). */
	author?: string;
	/** What it is: "ChatGPT", a question title, a repository name, a page title. */
	title: string;
	/** Where it's published: "Stack Overflow", "GitHub", a website's host. */
	site?: string;
	url?: string;
}

/** Sources a student can pick without a link (shown in the picker). */
export const AI_TOOLS: Record<string, Source> = {
	chatgpt: { kind: 'ai', author: 'OpenAI', title: 'ChatGPT' },
	claude: { kind: 'ai', author: 'Anthropic', title: 'Claude' },
	gemini: { kind: 'ai', author: 'Google', title: 'Gemini' },
	copilot: { kind: 'ai', author: 'Microsoft', title: 'Copilot' },
};

const AI_HOSTS: [RegExp, keyof typeof AI_TOOLS][] = [
	[/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'chatgpt'],
	[/(^|\.)claude\.ai$/, 'claude'],
	[/(^|\.)gemini\.google\.com$|^g\.co$/, 'gemini'],
	[/(^|\.)copilot\.microsoft\.com$/, 'copilot'],
];

/** Turn a pasted link (or a bare name like "chatgpt") into a Source. Returns undefined for nonsense. */
export function parseSource(input: string): Source | undefined {
	const raw = input.trim();
	if (!raw) return undefined;
	const named = AI_TOOLS[raw.toLowerCase()];
	if (named) return { ...named };

	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		return undefined;
	}
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return undefined;
	const host = url.hostname.replace(/^www\./, '');
	const parts = url.pathname.split('/').filter(Boolean);
	const href = url.toString();

	for (const [re, id] of AI_HOSTS) if (re.test(host)) return { ...AI_TOOLS[id], url: href };

	// Stack Overflow and other Stack Exchange sites: /questions/<id>/<slug>
	if (/(^|\.)(stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com)$/.test(host)) {
		const site = host === 'stackoverflow.com' ? 'Stack Overflow' : siteName(host);
		const q = parts.indexOf('questions');
		const slug = q >= 0 ? parts[q + 2] : undefined;
		return { kind: 'qa', site, title: slug ? sentence(slug) : `${site} question`, url: href };
	}

	if (host === 'github.com' && parts.length >= 2) {
		return { kind: 'code', author: parts[0], title: parts[1], site: 'GitHub', url: href };
	}
	if (host === 'gist.github.com' && parts.length >= 1) {
		return { kind: 'code', author: parts[0], title: 'Gist', site: 'GitHub', url: href };
	}

	const last = parts.length ? decodeURIComponent(parts[parts.length - 1]).replace(/\.(html?|php|aspx?)$/i, '') : '';
	return { kind: 'web', site: siteName(host), title: last ? sentence(last) : siteName(host), url: href };
}

/** "how-do-i-reverse-a-list" → "How do I reverse a list" */
function sentence(slug: string): string {
	const words = slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
	const fixed = words.replace(/\bi\b/g, 'I');
	return fixed.charAt(0).toUpperCase() + fixed.slice(1);
}

/** "docs.python.org" → "docs.python.org"; "unix.stackexchange.com" → "Unix Stack Exchange" */
function siteName(host: string): string {
	const se = host.match(/^([a-z0-9-]+)\.stackexchange\.com$/);
	if (se) return `${se[1].charAt(0).toUpperCase()}${se[1].slice(1)} Stack Exchange`;
	return host;
}

const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

/** IEEE date style: "Nov. 12, 2026" */
export function ieeeDate(d: Date): string {
	return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * IEEE reference for an online source, following its website format:
 *   [n] Author, "Title," Site. Accessed: Mon. D, YYYY. [Online]. Available: URL
 */
export function formatIEEE(src: Source, n: number, accessed: Date): string {
	const author = src.author ? `${src.author}, ` : '';
	const site = src.site && src.site !== src.title ? `${src.site}. ` : '';
	const where = src.url ? ` [Online]. Available: ${src.url}` : src.kind === 'ai' ? ' Generative AI tool; no shared link provided.' : '';
	return `[${n}] ${author}"${src.title}," ${site}Accessed: ${ieeeDate(accessed)}.${where}`;
}

const LINE_COMMENT: Record<string, string> = {};
for (const id of ['python', 'ruby', 'shellscript', 'r', 'yaml', 'makefile', 'perl', 'powershell', 'dockerfile', 'toml', 'julia', 'elixir', 'coffeescript', 'nim']) LINE_COMMENT[id] = '#';
for (const id of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin', 'scala', 'dart', 'php', 'jsonc', 'groovy', 'objective-c', 'fsharp', 'zig', 'verilog', 'solidity']) LINE_COMMENT[id] = '//';
for (const id of ['sql', 'lua', 'haskell', 'ada', 'vhdl', 'elm']) LINE_COMMENT[id] = '--';
for (const id of ['matlab', 'latex', 'tex', 'erlang', 'prolog']) LINE_COMMENT[id] = '%';
for (const id of ['lisp', 'scheme', 'clojure', 'racket', 'asm', 'ini']) LINE_COMMENT[id] = ';';
LINE_COMMENT.vb = "'";
const BLOCK_COMMENT: Record<string, [string, string]> = {
	html: ['<!--', '-->'], xml: ['<!--', '-->'], markdown: ['<!--', '-->'], vue: ['<!--', '-->'], svelte: ['<!--', '-->'],
	css: ['/*', '*/'], scss: ['/*', '*/'], less: ['/*', '*/'],
};

/** A one-line comment citing `ref` in the file's own language, or undefined if the language has no comments (plain text, JSON). */
export function citationComment(languageId: string, ref: string): string | undefined {
	const line = LINE_COMMENT[languageId];
	if (line) return `${line} Source: ${ref}`;
	const block = BLOCK_COMMENT[languageId];
	if (block) return `${block[0]} Source: ${ref} ${block[1]}`;
	return undefined;
}

export const REFERENCES_FILE = 'REFERENCES.md';
const REF_HEADER = '# References\n\nSources for code that came from outside this project, in IEEE style. Lineage adds an entry each time you cite a paste.\n\n';

/** Parse the numbered references already in REFERENCES.md. */
export function parseReferences(text: string | undefined): Map<number, string> {
	const refs = new Map<number, string>();
	for (const line of (text ?? '').split('\n')) {
		const m = line.match(/^\[(\d+)\]\s/);
		if (m) refs.set(Number(m[1]), line.trim());
	}
	return refs;
}

/**
 * Add a reference, reusing the number of an identical source (same URL, or same tool when there's no link)
 * so citing the same ChatGPT conversation twice gives one entry. Returns the new file text and the number.
 */
export function addReference(existing: string | undefined, src: Source, accessed: Date): { text: string; n: number; ref: string; reused: boolean } {
	const refs = parseReferences(existing);
	const key = `"${src.title},"`;
	for (const [n, line] of refs) {
		if (src.url ? line.includes(`Available: ${src.url}`) : line.includes(key) && !line.includes('Available:')) {
			return { text: existing!, n, ref: line, reused: true };
		}
	}
	const n = Math.max(0, ...refs.keys()) + 1;
	const ref = formatIEEE(src, n, accessed);
	const base = existing && existing.trim() ? existing.replace(/\s*$/, '\n') : REF_HEADER;
	return { text: `${base}${ref}\n`, n, ref, reused: false };
}
