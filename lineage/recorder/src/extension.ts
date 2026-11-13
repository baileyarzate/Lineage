import * as vscode from 'vscode';
import { AgentTraces, identifyCommand } from './agents';
import { Recorder, type ExternalPaste } from './recorder';
import { AI_TOOLS, REFERENCES_FILE, addReference, citationComment, parseSource, type Source } from './citations';
import { Transport, seal } from './transport';

interface AssignmentConfig {
	assignmentId: string;
	server: string;
	/** Instructor settings for citing outside code. Defaults: ask after each outside paste, IEEE style. */
	citations?: { prompt?: boolean; style?: 'ieee' };
}

interface Enrollment {
	token: string;
	publicKey: string;
	studentId: string;
}

let recorder: Recorder | undefined;
let transport: Transport | undefined;
let agents: AgentTraces | undefined;
let status: vscode.StatusBarItem;
let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel('Lineage');
	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = 'lineage.status';
	context.subscriptions.push(log, status);

	context.subscriptions.push(
		vscode.commands.registerCommand('lineage.join', () => joinAndStart(context, true)),
		vscode.commands.registerCommand('lineage.submit', () => submit(context)),
		vscode.commands.registerCommand('lineage.status', () => showStatus(context)),
		vscode.commands.registerCommand('lineage.citeSelection', () => citeSelection()),
	);

	// Don't await: the join prompt waits on the user, and VS Code holds back this
	// extension's commands (status bar clicks included) until activate() returns.
	void joinAndStart(context, false).catch((err) => log.appendLine(`startup failed: ${err}`));
}

export async function deactivate() {
	agents?.dispose();
	recorder?.dispose();
	await transport?.stop();
}

async function findAssignment(): Promise<{ root: vscode.Uri; config: AssignmentConfig } | undefined> {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const uri = vscode.Uri.joinPath(folder.uri, '.lineage.json');
		try {
			const config = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
			if (config.assignmentId && config.server) return { root: folder.uri, config };
		} catch {
			// not an assignment folder
		}
	}
	return undefined;
}

function enrollmentKey(config: AssignmentConfig) {
	return `lineage.enrollment:${config.server}:${config.assignmentId}`;
}

async function getEnrollment(context: vscode.ExtensionContext, config: AssignmentConfig): Promise<Enrollment | undefined> {
	const raw = await context.secrets.get(enrollmentKey(config));
	return raw ? JSON.parse(raw) : undefined;
}

async function joinAndStart(context: vscode.ExtensionContext, force: boolean) {
	const found = await findAssignment();
	if (!found) {
		if (force) vscode.window.showErrorMessage('Lineage: no .lineage.json found in this workspace.');
		return;
	}
	const { root, config } = found;

	let enrollment = force ? undefined : await getEnrollment(context, config);
	if (!enrollment) {
		setStatus('$(circle-slash) Lineage: not joined', 'Click to join this assignment', 'lineage.join');
		if (!force) {
			const pick = await vscode.window.showInformationMessage(
				`This project is the Lineage assignment "${config.assignmentId}". Join to record your work and prove you wrote it.`,
				'Join', 'Not now');
			if (pick !== 'Join') return;
		}
		enrollment = await join(config);
		if (!enrollment) return;
		await context.secrets.store(enrollmentKey(config), JSON.stringify(enrollment));
	}

	if (recorder) return; // already recording
	transport = new Transport({
		server: config.server,
		token: enrollment.token,
		publicKey: enrollment.publicKey,
		spoolDir: context.globalStorageUri.fsPath,
		spoolName: Buffer.from(enrollmentKey(config)).toString('base64url'),
		log: (m) => log.appendLine(m),
	});
	recorder = new Recorder(root, transport);
	await recorder.start();
	transport.start();
	// Agent evidence goes only into the encrypted stream; nothing about it is shown or logged locally.
	const t = transport;
	const rec = recorder;
	agents = new AgentTraces(root.fsPath, () => rec.trackedFolders(), (fields) => t.record(fields));
	agents.start();
	context.subscriptions.push(recorder, agents, watchTerminal((fields) => t.record(fields)));
	if (config.citations?.prompt !== false) rec.onExternalPaste = askToCite;
	void vscode.commands.executeCommand('setContext', 'lineage.recording', true);
	log.appendLine(`Recording ${config.assignmentId} as ${enrollment.studentId}, session ${transport.sessionId}`);

	setStatus('$(record) Lineage', `Recording "${config.assignmentId}" as ${enrollment.studentId}`, 'lineage.status');
	const refresh = setInterval(() => {
		if (!transport) return;
		if (transport.lastError) setStatus('$(cloud-upload) Lineage (offline)', transport.lastError, 'lineage.status');
		else setStatus('$(record) Lineage', `Recording "${config.assignmentId}" as ${enrollment!.studentId}`, 'lineage.status');
	}, 5000);
	context.subscriptions.push({ dispose: () => clearInterval(refresh) });
}

// ---- citations ---------------------------------------------------------------
// After an outside paste, a small notification in the corner offers to cite it. Citing adds an IEEE
// reference to REFERENCES.md and a comment above the pasted code. It never blocks typing.

