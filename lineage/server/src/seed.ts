// Generates a realistic demo dataset: 2 courses, 3 assignments, ~40 students, ~100k events.
// Students follow behavior profiles (honest, crammer, paster, agent user, scripted typist...)
// and their events use the exact chain format the recorder produces, so the server verifies them.
//
//   node src/seed.ts [data-dir]      (default: data-demo, wiped first)
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { genesis, hashEvent, sha256 } from './chain.ts';
import { addStarterVersion, createAssignment, createCourse, openDb } from './db.ts';
import { loadOrCreateKeys } from './keys.ts';

const DAY = 86_400_000;
const NOW = Date.now();

// ---- deterministic randomness ---------------------------------------------

let seed = 20261104;
function rand() {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a: number, b: number) => a + rand() * (b - a);
const chance = (p: number) => rand() < p;
function lognormal(median: number, sigma: number) {
	const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
	return median * Math.exp(sigma * z);
}

// ---- assignment content -----------------------------------------------------

type Part = string | { body: string; stub?: string };
interface FileSpec { path: string; parts: Part[]; created?: boolean }
interface AssignmentSpec {
	id: string;
	course: string;
	title: string;
	releasedDaysAgo: number;
	dueInDays: number; // negative = already due
	extras: Record<string, string>; // starter files students don't need to touch
	files: FileSpec[];
	profiles: Profile[];
}

const PASS = '    pass\n';

const HW3: Omit<AssignmentSpec, 'profiles'> = {
	id: 'cs101-hw3',
	course: 'cs101',
	title: 'HW3 · Text statistics',
	releasedDaysAgo: 16,
	dueInDays: -3,
	extras: {
		'README.md': '# HW3: Text statistics\n\nImplement the functions in `stats.py` so that `test_stats.py` passes.\nThen write `main.py`, a small command-line tool that prints statistics for a file.\n\nRun the tests with `python -m pytest`.\n',
		'sample.txt': 'It was the best of times, it was the worst of times. It was the age of wisdom!\nIt was the age of foolishness? It was the epoch of belief, it was the epoch of incredulity.\n',
	},
	files: [
		{
			path: 'stats.py',
			parts: [
				'"""Text statistics for HW3."""\n\nimport string\n\n\ndef word_count(text):\n    """Return the number of words in text."""\n',
				{ body: '    words = text.split()\n    return len(words)\n' },
				'\n\ndef char_frequencies(text):\n    """Return a dict mapping each letter (lowercased) to how often it appears."""\n',
				{ body: '    counts = {}\n    for ch in text.lower():\n        if ch in string.ascii_lowercase:\n            counts[ch] = counts.get(ch, 0) + 1\n    return counts\n' },
				'\n\ndef most_common_words(text, n=5):\n    """Return the n most common words as (word, count) pairs, most common first."""\n',
				{ body: '    counts = {}\n    for raw in text.split():\n        word = raw.strip(string.punctuation).lower()\n        if not word:\n            continue\n        counts[word] = counts.get(word, 0) + 1\n    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))\n    return ranked[:n]\n' },
				'\n\ndef average_word_length(text):\n    """Return the average word length, ignoring punctuation. 0 for empty text."""\n',
				{ body: '    words = [w.strip(string.punctuation) for w in text.split()]\n    words = [w for w in words if w]\n    if not words:\n        return 0\n    return sum(len(w) for w in words) / len(words)\n' },
				'\n\ndef longest_sentence(text):\n    """Return the sentence with the most words."""\n',
				{ body: "    sentences = []\n    current = []\n    for word in text.split():\n        current.append(word)\n        if word.endswith(('.', '!', '?')):\n            sentences.append(' '.join(current))\n            current = []\n    if current:\n        sentences.append(' '.join(current))\n    if not sentences:\n        return ''\n    return max(sentences, key=lambda s: len(s.split()))\n" },
			],
		},
		{
			path: 'main.py',
			created: true,
			parts: [{ stub: '', body: 'import sys\n\nfrom stats import average_word_length, most_common_words, word_count\n\n\ndef main(path):\n    with open(path) as f:\n        text = f.read()\n    print(f"words: {word_count(text)}")\n    print(f"average length: {average_word_length(text):.2f}")\n    for word, count in most_common_words(text):\n        print(f"{word:>12} {count}")\n\n\nif __name__ == "__main__":\n    main(sys.argv[1] if len(sys.argv) > 1 else "sample.txt")\n' }],
		},
		{
			path: 'test_stats.py',
			parts: [
				'from stats import average_word_length, char_frequencies, longest_sentence, most_common_words, word_count\n\n\ndef test_word_count():\n    assert word_count("a b  c") == 3\n\n\ndef test_char_frequencies():\n    assert char_frequencies("Aab!") == {"a": 2, "b": 1}\n',
				{ stub: '', body: '\n\ndef test_most_common_words():\n    assert most_common_words("b a b c a b", 2) == [("b", 3), ("a", 2)]\n\n\ndef test_average_word_length():\n    assert average_word_length("hi, you!") == 2.5\n    assert average_word_length("") == 0\n\n\ndef test_longest_sentence():\n    assert longest_sentence("Hi. How are you?") == "How are you?"\n' },
			],
		},
	],
};

