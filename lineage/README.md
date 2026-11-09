# Lineage

Lineage records *how* assignment code gets written, so students can show they wrote it and instructors can spot code that came from somewhere else, especially AI agents that write files directly to disk.

It records edits to project files only. No camera, no microphone, nothing outside the editor.

## How it works

```
 Lineage editor ──► recorder extension ──► encrypted spool ──► course server ──► TA dashboard
                    classifies every        (outside the       verifies hash     coverage %,
                    change by source        project; works     chain, replays    flags, replay
                                            offline)           history
```

Each change is classified by where it came from:

| Source | Meaning | Counts as |
|---|---|---|
| typed | Keystrokes in the editor | Authored |
| editor | Autocomplete, formatting, undo/redo right after user input | Authored |
| paste_internal | Pasted text that was copied inside the editor | Authored |
| starter | Matches the instructor's starter code when the student joined | Excluded |
| paste_external | Pasted from outside the editor | Unattributed |
| external_write | **Written to disk by another program** (Claude Code, Codex, scripts, other editors) | Unattributed |
| programmatic | Edited in the editor with no user input nearby (e.g. another extension) | Unattributed |
| unobserved | Not recorded: changed while Lineage wasn't running, or already there when the student joined but not in the starter code | Unattributed |

Events are linked in a SHA-256 hash chain, encrypted (AES-256-GCM, key wrapped with the server's RSA public key), and spooled to the extension's global storage until the server accepts them. The server rejects any batch that doesn't continue the chain, and records when each batch arrived.

The report replays the full history to rebuild every file with a source attached to each character, then:

- reports **% written in Lineage** (authored chars ÷ chars added beyond the starter code, whitespace excluded)
- compares the replay with the student's submitted file hashes
- checks the replay against content hashes recorded at every save
- flags disk writes by other programs, large external pastes, edits with no user input, changes made while Lineage was closed, work done before joining, and late delivery

**Starter code.** The instructor uploads the starter folder once (dashboard: **Upload starter folder** on the assignment page; CLI: `--starter <folder>` or `npm run set-starter -- <id> <folder>`). The server stores every file and compares each student's first snapshot against it. Matching text counts as starter code; anything else is flagged `pre_join` (an alert from about one line of code). Each upload is a new version, and students match whichever version they started from, so fixing the starter mid-assignment doesn't flag anyone. Without an upload, everything present at join counts as starter code and the report says so.

Reports are evidence for a person to review, not a verdict.

**What it deliberately doesn't catch:** a person retyping code by hand from another screen. Lineage targets agents and paste-ins, not transcription.

## What Lineage looks at (and what it doesn't)

Lineage only records facts about **this project inside this editor**:

- edits to project files, and where each one came from (typed, pasted, written to disk by another program)
- AI agents (`claude`, `codex`, `aider`, `gemini`, …) **started from Lineage's own terminal**, using the editor's shell integration
- agent traces tied to this project, checked by **exact path only**: Claude Code's per-project history folder (`~/.claude/projects/<this project's path>`), Gemini CLI's project folder, and agent files inside the repo (`CLAUDE.md`, `.aider*`, …). Lineage checks only whether these exist and when they last changed. It never lists folders and never reads their contents.

It does **not** list running processes, watch other folders, capture the screen, camera or microphone, or use OS-level monitoring.

**Confidentiality.** Events are encrypted on the student's machine with a fresh AES-256-GCM key per batch, wrapped with the course server's RSA public key. The local spool can only be decrypted by the server, so students can't read their own replay or see what was detected. Flags and replays exist only on the server.

**Tamper evidence.** Events form a SHA-256 hash chain. Editing an event breaks the chain; deleting a batch from the spool shows up as an alert that names how many events are missing (the rest of the history is still accepted). Data the student never sends can't be checked, so it's on the course to treat missing recordings as missing work.

## Try it locally

Requires Node 24+.

```sh
# 1. Server
cd lineage/server
npm run create-assignment -- demo-hw      # prints the join code
npm start                                 # prints the dashboard URL with your admin key

# 2. Recorder (in another terminal)
cd lineage/recorder
npm install
npm run compile
code .                                    # then press F5 ("Run Lineage Recorder")
```

F5 opens a VS Code window on `lineage/sample-assignment`. Accept the "Join" prompt, enter any student ID and the join code, and start editing `main.py`. To see agent detection, run `claude` (or just `echo "x = 1" >> main.py`) in a terminal in that folder. Run **Lineage: Submit Assignment** from the command palette, then open the dashboard.

## See it at scale (demo data)

```sh
cd lineage/server
npm run demo        # seeds 2 courses, 3 assignments, ~40 students, ~40k events; serves on :4748
```

Students follow realistic profiles: honest multi-session work, a last-night crammer, a student who pastes from the web, and agent users whose files appear on disk.

## Dashboard

- **Courses**: every assignment with how many students are waiting for review.
- **Assignment**: a sortable triage table, filtered to *Needs review* (any alert, or under 70% written in Lineage). Mark students *Cleared* or *Follow up* to work through the queue.
- **Student**: summary, flags (click to jump to that moment), private review notes, then the replay:
  - an **overview timeline** of the whole history (drag to scroll fast; triangles mark pastes and disk writes), and a **zoomed track** for fine steps
  - a **file tree** of the whole project, each file colored by where its code came from; untouched starter files are dimmed
  - **code with a minimap**, where colored marks show where the unattributed code is
  - keyboard: `← →` step, `Shift` to step 10, `Space` play, `- +` zoom, `[ ]` previous/next student

## Instructor setup

```sh
npm run create-course -- cs101 "CS 101 · Intro to Programming"
npm run create-assignment -- cs101-hw3 --course cs101 --title "HW3 · Text statistics" --due 2026-12-01 --starter ./hw3-starter
npm run set-starter -- cs101-hw3 ./hw3-starter     # after fixing the starter: adds version 2
```

Set `LINEAGE_PUBLIC_URL=https://your-server` so the printed `.lineage.json` points students at the deployed server.

Put a `.lineage.json` at the root of the starter repo:

```json
{ "assignmentId": "demo-hw", "server": "http://localhost:4747" }
```

## Layout

- `server/`: Node server with no dependencies (built-in `node:sqlite`). `public/replay.js` is the replay engine, shared by the server and the dashboard.
- `bundle-recorder.sh`: compiles the recorder and copies it into the app as a built-in extension. `prepare_vscode.sh` runs it on every build; you can also point it at an existing `Lineage.app/Contents/Resources/app/extensions`.
- `recorder/`: the editor extension. `src/recorder.ts` classifies changes; `src/transport.ts` handles the chain, encryption and spool.
- `sample-assignment/`: a starter project to try it on.

`server/src/chain.ts` and `recorder/src/chain.ts` must stay identical.

## Run the tests

```sh
cd lineage/server && npm test
```

## Known limitations (MVP)

- Text typed in an untitled buffer and then "Saved As" into the project shows up as `external_write`.
- Copying a file in the file explorer shows up as `external_write`.
- Paste is detected through the paste keybinding; pasting from the right-click menu is classified as `edit_other`/`programmatic`.
- Only one extension can intercept typing; a Vim-style extension would conflict.
- Everything runs over plain HTTP on localhost. Real deployment needs HTTPS and proper instructor accounts.
