# Career Ops

Local-first GPT/Codex job-search operations system with a terminal UI, SQLite persistence, OpenAI-backed agent modes, Playwright automation, and ATS-safe resume generation.

## Workspace

- `apps/tui`: terminal interface built with `neo-blessed`
- `apps/worker`: CLI for scan, evaluate, resume, and apply workflows
- `packages/core`: shared schema, prompts, storage, adapters, and pipeline services

## Quick start

1. Install dependencies: `pnpm install`
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` if you want live model calls.
3. Seed demo data: `pnpm --filter @career-ops/worker dev seed-demo`
4. Run the TUI: `pnpm dev:tui`

## Local files

- `config/scoring.json`
- `config/archetypes.json`
- `profile/master_resume.md`
- `profile/profile.json`