const HW4: Omit<AssignmentSpec, 'profiles'> = {
	id: 'cs101-hw4',
	course: 'cs101',
	title: 'HW4 · Gradebook',
	releasedDaysAgo: 4,
	dueInDays: 5,
	extras: {
		'README.md': '# HW4: Gradebook\n\nFill in `gradebook.py`. `students.csv` has sample data.\n',
		'students.csv': 'name,score\nAda,93\nAda,88\nGrace,79\nGrace,85\nAlan,61\nAlan,72\n',
		'test_gradebook.py': 'from gradebook import letter_grade\n\n\ndef test_letter_grade():\n    assert letter_grade(95) == "A"\n    assert letter_grade(59.9) == "F"\n',
	},
	files: [
		{
			path: 'gradebook.py',
			parts: [
				'"""HW4: a tiny gradebook."""\n\nimport csv\nfrom statistics import mean\n\n\ndef load_scores(path):\n    """Read a CSV of name,score rows into a dict of name -> list of scores."""\n',
				{ body: '    scores = {}\n    with open(path, newline="") as f:\n        for row in csv.reader(f):\n            if not row or row[0] == "name":\n                continue\n            name, score = row[0].strip(), float(row[1])\n            scores.setdefault(name, []).append(score)\n    return scores\n' },
				'\n\ndef letter_grade(average):\n    """Map a numeric average to a letter grade."""\n',
				{ body: '    if average >= 90:\n        return "A"\n    if average >= 80:\n        return "B"\n    if average >= 70:\n        return "C"\n    if average >= 60:\n        return "D"\n    return "F"\n' },
				'\n\ndef report(scores):\n    """Return (name, average, letter) rows sorted by average, best first."""\n',
				{ body: '    rows = []\n    for name, values in scores.items():\n        avg = round(mean(values), 1)\n        rows.append((name, avg, letter_grade(avg)))\n    rows.sort(key=lambda r: (-r[1], r[0]))\n    return rows\n' },
				'\n\ndef class_summary(rows):\n    """Return a dict with the class average and how many of each letter."""\n',
				{ body: '    if not rows:\n        return {"average": 0, "letters": {}}\n    letters = {}\n    for _, _, letter in rows:\n        letters[letter] = letters.get(letter, 0) + 1\n    return {"average": round(mean(r[1] for r in rows), 1), "letters": letters}\n' },
			],
		},
	],
};

