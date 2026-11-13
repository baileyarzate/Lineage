import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addReference, citationComment, formatIEEE, ieeeDate, parseReferences, parseSource } from '../src/citations.ts';

const DAY = new Date(2026, 10, 12); // Nov. 12, 2026

test('recognizes AI share links and bare tool names', () => {
	assert.deepEqual(parseSource('https://chatgpt.com/share/abc123'), { kind: 'ai', author: 'OpenAI', title: 'ChatGPT', url: 'https://chatgpt.com/share/abc123' });
	assert.equal(parseSource('chat.openai.com/share/x')?.title, 'ChatGPT');
	assert.equal(parseSource('https://claude.ai/share/1f2e')?.author, 'Anthropic');
	assert.equal(parseSource('https://gemini.google.com/share/99')?.title, 'Gemini');
	assert.deepEqual(parseSource('Claude'), { kind: 'ai', author: 'Anthropic', title: 'Claude' });
});

test('reads Stack Overflow and Stack Exchange titles from the link', () => {
	const so = parseSource('https://stackoverflow.com/questions/3940128/how-do-i-reverse-a-list-in-python?noredirect=1');
	assert.equal(so?.kind, 'qa');
	assert.equal(so?.site, 'Stack Overflow');
	assert.equal(so?.title, 'How do I reverse a list in python');
	assert.equal(so?.author, undefined);
	assert.equal(parseSource('https://unix.stackexchange.com/questions/1/what-is-a-shell')?.site, 'Unix Stack Exchange');
	assert.equal(parseSource('https://stackoverflow.com/a/12345')?.title, 'Stack Overflow question');
});

test('GitHub repos, gists and other pages', () => {
	assert.deepEqual(parseSource('https://github.com/psf/requests/blob/main/src/api.py'),
		{ kind: 'code', author: 'psf', title: 'requests', site: 'GitHub', url: 'https://github.com/psf/requests/blob/main/src/api.py' });
	assert.equal(parseSource('https://gist.github.com/someone/abc')?.title, 'Gist');
	const docs = parseSource('https://docs.python.org/3/library/collections.html');
	assert.equal(docs?.site, 'docs.python.org');
	assert.equal(docs?.title, 'Collections');
	assert.equal(parseSource('www.geeksforgeeks.org/')?.title, 'geeksforgeeks.org');
});

test('rejects things that are not sources', () => {
	for (const bad of ['', '   ', 'hello world', 'ftp://example.com/x', 'javascript:alert(1)', 'localhost']) assert.equal(parseSource(bad), undefined, bad);
});

test('formats IEEE website references', () => {
	assert.equal(ieeeDate(DAY), 'Nov. 12, 2026');
	assert.equal(ieeeDate(new Date(2026, 4, 3)), 'May 3, 2026');
	assert.equal(formatIEEE(parseSource('https://chatgpt.com/share/abc')!, 1, DAY),
		'[1] OpenAI, "ChatGPT," Accessed: Nov. 12, 2026. [Online]. Available: https://chatgpt.com/share/abc');
	assert.equal(formatIEEE(parseSource('chatgpt')!, 2, DAY),
		'[2] OpenAI, "ChatGPT," Accessed: Nov. 12, 2026. Generative AI tool; no shared link provided.');
	assert.equal(formatIEEE(parseSource('https://stackoverflow.com/questions/1/how-to-sort-a-dict')!, 3, DAY),
		'[3] "How to sort a dict," Stack Overflow. Accessed: Nov. 12, 2026. [Online]. Available: https://stackoverflow.com/questions/1/how-to-sort-a-dict');
	assert.equal(formatIEEE(parseSource('https://github.com/psf/requests')!, 4, DAY),
		'[4] psf, "requests," GitHub. Accessed: Nov. 12, 2026. [Online]. Available: https://github.com/psf/requests');
	assert.equal(formatIEEE({ kind: 'other', title: 'CS 1332 lecture 4 slides' }, 5, DAY), '[5] "CS 1332 lecture 4 slides," Accessed: Nov. 12, 2026.');
});

test('citation comments use the file language', () => {
	assert.equal(citationComment('python', '[1] x'), '# Source: [1] x');
	assert.equal(citationComment('java', '[1] x'), '// Source: [1] x');
	assert.equal(citationComment('sql', '[1] x'), '-- Source: [1] x');
	assert.equal(citationComment('html', '[1] x'), '<!-- Source: [1] x -->');
	assert.equal(citationComment('css', '[1] x'), '/* Source: [1] x */');
	assert.equal(citationComment('plaintext', '[1] x'), undefined);
	assert.equal(citationComment('json', '[1] x'), undefined);
});

test('REFERENCES.md: numbers new sources and reuses repeated ones', () => {
	const a = addReference(undefined, parseSource('https://chatgpt.com/share/abc')!, DAY);
	assert.equal(a.n, 1);
	assert.equal(a.reused, false);
	assert.match(a.text, /^# References\n/);
	const b = addReference(a.text, parseSource('https://stackoverflow.com/questions/1/x')!, DAY);
	assert.equal(b.n, 2);
	const again = addReference(b.text, parseSource('https://chatgpt.com/share/abc')!, DAY);
	assert.deepEqual([again.n, again.reused, again.text], [1, true, b.text]);
	// A tool without a link reuses its own entry, but not the linked one.
	const tool = addReference(b.text, parseSource('chatgpt')!, DAY);
	assert.deepEqual([tool.n, tool.reused], [3, false]);
	assert.deepEqual([addReference(tool.text, parseSource('ChatGPT')!, DAY).n, addReference(tool.text, parseSource('ChatGPT')!, DAY).reused], [3, true]);
	assert.deepEqual([...parseReferences(tool.text).keys()], [1, 2, 3]);
	// Student-edited file: numbering continues after the highest number present.
	assert.equal(addReference('My refs\n\n[7] something\n', parseSource('claude')!, DAY).n, 8);
});
