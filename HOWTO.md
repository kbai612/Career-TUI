# How To Run Career Ops

## What this project is

Career Ops is a local-first job-search system with:

- a terminal UI (`apps/tui`)
- a worker CLI (`apps/worker`)
- a shared core package for storage, scoring, prompts, adapters, and pipeline logic (`packages/core`)

It stores data locally in SQLite and local files under `data/`.

## Prerequisites

You need these installed on your machine:

- `Node.js` and `npm`
- `pnpm`
- Google Chrome

Optional but recommended:

- an `OPENAI_API_KEY` if you want real OpenAI model calls

Without an API key, the app still works, but evaluator behavior falls back to the deterministic local scorer.

## One-time setup

From the repo root:

```powershell
pnpm.cmd install
```

Install Playwright's browser runtime for PDF rendering:

```powershell
pnpm.cmd exec playwright install chromium
```

Create your local environment file:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and set:

```env
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
CAREER_OPS_DB_PATH=./data/career-ops.db
CAREER_OPS_BROWSER_PROFILE=./data/browser-profile
```

## Files you should customize

Before serious use, update these files:

- `profile/master_resume.md`
- `profile/profile.json`
- `config/scoring.json`
- `config/archetypes.json`

What they do:

- `profile/master_resume.md`: your base resume content
- `profile/profile.json`: your contact info, skills, proof points, preferences, and autofill answers
- `config/scoring.json`: score weights and thresholds
- `config/archetypes.json`: your target role archetypes

## Build the app

Compile all packages:

```powershell
pnpm.cmd run build
```

If you only changed the TUI:

```powershell
pnpm.cmd run build -w apps/tui
```

If you only changed the worker:

```powershell
pnpm.cmd run build -w apps/worker
```

## First run

Seed demo jobs so the TUI has data:

```powershell
node apps/worker/dist/apps/worker/src/index.js seed-demo
```

Evaluate those jobs:

```powershell
node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25
```

Start the TUI:

```powershell
pnpm.cmd run tui
```

## Normal operating flow

### 1. Scan a careers page

```powershell
node apps/worker/dist/apps/worker/src/index.js scan https://example.com/careers
```

Notes:

- this opens a headed Chrome session
- it uses a persistent browser profile in `data/browser-profile`

### 2. Evaluate newly discovered jobs

```powershell
node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25
```

For batch evaluation:

```powershell
node apps/worker/dist/apps/worker/src/index.js evaluate-batch --limit 122 --concurrency 6
```

### 3. Generate a tailored resume

```powershell
node apps/worker/dist/apps/worker/src/index.js resume 1
```

This returns the generated artifact path for job `1`.

Expected output location:

- `data/resumes/<company>-<title>.pdf`
- if PDF rendering is blocked, it falls back to `data/resumes/<company>-<title>.html`

### 4. Draft the application payload

```powershell
node apps/worker/dist/apps/worker/src/index.js draft-apply 1
```

### 5. Open review mode in the browser

```powershell
node apps/worker/dist/apps/worker/src/index.js review-apply 1
```

This:

- opens a headed browser
- prefills common fields
- leaves final submission to you

It does not auto-submit.

## TUI usage

Start the built TUI:

```powershell
pnpm.cmd run tui
```

If you edit TUI code, rebuild before launching again:

```powershell
pnpm.cmd run build -w apps/tui
pnpm.cmd run tui
```

Main hotkeys:

- `1-6`: switch tabs
- `j` / `k` or arrow keys: move selection
- `r`: refresh
- `x`: reject selected job
- `a`: shortlist selected job
- `i`: mark selected job as interview/blocked
- `o` or `Enter`: show reasoning
- `q`: quit

## Data locations

Main local outputs:

- `data/career-ops.db`: SQLite database
- `data/browser-profile`: persistent Chrome profile
- `data/resumes`: generated resume files

## Troubleshooting

### `pnpm` is not recognized

Use:

```powershell
pnpm.cmd
```

If needed, reopen your terminal after global install.

### TUI starts but shows no jobs

Run:

```powershell
node apps/worker/dist/apps/worker/src/index.js seed-demo
node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25
```

Then reopen the TUI.

### Resume command returns `.html` instead of `.pdf`

That means Playwright could not render the PDF in the current environment.

Usually fix with:

```powershell
pnpm.cmd exec playwright install chromium
```

Also make sure Chrome and Playwright's Chromium runtime are installed.

### No OpenAI key configured

The app still runs, but uses the deterministic fallback evaluator instead of live model calls.

### Browser automation does not look logged in

The worker uses:

- `CAREER_OPS_BROWSER_PROFILE`
- default: `./data/browser-profile`

Keep using the same profile directory so sessions persist between runs.

## Recommended startup sequence

For real usage:

```powershell
pnpm.cmd install
pnpm.cmd exec playwright install chromium
pnpm.cmd run build
node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25
pnpm.cmd run tui
```

For development:

```powershell
pnpm.cmd install
pnpm.cmd run build
pnpm.cmd run tui
```