const P2: Omit<AssignmentSpec, 'profiles'> = {
	id: 'cs210-p2',
	course: 'cs210',
	title: 'Project 2 · Graph search',
	releasedDaysAgo: 20,
	dueInDays: -1,
	extras: {
		'README.md': '# Project 2: Graph search\n\nImplement BFS and A* over grid mazes in `search.py`.\nAdd `benchmark.py` comparing the two on `mazes/large.txt`.\n',
		'mazes/small.txt': 'S..#\n.#..\n...G\n',
		'mazes/large.txt': 'S....#.........\n.###.#.#######.\n...#...#.....#.\n##.#####.###.#.\n.......#...#...\n.#####.###.###.\n.....#.......#G\n',
		'utils/__init__.py': '',
		'utils/render.py': 'def render(grid, path=()):\n    """Return the maze as text with the path drawn as *."""\n    cells = set(path)\n    return "\\n".join(\n        "".join("*" if (r, c) in cells and ch == "." else ch for c, ch in enumerate(row))\n        for r, row in enumerate(grid)\n    )\n',
		'test_search.py': 'from search import astar, bfs, parse_maze\n\nSMALL = open("mazes/small.txt").read()\n\n\ndef test_bfs_small():\n    grid, s, g = parse_maze(SMALL)\n    assert len(bfs(grid, s, g)) == 6\n\n\ndef test_astar_matches_bfs():\n    grid, s, g = parse_maze(SMALL)\n    assert len(astar(grid, s, g)) == len(bfs(grid, s, g))\n',
	},
	files: [
		{
			path: 'search.py',
			parts: [
				'"""Project 2: graph search on a grid maze."""\n\nfrom collections import deque\nimport heapq\n\n\ndef parse_maze(text):\n    """Return (grid, start, goal). \'S\' is start, \'G\' is goal, \'#\' is a wall."""\n',
				{ body: '    grid = [list(line) for line in text.strip().splitlines()]\n    start = goal = None\n    for r, row in enumerate(grid):\n        for c, cell in enumerate(row):\n            if cell == "S":\n                start = (r, c)\n            elif cell == "G":\n                goal = (r, c)\n    if start is None or goal is None:\n        raise ValueError("maze needs an S and a G")\n    return grid, start, goal\n' },
				'\n\ndef neighbors(grid, cell):\n    """Yield open cells next to cell (up, down, left, right)."""\n',
				{ body: '    r, c = cell\n    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):\n        nr, nc = r + dr, c + dc\n        if 0 <= nr < len(grid) and 0 <= nc < len(grid[nr]) and grid[nr][nc] != "#":\n            yield (nr, nc)\n' },
				'\n\ndef bfs(grid, start, goal):\n    """Return the shortest path from start to goal as a list of cells, or None."""\n',
				{ body: '    queue = deque([start])\n    came_from = {start: None}\n    while queue:\n        cell = queue.popleft()\n        if cell == goal:\n            return rebuild_path(came_from, goal)\n        for nxt in neighbors(grid, cell):\n            if nxt not in came_from:\n                came_from[nxt] = cell\n                queue.append(nxt)\n    return None\n' },
				'\n\ndef astar(grid, start, goal):\n    """A* with Manhattan distance. Same path length as bfs, fewer expansions."""\n',
				{ body: '    def h(cell):\n        return abs(cell[0] - goal[0]) + abs(cell[1] - goal[1])\n\n    frontier = [(h(start), 0, start)]\n    came_from = {start: None}\n    cost = {start: 0}\n    while frontier:\n        _, g, cell = heapq.heappop(frontier)\n        if cell == goal:\n            return rebuild_path(came_from, goal)\n        for nxt in neighbors(grid, cell):\n            new_cost = g + 1\n            if new_cost < cost.get(nxt, float("inf")):\n                cost[nxt] = new_cost\n                came_from[nxt] = cell\n                heapq.heappush(frontier, (new_cost + h(nxt), new_cost, nxt))\n    return None\n' },
				'\n\ndef rebuild_path(came_from, goal):\n    """Walk came_from back from goal to the start."""\n',
				{ body: '    path = []\n    cell = goal\n    while cell is not None:\n        path.append(cell)\n        cell = came_from[cell]\n    return path[::-1]\n' },
			],
		},
		{
			path: 'benchmark.py',
			created: true,
			parts: [{ stub: '', body: 'import time\n\nfrom search import astar, bfs, parse_maze\n\n\ndef time_it(fn, *args):\n    start = time.perf_counter()\n    result = fn(*args)\n    return result, time.perf_counter() - start\n\n\nif __name__ == "__main__":\n    with open("mazes/large.txt") as f:\n        grid, start, goal = parse_maze(f.read())\n    for name, fn in (("bfs", bfs), ("astar", astar)):\n        path, secs = time_it(fn, grid, start, goal)\n        print(f"{name:6} length={len(path)} time={secs * 1000:.1f}ms")\n' }],
		},
	],
};

// ---- student simulation -------------------------------------------------------

