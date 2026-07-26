# QQ Music Daily 30 Official API Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incorrect QQ Daily 30 data source with the signed official `dirid: 202` playlist request confirmed by the desktop-client capture, then build a Windows x64 portable executable.

**Architecture:** Keep the existing QQ Daily 30 IPC, renderer cache, card, playback queue, and detail page unchanged. Replace only the main-process request builder and response parser, using a small Node `crypto` signer and Cookie-derived PC client fields.

**Tech Stack:** TypeScript, Node `crypto`, Electron main process, Node `assert` tests, webpack, electron-builder.

---

## File Structure

- Modify `scripts/test-qq-music-daily-30.js`: assert the signed endpoint, PC request body, `dirid: 202`, response path, and sanitized failures.
- Modify `src/main/modules/qqMusic/dailyRecommend.ts`: build and sign the official request, derive Cookie authentication fields, validate `req_1`, and normalize `songlist`.
- Modify `docs/superpowers/specs/2026-07-24-qq-daily-30-design.md`: record the corrected captured API contract.

### Task 1: Lock The Captured Contract In A Failing Test

- [ ] Change the fixture response from `daily30.data.tracks` to `req_1.data.songlist`.
- [ ] Assert the URL path is `/cgi-bin/musics.fcg`, contains a nonempty `zza` signature, and never embeds Cookie secrets.
- [ ] Assert `comm` contains the captured PC fields and Cookie-derived `uid`, `guid`, UIN, and equal `g_tk` values.
- [ ] Assert `req_1` uses `music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo` with `dirid: 202` and the captured fixed parameters.
- [ ] Run `node scripts/test-qq-music-daily-30.js`; expect failure because production still calls `music.ai_track_daily_svr/get_daily_track`.

### Task 2: Replace The Main-Process Request

- [ ] Add pure helpers for DJB `g_tk` generation and `zza` signing of the exact serialized body.
- [ ] Build the PC `comm` object from Cookie values and reject a logged-in request that lacks required UIN, GUID, UID, or key material.
- [ ] POST the signed JSON string to `https://u6.y.qq.com/cgi-bin/musics.fcg` with the existing timeout and secret-sanitizing error boundary.
- [ ] Validate top-level and `req_1` business codes, then normalize `req_1.data.songlist`.
- [ ] Run `node scripts/test-qq-music-daily-30.js` and `node scripts/test-qq-music-song.js`; expect both to pass.

### Task 3: Verify The Real Account And Regressions

- [ ] Make one authenticated request using the application's saved login state without printing secrets; assert business code `0`, title `每日30首`, and 30 normalized songs.
- [ ] Run the QQ main-process, IPC, renderer, provider-page, and UI wiring tests.
- [ ] Run TypeScript checks for `src/common`, `src/main`, and `src/renderer`.
- [ ] Run focused ESLint and `git diff --check`.

### Task 4: Build And Smoke-Test The Portable Artifact

- [ ] Run the production build and `npm run pack:win:portable:x64`.
- [ ] Resolve the emitted executable, then report its absolute path, size, timestamp, and SHA-256 hash.
- [ ] Launch only that executable with an isolated temporary data directory and verify it does not immediately crash; close only the smoke-test process.
