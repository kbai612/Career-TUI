# How To Run Career Ops

## What this project is

Career Ops is a local-first job-search system with:

- a terminal UI (`apps/tui`)
- a worker CLI (`apps/worker`)
- a shared core package for storage, scoring, prompts, adapters, and pipeline logic (`packages/core`)
- a source registry for recurring discovery sync

It stores data locally in SQLite and local files under `data/`.

## Prerequisites

You need these installed on your machine:

- `Node.js` and `npm`
- `pnpm`
- Google Chrome

Optional but recommended:

- an API key for your selected provider (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY`) if you want live model calls

Without an API key, the app still works. The offer evaluator, comparison, research, outreach, and training modes all have deterministic local fallbacks.

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
LLM_PROVIDER=deepseek

DEEPSEEK_API_KEY=your_deepseek_key_here
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com

# If using OpenRouter:
# LLM_PROVIDER=openrouter
# OPENROUTER_API_KEY=your_openrouter_key_here
# OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
# OPENROUTER_SITE_URL=https://your-site.example
# OPENROUTER_APP_NAME=Career Ops

# If using OpenAI:
# LLM_PROVIDER=openai
# OPENAI_API_KEY=your_openai_key_here
# OPENAI_MODEL=gpt-4.1-mini

CAREER_OPS_DB_PATH=./data/career-ops.db
CAREER_OPS_BROWSER_PROFILE=./data/browser-profile
CAREER_OPS_UPLOADED_RESUME=./profile/uploaded_resume.pdf
# Optional JSON file with extra form answers (key/value pairs)
# CAREER_OPS_AUTOAPPLY_INFO_JSON=./profile/autoapply-info.json
# Set to 1 only if you want autoapply-shortlist to attempt submit clicks
# CAREER_OPS_AUTOAPPLY_SUBMIT=0
# Optional: skip Playwright PDF rendering and keep HTML resume artifacts only
# CAREER_OPS_SKIP_PDF_RENDER=1
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
- `config/regions.json`: reusable regional filters for daily source sync

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

## Toronto daily discovery setup

Seed the default Toronto discovery sources:

```powershell
node apps/worker/dist/apps/worker/src/index.js seed-toronto-sources
```

List the registered sources:

```powershell
node apps/worker/dist/apps/worker/src/index.js list-sources --region toronto-canada
```

Run a sync and evaluate what was found:

```powershell
node apps/worker/dist/apps/worker/src/index.js sync-sources --region toronto-canada --concurrency 3 --evaluate
```

Use `--skip-evaluate` to crawl without running scoring after sync.

This source set currently includes:

- LinkedIn Toronto Data Analyst search
- LinkedIn Toronto Senior Data Analyst search
- LinkedIn Toronto Analytics Engineer search
- LinkedIn Toronto Data Scientist search
- Levels.fyi Toronto data jobs
- Workopolis Toronto data jobs
- Indeed Canada Toronto data jobs
- SimplyHired Canada Toronto data jobs

You can add more company pages manually:

```powershell
node apps/worker/dist/apps/worker/src/index.js register-source https://company.example/careers --kind generic --name "Company Careers" --region toronto-canada
```

Or add ATS-hosted pages directly:

```powershell
node apps/worker/dist/apps/worker/src/index.js register-source https://boards.greenhouse.io/company --kind greenhouse --name "Company Greenhouse" --region toronto-canada
node apps/worker/dist/apps/worker/src/index.js register-source https://jobs.lever.co/company --kind lever --name "Company Lever" --region toronto-canada
```

Important behavior:

- LinkedIn and Levels are discovery sources
- LinkedIn sync resolves job-view links to external ATS/company apply URLs when available
- LinkedIn listings that remain LinkedIn-hosted apply URLs are kept during discovery sync
- Toronto filtering is applied before inserting jobs into the local DB
- LinkedIn source sync now uses LinkedIn's public guest-search HTML, so it should not require an interactive login during discovery
- persistent-browser sources are still serialized automatically because they share one local Chrome profile

## Normal operating flow

### 1. Run a full single-URL pipeline

```powershell
node apps/worker/dist/apps/worker/src/index.js auto-pipeline https://example.com/job
```

This runs:

- scan/extraction
- evaluation
- resume generation
- application draft generation when the role lands in `apply`

### 2. Scan a careers page without the rest of the pipeline

```powershell
node apps/worker/dist/apps/worker/src/index.js scan https://example.com/careers
```

Notes:

- discovery uses a headless Playwright session
- headed persistent Chrome is reserved for the human review apply flow

### 2b. Sync registered sources for a region

```powershell
node apps/worker/dist/apps/worker/src/index.js sync-sources --region toronto-canada --concurrency 3 --evaluate
```

Daily alias:

```powershell
node apps/worker/dist/apps/worker/src/index.js sync-daily --region toronto-canada --concurrency 3 --evaluate
```

`--skip-evaluate` is supported on both `sync-sources` and `sync-daily` and overrides `--evaluate`.

Useful variants:

```powershell
node apps/worker/dist/apps/worker/src/index.js list-sources --all
node apps/worker/dist/apps/worker/src/index.js sync-sources --region toronto-canada --limit 5
```

### 3. Evaluate newly discovered jobs

```powershell
node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25
```

For batch evaluation:

```powershell
node apps/worker/dist/apps/worker/src/index.js evaluate-batch --limit 122 --concurrency 6
```

### 4. Generate a tailored resume and cover letter

```powershell
node apps/worker/dist/apps/worker/src/index.js resume 1
```

This returns the generated artifact path for job `1`.

Expected output location:

- `data/resumes/<company>-<title>.pdf`
- `data/resumes/<company>-<title>-cover-letter.pdf`
- if PDF rendering is blocked, it falls back to `data/resumes/<company>-<title>.html`
- the HTML cover letter is always written as `data/resumes/<company>-<title>-cover-letter.html`

### 5. Inspect a rich offer report

```powershell
node apps/worker/dist/apps/worker/src/index.js oferta 1
```

This prints:

- grade and weighted score
- executive summary
- CV match block
- gaps and mitigation
- level strategy
- compensation view
- interview likelihood

### 6. Compare multiple offers

```powershell
node apps/worker/dist/apps/worker/src/index.js ofertas 1 2 3
```

### 7. Generate deep research and outreach

```powershell
node apps/worker/dist/apps/worker/src/index.js deep 1
node apps/worker/dist/apps/worker/src/index.js contact 1
```

Aliases:

- `contacto 1` is the same as `contact 1`

### 8. Evaluate a course or certification

```powershell
node apps/worker/dist/apps/worker/src/index.js training "Advanced LLMOps certification"
```

You can also pass a file path. If the path exists, the command reads the file contents and evaluates that text instead.

### 9. Draft the application payload

```powershell
node apps/worker/dist/apps/worker/src/index.js draft-apply 1
```

### 10. Open review mode in the browser

```powershell
node apps/worker/dist/apps/worker/src/index.js review-apply 1
```

This:

- opens a headed browser
- prefills common fields
- leaves final submission to you

It does not auto-submit.

Alias:

```powershell
node apps/worker/dist/apps/worker/src/index.js apply 1
```

### 11. Bulk autoapply the shortlist in Playwright

```powershell
node apps/worker/dist/apps/worker/src/index.js autoapply-shortlist --resume .\profile\uploaded_resume.pdf
```

Optional:

```powershell
# Attempt submit clicks after autofill (use with caution)
node apps/worker/dist/apps/worker/src/index.js autoapply-shortlist --resume .\profile\uploaded_resume.pdf --submit

# Limit run size and provide extra answers JSON
node apps/worker/dist/apps/worker/src/index.js autoapply-shortlist --resume .\profile\uploaded_resume.pdf --info .\profile\autoapply-info.json --limit 5
```

This command:

- targets jobs in `shortlisted`, `resume_ready`, `ready_to_apply`, and `in_review`
- ensures resume + application draft exist before filling
- opens each apply URL with your persistent browser profile
- excludes LinkedIn-hosted apply URLs from autoapply (use external ATS/company apply URLs or manual apply)
- autofills known answers and uploads your resume
- marks jobs `in_review` after prefill, and `submitted` only when submit confirmation is detected

### 12. Run sequential or parallel URL files

Sequential:

```powershell
node apps/worker/dist/apps/worker/src/index.js pipeline .\urls.txt
```

Parallel:

```powershell
node apps/worker/dist/apps/worker/src/index.js batch .\urls.txt --concurrency 4
```

`urls.txt` should contain one URL per line.

### 13. Print tracker summary in the terminal

```powershell
node apps/worker/dist/apps/worker/src/index.js tracker
```

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

- `1-7`: switch tabs
- `8`: open/close the manual Actions view
- `j` / `k` or arrow keys: move selection
- `r`: refresh
- `x`: reject selected job
- `a`: shortlist selected job
- `i`: mark selected job as interview/blocked
- `v`: cycle detail views (`Summary`, `CV Match`, `Gaps And Strategy`, `Deep Research`, `Contact Draft`)
- `d`: generate deep research for the selected job
- `m`: generate a contact draft for the selected job
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

If you already had older data in the DB from a previous build, open a job in `oferta` once to refresh its stored evaluation into the richer report format.

### Resume command returns `.html` instead of `.pdf`

That means Playwright could not render the PDF in the current environment.

Usually fix with:

```powershell
pnpm.cmd exec playwright install chromium
```

Also make sure Chrome and Playwright's Chromium runtime are installed.

If you intentionally want HTML-only resume output in a constrained environment, set:

```env
CAREER_OPS_SKIP_PDF_RENDER=1
```

### No provider key configured

The app still runs, but uses the deterministic fallback evaluator instead of live model calls.

### Browser automation does not look logged in

The worker uses:

- `CAREER_OPS_BROWSER_PROFILE`
- default: `./data/browser-profile`

Keep using the same profile directory so sessions persist between runs.

If a persistent sync fails immediately during Chrome launch:

- make sure no other Career Ops sync is already running
- close any Chrome window using `data/browser-profile`
- rerun `sync-sources`

## Recommended startup sequence

For real usage:

```powershell
pnpm.cmd install
pnpm.cmd exec playwright install chromium
pnpm.cmd run build
node apps/worker/dist/apps/worker/src/index.js auto-pipeline https://example.com/job
pnpm.cmd run tui
```

For development:

```powershell
pnpm.cmd install
pnpm.cmd run build
pnpm.cmd run tui
```