type Profile = 'honest' | 'crammer' | 'borderline' | 'paster' | 'agent' | 'scripted' | 'partial' | 'started' | 'prejoin' | 'citer';

interface Item { file: FileSpec; idx: number; body: string }

class Student {
	spec: AssignmentSpec;
	sessions: { id: string; events: any[] }[] = [];
	private cur!: { id: string; seq: number; prev: string; events: any[] };
	private segs = new Map<string, string[]>();
	private exists = new Set<string>();
	private generated = new Map<string, string>(); // files Lineage writes (REFERENCES.md)
	private refs: string[] = [];
	t = 0;

	constructor(spec: AssignmentSpec) {
		this.spec = spec;
		for (const f of spec.files) {
			this.segs.set(f.path, f.parts.map((p) => (typeof p === 'string' ? p : p.stub ?? PASS)));
			if (!f.created) this.exists.add(f.path);
		}
	}

	items(): Item[] {
		return this.spec.files.flatMap((file) => file.parts.flatMap((p, idx) => (typeof p === 'string' ? [] : [{ file, idx, body: p.body }])));
	}

	text(path: string) {
		return this.segs.get(path)?.join('') ?? this.generated.get(path) ?? this.spec.extras[path];
	}

	files(): string[] {
		return [...Object.keys(this.spec.extras), '.lineage.json', ...this.exists, ...this.generated.keys()].sort();
	}

	/** What the instructor hands out: every file as it is before any work. */
	starterFiles(): Record<string, string> {
		return Object.fromEntries(this.files().map((p) => [p, this.fileText(p)]));
	}

	/** Solve items before ever opening Lineage (they show up in the first baseline). */
	prefill(list: Item[]) {
		for (const it of list) {
			this.segs.get(it.file.path)![it.idx] = it.body;
			this.exists.add(it.file.path);
		}
	}

	private fileText(path: string) {
		return path === '.lineage.json' ? `{\n  "assignmentId": "${this.spec.id}",\n  "server": "http://localhost:4747"\n}\n` : this.text(path)!;
	}

	push(fields: Record<string, unknown>, dt = 0) {
		this.t += dt;
		const body = { seq: this.cur.seq++, t: Math.round(this.t), ...fields, prev: this.cur.prev };
		const hash = hashEvent(this.cur.prev, body);
		this.cur.prev = hash;
		this.cur.events.push({ ...body, hash });
	}

	startSession(at: number) {
		this.t = at;
		const id = randomUUID();
		this.cur = { id, seq: 0, prev: genesis(id), events: [] };
		this.push({ kind: 'session', app: 'Lineage', version: '1.143.1', platform: chance(0.7) ? 'darwin' : 'win32' });
		for (const path of this.files()) this.push({ kind: 'baseline', file: path, text: this.fileText(path), initial: true }, 2);
		this.push({ kind: 'focus', focused: true }, between(500, 3000));
	}

	endSession() {
		this.push({ kind: 'focus', focused: false }, between(2000, 20_000));
		this.sessions.push(this.cur);
	}

	private offset(path: string, idx: number) {
		return this.segs.get(path)!.slice(0, idx).join('').length;
	}

	private ensureFile(item: Item) {
		if (this.exists.has(item.file.path)) return;
		// Creating a file in the editor writes an empty file to disk first.
		this.exists.add(item.file.path);
		this.push({ kind: 'external_write', file: item.file.path, text: '' }, between(1500, 6000));
	}

	private clearStub(item: Item, gap: () => number) {
		const segs = this.segs.get(item.file.path)!;
		if (!segs[item.idx]) return;
		this.push({ kind: 'delete', file: item.file.path, off: this.offset(item.file.path, item.idx), del: segs[item.idx].length, text: '' }, gap());
		segs[item.idx] = '';
	}

	private insert(item: Item, kind: string, text: string, dt: number) {
		const segs = this.segs.get(item.file.path)!;
		this.push({ kind, file: item.file.path, off: this.offset(item.file.path, item.idx) + segs[item.idx].length, del: 0, text }, dt);
		segs[item.idx] += text;
	}

	save(path: string) {
		this.push({ kind: 'save', file: path, sha256: sha256(this.text(path)!) }, between(300, 1500));
	}