let pendingPaste: ExternalPaste | undefined;
let asking = false;

function askToCite(paste: ExternalPaste) {
	pendingPaste = paste; // a newer paste replaces one that hasn't been answered yet
	if (asking) return;
	asking = true;
	void (async () => {
		try {
			while (pendingPaste) {
				const p: ExternalPaste = pendingPaste;
				const lines = p.text.split('\n').filter((l) => l.trim()).length;
				const pick = await vscode.window.showInformationMessage(
					`Pasted ${lines === 1 ? 'a line' : `${lines} lines`} into ${p.file} from outside the project. Want to cite where it came from?`,
					'Add source', 'Skip');
				if (pendingPaste === p) pendingPaste = undefined;
				if (pick === 'Add source') await cite(p.uri, p.file, p.text, p.off, p.seq);
			}
		} finally {
			asking = false;
		}
	})();
}

async function citeSelection() {
	const editor = vscode.window.activeTextEditor;
	const file = editor && recorder?.relPath(editor.document.uri);
	if (!editor || !recorder || !file) {
		vscode.window.showErrorMessage('Lineage: open a file in the assignment (and join it) to cite code.');
		return;
	}
	const sel = editor.selection;
	if (sel.isEmpty) {
		vscode.window.showInformationMessage('Lineage: select the code you want to cite first.');
		return;
	}
	const text = editor.document.getText(sel);
	await cite(editor.document.uri, file, text, editor.document.offsetAt(sel.start));
}

async function pickSource(): Promise<Source | undefined> {
	type Item = vscode.QuickPickItem & { id: string };
	const items: Item[] = [
		{ id: 'link', label: '$(link) Paste a link', description: 'ChatGPT or Claude share link, Stack Overflow, GitHub, docs…' },
		{ id: '', label: 'Or pick a tool (no link)', kind: vscode.QuickPickItemKind.Separator },
		...Object.entries(AI_TOOLS).map(([id, s]) => ({ id, label: s.title, description: s.author })),
		{ id: 'other', label: '$(edit) Something else', description: 'a book, a class handout, a person…' },
	];
	const pick = await vscode.window.showQuickPick(items, { title: 'Where did this code come from?', placeHolder: 'Choose a source', ignoreFocusOut: true });
	if (!pick) return undefined;
	if (pick.id === 'link') {
		const url = await vscode.window.showInputBox({
			title: 'Link to the source',
			placeHolder: 'https://chatgpt.com/share/…  or  https://stackoverflow.com/questions/…',
			ignoreFocusOut: true,
			validateInput: (v) => (parseSource(v)?.url ? undefined : 'Paste a full link (https://…)'),
		});
		return url ? parseSource(url) : undefined;
	}
	if (pick.id === 'other') {
		const name = await vscode.window.showInputBox({ title: 'Describe the source', placeHolder: 'e.g. CS 1332 lecture 4 slides', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Required') });
		return name ? { kind: 'other', title: name.trim() } : undefined;
	}
	return { ...AI_TOOLS[pick.id] };
}

async function cite(uri: vscode.Uri, file: string, text: string, off: number, pasteSeq?: number) {
	const rec = recorder;
	if (!rec) return;
	const source = await pickSource();
	if (!source) return;
	try {
		const { text: refs, n, ref, reused } = addReference(await rec.currentText(REFERENCES_FILE), source, new Date());
		if (!reused) await rec.writeGenerated(REFERENCES_FILE, refs);

		// Comment above the cited code, in the file's own language.
		const doc = await vscode.workspace.openTextDocument(uri);
		const at = locate(doc.getText(), text, off);
		const comment = citationComment(doc.languageId, ref);
		let commented = false;
		if (comment) {
			// Pasted text often starts with blank lines: put the comment right above the first line of code.
			const lead = text.length - text.trimStart().length;
			const line = doc.lineAt(doc.positionAt(Math.min(at + lead, doc.getText().length)).line);
			const above = line.lineNumber > 0 ? doc.lineAt(line.lineNumber - 1).text.trim() : '';
			if (above !== comment) {
				const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
				const insert = `${indent}${comment}\n`;
				rec.expectCitation(file, insert);
				const edit = new vscode.WorkspaceEdit();
				edit.insert(uri, new vscode.Position(line.lineNumber, 0), insert);
				commented = await vscode.workspace.applyEdit(edit);
			}
		}
		rec.recordCite({ file, paste: pasteSeq, n, ref, source, off: at, len: text.length });
		const where = commented ? `Added a comment above the code and listed it in ${REFERENCES_FILE}` : `Listed it in ${REFERENCES_FILE}`;
		vscode.window.showInformationMessage(`Lineage: cited as [${n}]${reused ? ' (same source as before)' : ''}. ${where}.`);
	} catch (err) {
		vscode.window.showErrorMessage(`Lineage: couldn't add the citation (${(err as Error).message}).`);
	}
}

/** Where `text` is now in `doc`, preferring the occurrence closest to where it was pasted. */
function locate(doc: string, text: string, near: number): number {
	let best = -1;
	for (let i = doc.indexOf(text); i >= 0; i = doc.indexOf(text, i + 1)) {
		if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
	}
	return best >= 0 ? best : Math.max(0, Math.min(near, doc.length));
}

/**
 * Records when a known AI agent is started from Lineage's own terminal.
 * Uses the editor's shell integration, so it only sees commands typed in this editor.
 */
function watchTerminal(record: (fields: { [k: string]: unknown }) => void): vscode.Disposable {
	const running = new Map<vscode.TerminalShellExecution, { id: string; name: string; run: number }>();
	let runs = 0;
	return vscode.Disposable.from(
		vscode.window.onDidStartTerminalShellExecution((e) => {
			const agent = identifyCommand(e.execution.commandLine.value);
			if (!agent) return;
			const run = ++runs;
			running.set(e.execution, { id: agent.id, name: agent.name, run });
			record({ kind: 'agent', agent: agent.id, name: agent.name, state: 'start', scope: 'terminal', run });
		}),
		vscode.window.onDidEndTerminalShellExecution((e) => {
			const r = running.get(e.execution);
			if (!r) return;
			running.delete(e.execution);
			record({ kind: 'agent', agent: r.id, name: r.name, state: 'stop', scope: 'terminal', run: r.run });
		}),
	);
}

async function join(config: AssignmentConfig): Promise<Enrollment | undefined> {
	const studentId = await vscode.window.showInputBox({
		title: `Join ${config.assignmentId} (1/2): your student ID`,
		prompt: 'Your username or student ID, as your instructor knows you (not the join code)',
		placeHolder: 'e.g. gburdell3',
		ignoreFocusOut: true,
		validateInput: (v) => (v.trim() ? undefined : 'Required'),
	});
	if (!studentId) return undefined;
	const joinCode = await vscode.window.showInputBox({
		title: `Join ${config.assignmentId} (2/2): join code`,
		prompt: 'The 8-character join code from your instructor',
		placeHolder: 'e.g. 1A2B3C4D',
		ignoreFocusOut: true,
		validateInput: (v) => (v.trim() ? undefined : 'Required'),
	});
	if (!joinCode) return undefined;

	try {
		const res = await fetch(config.server.replace(/\/$/, '') + '/api/join', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ assignmentId: config.assignmentId, joinCode: joinCode.trim(), studentId: studentId.trim() }),
		});
		const body = (await res.json()) as any;
		if (!res.ok) {
			vscode.window.showErrorMessage(`Lineage: couldn't join (${body.error ?? res.status}).`);
			return undefined;
		}
		vscode.window.showInformationMessage(`Lineage: joined "${config.assignmentId}". Your work is now being recorded.`);
		return { token: body.token, publicKey: body.publicKey, studentId: studentId.trim() };
	} catch (err) {
		vscode.window.showErrorMessage(`Lineage: couldn't reach ${config.server} (${(err as Error).message}).`);
		return undefined;
	}
}

