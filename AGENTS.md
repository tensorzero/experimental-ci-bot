# Repository Guidelines

## Project Structure & Module Organization

TypeScript sources live in `src/`, split into the `generate-pr-patch` and
`create-pr-feedback` action entry points with shared clients such as
`gitClient.ts`. Action bundle artifacts are emitted to `dist/` via Rollup; never
edit these by hand. Test fixtures sit in `__fixtures__/`, coverage artifacts in
`coverage/` and `badges/`. Helper scripts for releases live under `script/`, and
prompt/config files used by TensorZero agents reside in `tensorzero/`. Keep new
modules colocated with the action they serve and export through `package.json`
if they must ship.

## Build, Test, and Development Commands

- `npm run lint` – run ESLint across the project with TypeScript-aware rules.
- `npm run test` – execute the Jest suite (`NODE_OPTIONS` already configured).
- `npm run bundle` – format, then build production bundles into `dist/`.
- `npm run package:watch` – rebuild on file changes while developing.
- `npm run local-action` – simulate the action locally against `.env` inputs.

## Coding Style & Naming Conventions

We rely on Prettier (`npm run format:write`) for 2-space indentation,
semicolons, and single quotes. TypeScript files use ES module syntax and
explicit exports. Name new files in `camelCase` to match the existing clients,
and keep test files as `*.test.ts`. Prefer descriptive function names
(`buildCommentPayload`) and avoid abbreviations. ESLint is configured in
`eslint.config.mjs`; fix violations instead of suppressing them unless reviewed.

## Testing Guidelines

Tests are written with Jest and colocated near the code (for example
`src/generate-pr-patch/pullRequestCommentTemplate.test.ts`). Mirror the file
under test and cover both success and failure paths. Inject dependencies—like
the ClickHouse client facade—via the optional arguments provided by
`clickhouseClient.ts`; this keeps tests hermetic and avoids touching the real
database API. Use `npm run ci-test` inside CI when you need the same flags
GitHub uses. Add new fixtures under `__fixtures__/` when mocking API payloads.
Aim to maintain badge-level coverage by running `npm run coverage` before
publishing.

## Commit & Pull Request Guidelines

Recent history (`git log --oneline`) shows short, imperative subject lines such
as "Write files in utf-8"; follow that style and keep body details wrapped at 72
characters. Include one logical change per commit whenever possible. Pull
requests should describe the motivation, summarize testing (`npm test`,
`npm run bundle`), and link the tracking issue. Attach screenshots for
user-visible output changes and ensure generated `dist/` artifacts are updated
alongside source when behavior changes.

## IMPORTANT RULES

Before submitting a PR, run `npm run bundle` to update the JavaScript bundles.
Otherwise, CI will fail.