	/** A person typing: variable rhythm, typos fixed with backspace, pauses to think, autocomplete. */
	typeHuman(item: Item, speed = 1) {
		this.ensureFile(item);
		this.clearStub(item, () => lognormal(900, 0.5));
		const body = item.body;
		const key = () => lognormal(135, 0.5) / speed;
		let k = 0;
		while (k < body.length) {
			const c = body[k];
			if (c === '\n') {
				let j = k + 1;
				while (body[j] === ' ') j++;
				let pause = lognormal(650, 0.6) / speed;
				if (chance(0.12)) pause = between(4000, 45_000);
				if (chance(0.008)) pause = between(120_000, 420_000);
				if (pause > 15_000) {
					this.push({ kind: 'focus', focused: false }, between(800, 3000));
					this.push({ kind: 'focus', focused: true }, pause);
					pause = between(300, 1200);
				}
				this.insert(item, 'typed', body.slice(k, j), pause);
				k = j;
				continue;
			}
			if (/[A-Za-z_]/.test(c) && (k === 0 || !/\w/.test(body[k - 1]))) {
				const word = /^\w+/.exec(body.slice(k))![0];
				if (word.length >= 7 && chance(0.35)) {
					for (let i = 0; i < 3; i++) this.insert(item, 'typed', word[i], key());
					this.insert(item, 'edit_other', word.slice(3), between(250, 700));
					k += word.length;
					continue;
				}
			}
			if (/[a-z]/.test(c) && chance(0.035)) {
				const wrong = 'asdfghjklqwertyuiop'[Math.floor(rand() * 19)];
				this.insert(item, 'typed', wrong, key());
				const segs = this.segs.get(item.file.path)!;
				segs[item.idx] = segs[item.idx].slice(0, -1);
				this.push({ kind: 'delete', file: item.file.path, off: this.offset(item.file.path, item.idx) + segs[item.idx].length, del: 1, text: '' }, lognormal(380, 0.4));
			}
			this.insert(item, 'typed', c, c === ' ' ? key() * 1.3 : key());
			k++;
		}
		this.save(item.file.path);
	}

	/** Copied from a browser: alt-tab out, come back, paste the whole block. */
	pasteExternal(item: Item) {
		this.ensureFile(item);
		this.push({ kind: 'focus', focused: false }, between(2000, 8000));
		this.push({ kind: 'focus', focused: true }, between(20_000, 120_000));
		this.clearStub(item, () => between(500, 1500));
		this.insert(item, 'paste_external', item.body, between(400, 1200));
		this.save(item.file.path);
	}

	/** Paste from outside, then cite it the way the recorder does: REFERENCES.md, a comment above the code, a cite event. */
	pasteCited(item: Item, source: { kind: string; author?: string; title: string; site?: string; url?: string }) {
		this.pasteExternal(item);
		const pasteSeq = this.cur.seq - 2; // pasteExternal ends with the paste, then a save
		const path = item.file.path;
		const accessed = new Date(this.t);
		const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
		const date = `${months[accessed.getMonth()]} ${accessed.getDate()}, ${accessed.getFullYear()}`;
		const n = this.refs.length + 1;
		const ref = `[${n}] ${source.author ? source.author + ', ' : ''}"${source.title}," ${source.site ? source.site + '. ' : ''}Accessed: ${date}. [Online]. Available: ${source.url}`;
		this.refs.push(ref);
		const refsText = `# References\n\nSources for code that came from outside this project, in IEEE style. Lineage adds an entry each time you cite a paste.\n\n${this.refs.join('\n')}\n`;
		this.generated.set('REFERENCES.md', refsText);
		this.push({ kind: 'citation_file', file: 'REFERENCES.md', text: refsText }, between(4000, 15_000));

		// Comment on its own line right above the first line of pasted code, with the same indentation.
		const full = this.text(path)!;
		const pasteAt = this.offset(path, item.idx) + (item.body.length - item.body.trimStart().length);
		const lineStart = full.lastIndexOf('\n', pasteAt - 1) + 1;
		const indent = full.slice(lineStart).match(/^[ \t]*/)![0];
		const comment = `${indent}# Source: ${ref}\n`;
		this.insertAt(path, lineStart, comment);
		this.push({ kind: 'citation', file: path, off: lineStart, del: 0, text: comment }, between(100, 400));
		this.push({ kind: 'cite', file: path, paste: pasteSeq, n, ref, source, off: lineStart + comment.length, len: item.body.length }, 50);
		this.save(path);
	}

