# Career Ops

Career Ops is a local-first job-search operations system built around a terminal workflow.

It combines:

- multi-source job scanning
- deterministic + model-assisted offer evaluation with multi-block reports
- per-role resume tailoring and cover-letter generation
- browser-assisted application drafting with a human-in-the-loop checkpoint
- deep company research
- recruiter outreach drafting
- training/course evaluation against target archetypes

All state is local (SQLite + local files). No hosted backend is required.

## Core functionality

### 1. Scanner

Discovers listings from:

- Greenhouse
- Lever
- Ashby
- Workday
- generic careers pages
- LinkedIn job search pages
- Levels.fyi job pages

Listings are normalized and deduplicated before entering the evaluation queue.

LinkedIn and Levels are treated as discovery sources, not canonical sources of truth. When a listing exposes a direct ATS or company apply URL, Career Ops resolves and stores that canonical apply URL while preserving the discovery metadata.

### 2. Evaluator

Scores every job across 10 fixed dimensions:

1. Role fit
2. Skills alignment
3. Seniority calibration
4. Compensation range
5. Geographic viability
6. Company stability
7. Product-market interest
8. Growth trajectory
9. ATS compatibility
10. Timeline urgency

Output includes:

- per-dimension score and reasoning
- weighted total and A-F grade
- recommendation (`reject`, `review`, `apply`)
- documented rejection reasons
- executive summary
- CV match table
- gaps and mitigation plan
- level strategy
- compensation view
- personalization hints
- interview likelihood

### 3. Resume tailoring

Generates a role-targeted resume variant from:

- `profile/master_resume.md`
- `profile/profile.json`
- evaluation context for the target listing

Primary output is a PDF path. The generator also writes:

- an ATS-safe HTML resume artifact
- an HTML cover letter
- a PDF cover letter when Playwright can render locally

If PDF rendering is unavailable in the local environment, the system returns the generated HTML artifact path instead.

### 4. Application drafting and auto-apply

Builds an application draft with:

- reusable profile/EEO/autofill fields
- role-specific generated answers

The `review-apply` mode opens a headed browser session, prefills fields, and stops for manual user review. It does not auto-submit.

The `autoapply-shortlist` mode can run through shortlisted jobs in bulk, open each posting in Playwright, prefill fields, upload your resume, and optionally attempt submit clicks.

### 5. Research, outreach, and training

Career Ops now also supports:

- `deep`: generate a company research brief with signals, risks, and outreach angles
- `contact`: draft recruiter/hiring-manager outreach grounded in the evaluation report
- `training`: score a course or certification against the configured archetypes and North Star
- `ofertas`: compare multiple jobs and rank them by score, grade, and main risk
- `auto-pipeline`: run scan, evaluation, resume generation, and optional apply draft for a single URL

## Workflow

Typical operation loop:

1. Scan sources for listings.
2. Sync registered regional discovery sources.
3. Evaluate pending listings.
4. Reject low-fit roles with reasoning.
5. Shortlist high-fit roles.
6. Generate tailored resume and cover letter.
7. Optionally generate deep research and recruiter outreach.
8. Draft and review application in browser.
9. Submit manually.

State transitions are explicit in the pipeline:

`discovered -> normalized -> evaluated -> rejected|shortlisted -> resume_ready -> ready_to_apply -> in_review -> submitted`

## Architecture

Workspace packages:

- `apps/tui`: terminal dashboard (`neo-blessed`)
- `apps/worker`: operational CLI (scan/evaluate/resume/apply)
- `packages/core`: shared types, schema, scoring, adapters, DB, and pipeline

Mode-oriented agent design:

- `auto-pipeline`
- `scanner-discovery`
- `job-normalizer`
- `dedup-resolver`
- `offer-evaluator`
- `offer-report`
- `offer-comparison`
- `resume-tailor`
- `pdf-renderer`
- `application-drafter`
- `apply-runner`
- `company-research`
- `contact-drafter`
- `training-evaluator`

Prompts are isolated per mode in `packages/core/prompts/`.

## Commands

Use the built worker entrypoint:

```powershell
node apps/worker/dist/apps/worker/src/index.js <command>
```

Main commands:

