// Watches the workspace and classifies every change by where it came from.
//
//   typed           inside a `type` command (real keystrokes in the editor)
//   paste_internal  paste whose text was copied inside the editor
//   paste_external  paste whose text came from somewhere else
//   undo_redo       undo / redo
//   edit_other      editor-made edits right after user input (autocomplete, format, snippets)
//   delete          removals (attribution doesn't matter: nothing is inserted)
//   programmatic    edit to an open document with no user input nearby (another extension)
//   external_write  file changed on disk by another program (agents, scripts, other editors)
//   baseline        file contents when the session starts
//
// The recorder keeps a shadow copy of every tracked file, so it can tell its own
// saves apart from writes by other programs.
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { Transport } from './transport';

const EXCLUDE_DIRS = ['node_modules', '.git', 'out', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode-test', 'target'];
const EXCLUDE_GLOB = `{${EXCLUDE_DIRS.map((d) => `**/${d}/**`).join(',')}}`;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;

const TYPE_WINDOW_MS = 200; // change must arrive this soon after a keystroke to count as typed
const ACTIVITY_WINDOW_MS = 1500; // editor-made edits shortly after user input
const PASTE_WINDOW_MS = 1500;

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const normalize = (s: string) => s.replace(/\r\n/g, '\n');

export class Recorder implements vscode.Disposable {
	private root: vscode.Uri;
	private transport: Transport;
	private shadow = new Map<string, string>();
	private disposables: vscode.Disposable[] = [];

	private lastTypeAt = 0;
	private lastActivityAt = 0;
	private pendingPaste: { text: string; internal: boolean; at: number } | undefined;
	private copied = new Set<string>(); // hashes of text copied inside the editor

	constructor(root: vscode.Uri, transport: Transport) {
		this.root = root;
		this.transport = transport;
	}

	async start() {
		this.transport.record({ kind: 'session', app: vscode.env.appName, version: vscode.version, platform: process.platform });
		this.registerInputHooks();
		await this.scan();
		this.registerListeners();
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose());
	}

	get trackedFiles() {
		return this.shadow.size;
	}

	/** Project-relative folders that contain tracked files ('src', 'src/utils', ...). */
	trackedFolders(): string[] {
		const out = new Set<string>();
		for (const path of this.shadow.keys()) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
		}
		return [...out];
	}

	// ---- startup -------------------------------------------------------------

	private async scan() {
		const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, '**/*'), EXCLUDE_GLOB, MAX_FILES);
		uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		for (const uri of uris) {
			const rel = this.rel(uri);
			const text = rel && (await readText(uri));
			if (!rel || text === undefined) continue;
			// If the file is open with unsaved changes, what the student sees is the editor copy.
			const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && d.isDirty);
			const content = open ? open.getText() : text;
			this.shadow.set(rel, content);
			this.transport.record({ kind: 'baseline', file: rel, text: content, initial: true });
		}
	}

	// ---- user input signals --------------------------------------------------

	private registerInputHooks() {
		// Wrap the editor's `type` command: every keystroke that inserts text goes through it.
		// Only one extension can own `type`; in Lineage that's us.
		try {
			this.disposables.push(vscode.commands.registerCommand('type', (args: { text: string }) => {
				this.lastTypeAt = this.lastActivityAt = Date.now();
				return vscode.commands.executeCommand('default:type', args);
			}));
		} catch (err) {
			vscode.window.showWarningMessage('Lineage: another extension is intercepting typing, so keystrokes may be misclassified.');
		}

		this.disposables.push(
			vscode.commands.registerCommand('lineage.copy', async () => {
				this.rememberSelection();
				await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
			}),
			vscode.commands.registerCommand('lineage.cut', async () => {
				this.rememberSelection();
				this.lastActivityAt = Date.now();
				await vscode.commands.executeCommand('editor.action.clipboardCutAction');
			}),
			vscode.commands.registerCommand('lineage.paste', async () => {
				const text = normalize(await vscode.env.clipboard.readText());
				this.pendingPaste = { text, internal: this.copied.has(hash(text.trim())), at: Date.now() };
				this.lastActivityAt = Date.now();
				await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
			}),
		);
	}

	private rememberSelection() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const text = editor.selections.map((s) => editor.document.getText(s)).join('\n');
		if (text) this.copied.add(hash(normalize(text).trim()));
		if (this.copied.size > 5000) this.copied.clear();
	}

	// ---- change tracking -----------------------------------------------------

	private registerListeners() {
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
					this.lastActivityAt = Date.now();
				}
			}),
			vscode.workspace.onWillSaveTextDocument(() => {
				this.lastActivityAt = Date.now(); // format-on-save edits follow
			}),
			vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				const rel = this.rel(doc.uri);
				if (!rel || !this.shadow.has(rel)) return;
				const text = doc.getText();
				this.shadow.set(rel, text);
				this.transport.record({ kind: 'save', file: rel, sha256: hash(text) });
			}),
			vscode.workspace.onWillRenameFiles((e) => {
				// Move shadow entries now, so the watcher sees the renamed file as already known.
				for (const { oldUri, newUri } of e.files) {
					const from = this.rel(oldUri);
					const to = this.rel(newUri);
					if (!from || !to) continue;
					for (const [path, text] of [...this.shadow]) {
						if (path === from || path.startsWith(from + '/')) {
							const dest = to + path.slice(from.length);
							this.shadow.delete(path);
							this.shadow.set(dest, text);
							this.transport.record({ kind: 'rename', file: path, to: dest });
						}
					}
				}
			}),
			vscode.window.onDidChangeWindowState((s) => {
				this.transport.record({ kind: 'focus', focused: s.focused });
			}),
		);

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
		this.disposables.push(
			watcher,
			watcher.onDidCreate((uri) => this.onDiskChange(uri)),
			watcher.onDidChange((uri) => this.onDiskChange(uri)),
			watcher.onDidDelete((uri) => {
				const rel = this.rel(uri);
				if (!rel) return;
				for (const path of [...this.shadow.keys()]) {
					if (path === rel || path.startsWith(rel + '/')) {
						this.shadow.delete(path);
						this.transport.record({ kind: 'external_write', file: path, deleted: true });
					}
				}
			}),
		);
	}

	private onDocumentChange(e: vscode.TextDocumentChangeEvent) {
		const rel = this.rel(e.document.uri);
		if (!rel || !e.contentChanges.length || !this.shadow.has(rel)) return;
		const now = Date.now();
		const after = e.document.getText();

		// Not dirty afterwards and not an undo/redo back to the saved state:
		// VS Code reloaded the file because another program rewrote it on disk.
		if (!e.document.isDirty && e.reason === undefined) {
			if (this.shadow.get(rel) !== after) {
				this.shadow.set(rel, after);
				this.transport.record({ kind: 'external_write', file: rel, text: after });
			}
			return;
		}

		for (const change of e.contentChanges) {
			const text = change.text;
			const kind = this.classify(text, e.reason, now);
			this.transport.record({ kind, file: rel, off: change.rangeOffset, del: change.rangeLength, text });
		}
		this.shadow.set(rel, after);
		if (this.pendingPaste && now - this.pendingPaste.at > PASTE_WINDOW_MS) this.pendingPaste = undefined;
	}

	private classify(text: string, reason: vscode.TextDocumentChangeReason | undefined, now: number): string {
		if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) return 'undo_redo';
		if (text === '') return 'delete';
		const paste = this.pendingPaste;
		const t = normalize(text).trim();
		if (paste && now - paste.at < PASTE_WINDOW_MS && t.length > 1 && (paste.text.includes(t) || t.includes(paste.text.trim()))) {
			return paste.internal ? 'paste_internal' : 'paste_external';
		}
		if (now - this.lastTypeAt < TYPE_WINDOW_MS) return 'typed';
		if (now - this.lastActivityAt < ACTIVITY_WINDOW_MS) return 'edit_other';
		return 'programmatic';
	}

	private async onDiskChange(uri: vscode.Uri) {
		const rel = this.rel(uri);
		if (!rel) return;
		// Open with unsaved edits: VS Code keeps the editor copy, so ours is still right.
		if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty)) return;
		const text = await readText(uri);
		if (text === undefined) return;
		if (this.shadow.get(rel) === text) return; // our own save, or a reload we already logged
		this.shadow.set(rel, text);
		this.transport.record({ kind: 'external_write', file: rel, text });
	}

	// ---- helpers -------------------------------------------------------------

	/** Workspace-relative path with forward slashes, or undefined if not tracked. */
	private rel(uri: vscode.Uri): string | undefined {
		if (uri.scheme !== 'file') return undefined;
		const r = relative(this.root.fsPath, uri.fsPath);
		if (!r || r.startsWith('..')) return undefined;
		const parts = r.split(sep);
		if (parts.some((p) => EXCLUDE_DIRS.includes(p))) return undefined;
		return parts.join('/');
	}

	/** Hashes of every tracked text file on disk, for submission. */
	async snapshotHashes(): Promise<Record<string, string>> {
		await vscode.workspace.saveAll(false);
		const out: Record<string, string> = {};
		const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, '**/*'), EXCLUDE_GLOB, MAX_FILES);
		for (const uri of uris) {
			const rel = this.rel(uri);
			const text = rel && (await readText(uri));
			if (rel && text !== undefined && rel !== '.lineage.json') out[rel] = hash(text);
		}
		return out;
	}
}

/** File contents as text, or undefined for binary / huge / unreadable files. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) return undefined;
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.subarray(0, 8000).includes(0)) return undefined;
		return Buffer.from(bytes).toString('utf8');
	} catch {
		return undefined;
	}
}