	/** Insert text at an absolute offset in a file, keeping the segment bookkeeping right. */
	private insertAt(path: string, off: number, text: string) {
		const segs = this.segs.get(path)!;
		let pos = 0;
		for (let i = 0; i < segs.length; i++) {
			if (off <= pos + segs[i].length) {
				segs[i] = segs[i].slice(0, off - pos) + text + segs[i].slice(off - pos);
				return;
			}
			pos += segs[i].length;
		}
		segs[segs.length - 1] += text;
	}

	/** A script feeding keystrokes: metronome rhythm, no typos, no pauses. */
	typeScripted(item: Item) {
		this.ensureFile(item);
		this.clearStub(item, () => 60 + rand() * 4);
		for (const c of item.body) this.insert(item, 'typed', c, 60 + rand() * 4);
		this.save(item.file.path);
	}

	/** An agent in a terminal rewrites whole files on disk. `inLineage`: started from Lineage's own terminal. */
	agentWrites(items: Item[], tool: { id: string; name: string }, inLineage: boolean) {
		if (inLineage) this.push({ kind: 'agent', agent: tool.id, name: tool.name, state: 'start', scope: 'terminal', run: 1 }, between(3000, 10_000));
		else this.push({ kind: 'focus', focused: false }, between(3000, 10_000));
		const byFile = new Map<string, Item[]>();
		for (const it of items) byFile.set(it.file.path, [...(byFile.get(it.file.path) ?? []), it]);
		for (const [path, its] of byFile) {
			const segs = this.segs.get(path)!;
			for (const it of its) segs[it.idx] = it.body;
			this.exists.add(path);
			this.push({ kind: 'external_write', file: path, text: this.text(path) }, between(8000, 45_000));
		}
		if (inLineage) this.push({ kind: 'agent', agent: tool.id, name: tool.name, state: 'stop', scope: 'terminal', run: 1 }, between(20_000, 90_000));
		else this.push({ kind: 'focus', focused: true }, between(20_000, 90_000));
		if (tool.id === 'claude') this.push({ kind: 'agent_trace', agent: 'claude', name: 'Claude Code', where: 'session history for this project', inRepo: false, lastActive: Math.round(this.t) }, between(5000, 50_000));
	}

	submissionHashes() {
		return Object.fromEntries(this.files().filter((p) => p !== '.lineage.json').map((p) => [p, sha256(this.fileText(p))]));
	}
}

function sessionTimes(spec: AssignmentSpec, count: number, opts: { lastNight?: boolean } = {}): number[] {
	const release = NOW - spec.releasedDaysAgo * DAY;
	const end = Math.min(NOW - 0.3 * DAY, NOW + spec.dueInDays * DAY - 0.1 * DAY);
	const days = opts.lastNight
		? [end - 0.25 * DAY]
		: Array.from({ length: count }, () => between(release + 0.5 * DAY, end)).sort((a, b) => a - b);
	return days.map((d) => {
		const at = new Date(d);
		at.setHours(Math.floor(between(9, 22)), Math.floor(between(0, 59)));
		return at.getTime();
	}).sort((a, b) => a - b);
}

function chunk<T>(list: T[], parts: number): T[][] {
	const out: T[][] = Array.from({ length: parts }, () => []);
	list.forEach((x, i) => out[Math.min(parts - 1, Math.floor((i * parts) / list.length))].push(x));
	return out.filter((c) => c.length);
}