- `seed-demo`
- `register-source <url> --kind <kind> --region toronto-canada`
- `list-sources [--all] [--region toronto-canada]`
- `seed-toronto-sources`
- `sync-sources [--region toronto-canada] [--concurrency 3] [--evaluate] [--skip-evaluate]`
- `sync-daily [--region toronto-canada] [--concurrency 3] [--evaluate] [--skip-evaluate]`
- `scan <url>`
- `auto-pipeline <url>`
- `pipeline <file>`
- `batch <file> --concurrency 4`
- `evaluate --limit 25`
- `evaluate-batch --limit 122 --concurrency 6`
- `oferta <jobId>`
- `ofertas <jobId...>`
- `resume <jobId>`
- `pdf <jobId>`
- `deep <jobId>`
- `contact <jobId>`
- `contacto <jobId>`
- `training <source-or-file>`
- `tracker`
- `draft-apply <jobId>`
- `autoapply-shortlist [--resume <path>] [--info <path>] [--submit] [--headless] [--wait-ms 1500] [--limit 0]`
- `review-apply <jobId>`
- `apply <jobId>`

TUI:

- `pnpm.cmd run tui`

## Setup and operations

Detailed setup, troubleshooting, and operational steps are in:

- [HOWTO.md](/C:/Users/kevin/Documents/Github/Career%20Ops/HOWTO.md)

Quick minimum:

1. `pnpm.cmd install`
2. `pnpm.cmd run build`
3. `node apps/worker/dist/apps/worker/src/index.js seed-demo`
4. `node apps/worker/dist/apps/worker/src/index.js evaluate --limit 25`
5. `pnpm.cmd run tui`

Toronto discovery workflow:

1. `node apps/worker/dist/apps/worker/src/index.js seed-toronto-sources`
2. `node apps/worker/dist/apps/worker/src/index.js sync-sources --region toronto-canada --evaluate`
3. `node apps/worker/dist/apps/worker/src/index.js tracker`
4. `pnpm.cmd run tui`

The default Toronto source pack now includes:

- LinkedIn guest-search feeds for `Data Analyst`, `Senior Data Analyst`, `Analytics Engineer`, and `Data Scientist`
- Levels Toronto location jobs
- Workopolis Toronto data jobs
- Indeed Canada Toronto data jobs
- SimplyHired Canada Toronto data jobs

## Configuration files

- `config/scoring.json`: weight and threshold tuning
- `config/archetypes.json`: target role archetypes
- `config/regions.json`: named regional filters used by source sync
- `profile/master_resume.md`: base resume content
- `profile/profile.json`: personal profile, proof points, preferences, autofill fields

## Source registry and daily sync

Career Ops now supports a local source registry backed by SQLite.

Each source stores:

- display name
- source URL
- source kind (`greenhouse`, `lever`, `ashby`, `workday`, `generic`, `linkedin`, `levels`)
- region id
- active/inactive state
- persistent-browser flag
- last sync timestamp and status

Persistent-browser sources are executed one at a time because they share a single local Chrome profile.

LinkedIn discovery uses the public guest-search job HTML rather than an interactive logged-in session.

Recommended Toronto setup:

1. Seed the default discovery sources:

```powershell
node apps/worker/dist/apps/worker/src/index.js seed-toronto-sources
```

2. Review them:

```powershell
node apps/worker/dist/apps/worker/src/index.js list-sources --region toronto-canada
```

3. Add company-specific career pages as you find them:

```powershell
node apps/worker/dist/apps/worker/src/index.js register-source https://company.example/careers --kind generic --name "Company Careers" --region toronto-canada
```

4. Run the sync:

```powershell
node apps/worker/dist/apps/worker/src/index.js sync-sources --region toronto-canada --concurrency 3 --evaluate
```

5. Repeat daily with:

```powershell
node apps/worker/dist/apps/worker/src/index.js sync-daily --region toronto-canada --concurrency 3 --evaluate
```

`sync-sources` stores only region-matching listings for the configured source region. For Toronto, the default rule includes Toronto plus common GTA aliases and Canada-remote aliases from `config/regions.json`.
Use `--skip-evaluate` when you want crawl-only behavior (it overrides `--evaluate` if both are passed).

## Notes

- Live model access is optional. Set `LLM_PROVIDER=deepseek|openrouter|openai` and configure the matching API key (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY`). Without a provider key, the evaluator uses deterministic fallback logic.
- Set `CAREER_OPS_SKIP_PDF_RENDER=1` if you want HTML resume artifacts only and do not want Playwright PDF generation.
- `autoapply-shortlist` uses `CAREER_OPS_UPLOADED_RESUME` by default if `--resume` is not passed. Optional overrides: `CAREER_OPS_AUTOAPPLY_INFO_JSON` and `CAREER_OPS_AUTOAPPLY_SUBMIT=1`.
- This repo is intentionally local-first and single-user.
- LinkedIn and Levels are best used as discovery layers. Canonical ATS or company apply URLs remain the durable dedup target.