async function submit(context: vscode.ExtensionContext) {
	const found = await findAssignment();
	const enrollment = found && (await getEnrollment(context, found.config));
	if (!found || !enrollment || !recorder || !transport) {
		vscode.window.showErrorMessage('Lineage: join the assignment before submitting.');
		return;
	}
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Lineage: submitting…' }, async () => {
		const files = await recorder!.snapshotHashes();
		await transport!.flush();
		if (transport!.lastError) {
			vscode.window.showErrorMessage(`Lineage: can't submit while offline. ${transport!.lastError}`);
			return;
		}
		const res = await transport!.post('/api/submit', JSON.stringify({ envelope: seal(enrollment.publicKey, { files }) })).catch((e: Error) => e);
		if (res instanceof Error || !res.ok) {
			vscode.window.showErrorMessage(`Lineage: submit failed (${res instanceof Error ? res.message : res.status}).`);
			return;
		}
		vscode.window.showInformationMessage(`Lineage: submitted ${Object.keys(files).length} files for "${found.config.assignmentId}".`);
	});
}

async function showStatus(context: vscode.ExtensionContext) {
	const found = await findAssignment();
	const enrollment = found && (await getEnrollment(context, found.config));
	if (!found || !enrollment || !transport || !recorder) {
		vscode.commands.executeCommand('lineage.join');
		return;
	}
	const lines = [
		`Assignment: ${found.config.assignmentId}`,
		`Student: ${enrollment.studentId}`,
		`Tracking ${recorder.trackedFiles} files · ${transport.sent} batches uploaded · ${transport.pending} events queued`,
		transport.lastError ? `⚠ ${transport.lastError}` : 'Connected',
		'Lineage records edits to files in this project, and notes when AI coding agents run in this project folder. No camera, no microphone, nothing outside this project.',
		'Recordings are encrypted for your instructor\'s server; they can\'t be read on this computer.',
	];
	const pick = await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, 'Submit now');
	if (pick === 'Submit now') vscode.commands.executeCommand('lineage.submit');
}

function setStatus(text: string, tooltip: string, command: string) {
	status.text = text;
	status.tooltip = tooltip;
	status.command = command;
	status.show();
}