/** Returns the simulated student and whether they submitted. */
function simulate(spec: AssignmentSpec, profile: Profile): { s: Student; submitted: boolean } {
	const s = new Student(spec);
	const items = s.items();
	const human = (list: Item[], times: number[], speed = 1) => {
		chunk(list, times.length).forEach((group, i) => {
			s.startSession(times[i]);
			for (const it of group) s.typeHuman(it, speed);
			s.endSession();
		});
	};

	switch (profile) {
		case 'honest': {
			const n = 2 + Math.floor(rand() * 3);
			human(items, sessionTimes(spec, n), between(0.8, 1.3));
			return { s, submitted: true };
		}
		case 'crammer':
			human(items, sessionTimes(spec, 1, { lastNight: true }), 1.4);
			return { s, submitted: true };
		case 'borderline': {
			// Mostly honest, but one short function pasted from the web.
			const pasteIdx = items.findIndex((it) => it.body.length >= 80 && it.body.length <= 200);
			const times = sessionTimes(spec, 3);
			chunk(items.map((it, i) => ({ it, i })), times.length).forEach((group, gi) => {
				s.startSession(times[gi]);
				for (const { it, i } of group) i === pasteIdx ? s.pasteExternal(it) : s.typeHuman(it);
				s.endSession();
			});
			return { s, submitted: true };
		}
		case 'paster': {
			const times = sessionTimes(spec, 2);
			const cut = Math.ceil(items.length * 0.35);
			s.startSession(times[0]);
			for (const it of items.slice(0, cut)) s.typeHuman(it);
			s.endSession();
			s.startSession(times[1]);
			for (const it of items.slice(cut)) s.pasteExternal(it);
			s.endSession();
			return { s, submitted: true };
		}
		case 'agent': {
			const times = sessionTimes(spec, 2);
			s.startSession(times[0]);
			s.typeHuman(items[0]);
			s.endSession();
			s.startSession(times[1]);
			const tool = chance(0.6) ? { id: 'claude', name: 'Claude Code' } : { id: 'codex', name: 'Codex CLI' };
			s.agentWrites(items.slice(1), tool, chance(0.6));
			s.endSession();
			return { s, submitted: true };
		}
		case 'scripted': {
			const [t] = sessionTimes(spec, 1, { lastNight: true });
			s.startSession(t);
			for (const it of items) s.typeScripted(it);
			s.endSession();
			return { s, submitted: true };
		}
		case 'citer': {
			// Allowed to use AI with citation: types most of it, pastes two helpers and cites both.
			const picks = items.map((it, i) => ({ it, i })).filter(({ it }) => it.body.length >= 60).slice(-2).map(({ i }) => i);
			const sources = [
				{ kind: 'ai', author: 'OpenAI', title: 'ChatGPT', url: `https://chatgpt.com/share/${randomBytes(8).toString('hex')}` },
				{ kind: 'qa', site: 'Stack Overflow', title: 'How do I count word frequencies in python', url: 'https://stackoverflow.com/questions/20510768/how-do-i-count-word-frequencies-in-python' },
			];
			const times = sessionTimes(spec, 3);
			chunk(items.map((it, i) => ({ it, i })), times.length).forEach((group, gi) => {
				s.startSession(times[gi]);
				for (const { it, i } of group) picks.includes(i) ? s.pasteCited(it, sources[picks.indexOf(i)]) : s.typeHuman(it);
				s.endSession();
			});
			return { s, submitted: true };
		}
		case 'prejoin': {
			// Did most of the work (e.g. with an agent) before joining, then typed the rest in Lineage.
			const cut = Math.ceil(items.length * 0.7);
			s.prefill(items.slice(0, cut));
			human(items.slice(cut), sessionTimes(spec, 1, { lastNight: true }));
			return { s, submitted: true };
		}
		case 'partial': {
			const done = items.slice(0, Math.max(1, Math.ceil(items.length * between(0.3, 0.75))));
			human(done, sessionTimes(spec, 1 + Math.floor(rand() * 2)));
			return { s, submitted: false };
		}
		case 'started': {
			human(items.slice(0, 1), sessionTimes(spec, 1));
			return { s, submitted: false };
		}
	}
}

// ---- write the database -------------------------------------------------------

const NAMES = [
	'aokafor3', 'bchen42', 'cdiaz7', 'dpatel19', 'eschmidt2', 'fnakamura', 'gwilliams8', 'hkim21', 'iromero5', 'jlee33',
	'kmensah4', 'lgarcia12', 'mnguyen6', 'nsingh27', 'oadeyemi', 'pkowalski', 'qzhang11', 'rjohnson9', 'sahmed14', 'tbrown3',
	'umorales', 'vrossi18', 'wtanaka2', 'xliu25', 'yokonkwo', 'zmuller7', 'abaker15', 'bsato4', 'cmartin22', 'dhughes6',
	'eali31', 'fevans10', 'gpark17', 'hcohen5', 'iwalker8', 'jsantos26', 'kfischer', 'lmoore13', 'mreyes20', 'nbianchi',
];

