# Code Audit Fixes Implementation Plan

**Goal:** Fix reproducible correctness and lifecycle defects found during the repository-wide audit without disturbing the in-progress local music and sync work.

**Scope:** WebDAV href decoding and proxy startup, lyric raw-data preservation, idempotent listener/device/snapshot cleanup, persisted-store root validation, Electron navigation/session permission boundaries, and low-risk dependency vulnerability updates. Electron sandbox migration and major-version upgrades are documented as residual risk unless they can be verified without changing application behavior.

**Approach:** Add focused Node regression tests first, confirm they fail for the intended reason, apply the smallest production changes, then run targeted and repository-wide verification.

## Tasks

1. Extend the WebDAV helper test with XML named/numeric entities and encoded traversal cases.
2. Add a Babel-loaded behavior test for `buildLyricInfo` that distinguishes edited lyrics from `rawlrcInfo`.
3. Add focused lifecycle tests for repeated listener/device/snapshot removal so a missing entry cannot delete an unrelated one.
4. Add store-constructor tests proving `null` and array JSON roots enter the existing invalid-config recovery path.
5. Add WebDAV proxy startup concurrency/retry tests and a user-API session isolation contract.
6. Implement minimal fixes in the affected helpers/modules while preserving current user edits.
7. Update only dependency versions that resolve audited vulnerabilities with a compatible, verifiable change; report major Electron migration separately if full compatibility cannot be established.
8. Verify all standalone tests, all TypeScript projects, lint, production build, npm audit, dependency tree, and whitespace integrity.

## Verification

```powershell
Get-ChildItem scripts -Filter 'test-*.js' | ForEach-Object { node $_.FullName }
npx tsc -p src/common/tsconfig.json --noEmit
npx tsc -p src/main/tsconfig.json --noEmit
npx tsc -p src/renderer/tsconfig.json --noEmit
npx tsc -p src/renderer-lyric/tsconfig.json --noEmit
npx tsc -p src/lang/tsconfig.json --noEmit
npm run lint
npm run build
npm ls --all --json
npm audit --registry=https://registry.npmjs.org --json
git diff --check
```
