import * as vscode from 'vscode';
import { AgentTraces, identifyCommand } from './agents';
import { Recorder } from './recorder';
import { Transport, seal } from './transport';

interface AssignmentConfig {
	assignmentId: string;
	server: string;
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
	log.appendLine(`Recording ${config.assignmentId} as ${enrollment.studentId}, session ${transport.sessionId}`);

	setStatus('$(record) Lineage', `Recording "${config.assignmentId}" as ${enrollment.studentId}`, 'lineage.status');
	const refresh = setInterval(() => {
		if (!transport) return;
		if (transport.lastError) setStatus('$(cloud-upload) Lineage (offline)', transport.lastError, 'lineage.status');
		else setStatus('$(record) Lineage', `Recording "${config.assignmentId}" as ${enrollment!.studentId}`, 'lineage.status');
	}, 5000);
	context.subscriptions.push({ dispose: () => clearInterval(refresh) });
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