const dir = resolve(process.argv[2] ?? 'data-demo');
rmSync(dir, { recursive: true, force: true });
const keys = loadOrCreateKeys(dir);
const db = openDb(dir);

createCourse(db, 'cs101', 'CS 101 · Intro to Programming');
createCourse(db, 'cs210', 'CS 210 · Data Structures & Algorithms');

const rep = (p: Profile, n: number): Profile[] => Array(n).fill(p);
const specs: AssignmentSpec[] = [
	{ ...HW3, profiles: [...rep('honest', 6), 'citer', 'prejoin', 'crammer', 'borderline', 'paster', 'agent', 'honest', 'partial'] },
	{ ...HW4, profiles: [...rep('honest', 3), ...rep('partial', 7), ...rep('started', 2), 'agent', 'paster'] },
	{ ...P2, profiles: [...rep('honest', 6), 'citer', 'agent', 'agent', 'crammer', 'borderline'] },
];

let totalEvents = 0;
let nameIdx = 0;
const insertEnroll = db.prepare('INSERT INTO enrollments (token, assignment_id, student_id, created_at) VALUES (?, ?, ?, ?)');
const insertSession = db.prepare('INSERT INTO sessions (id, token, first_seen, last_seq, last_hash) VALUES (?, ?, ?, ?, ?)');
const insertEvent = db.prepare('INSERT INTO events (session_id, seq, server_t, json) VALUES (?, ?, ?, ?)');
const insertSubmission = db.prepare('INSERT INTO submissions (token, server_t, files) VALUES (?, ?, ?)');
const insertReview = db.prepare('INSERT INTO reviews (assignment_id, student_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)');
const roster: Record<string, { name: string; profile: Profile }[]> = {};

for (const spec of specs) {
	createAssignment(db, spec.id, { courseId: spec.course, title: spec.title, dueAt: NOW + spec.dueInDays * DAY });
	addStarterVersion(db, spec.id, new Student(spec).starterFiles());
	roster[spec.id] = [];
	// Shuffle profiles so the suspicious students aren't all at the end of the roster.
	const profiles = [...spec.profiles].sort(() => rand() - 0.5);
	db.exec('BEGIN');
	for (const profile of profiles) {
		const name = NAMES[nameIdx++ % NAMES.length];
		roster[spec.id].push({ name, profile });
		const token = randomBytes(24).toString('base64url');
		const { s, submitted } = simulate(spec, profile);
		insertEnroll.run(token, spec.id, name, s.sessions[0].events[0].t);
		for (const session of s.sessions) {
			const last = session.events[session.events.length - 1];
			insertSession.run(session.id, token, session.events[0].t, last.seq, last.hash);
			for (const ev of session.events) insertEvent.run(session.id, ev.seq, ev.t + Math.round(between(80, 2500)), JSON.stringify(ev));
			totalEvents += session.events.length;
		}
		if (submitted) insertSubmission.run(token, Math.round(s.t + between(60_000, 1_800_000)), JSON.stringify(s.submissionHashes()));
	}
	db.exec('COMMIT');
}

// A few reviews already done, so the queue shows statuses.
const find = (a: string, p: Profile) => roster[a].find((r) => r.profile === p)?.name;
const b = find('cs101-hw3', 'borderline');
if (b) insertReview.run('cs101-hw3', b, 'cleared', 'Pasted helper is cited in a comment and matches the hint from office hours. Fine.', NOW - DAY);
const ag = find('cs101-hw3', 'agent');
if (ag) insertReview.run('cs101-hw3', ag, 'follow_up', 'Most of stats.py appeared in one write. Asked to meet Thursday.', NOW - DAY / 2);

console.log(`Seeded ${dir}: ${specs.length} assignments, ${nameIdx} students, ${totalEvents.toLocaleString()} events.`);
for (const spec of specs) console.log(`  ${spec.id}: ${roster[spec.id].map((r) => `${r.name}=${r.profile}`).join(', ')}`);
console.log(`Admin key: ${keys.adminKey}`);
