# Florence API

NestJS 12 (ES modules) on Postgres. The contract is `openapi.yaml`: every test validates requests and responses against it, and `npm test` first checks that each of its 77 operations has at least one test request.

## Run

```bash
cp .env.example .env
npm run migrate
npm run dev
```

`npm run migrate` applies `db/migrations/*.sql` to `DATABASE_URL`. It is not run on boot. On Fly.io it runs as the release command.

```bash
npm test
npm run lint
npm run lint:spec
npm run build
```

`npm run lint` runs ESLint and checks Prettier formatting (4 spaces). `npm run format` rewrites files to match.

With no Postgres installed, `npm run db:local` serves PGlite on port 5432 with data in `.pglite/`. Set `DB_POOL_MAX=1` while using it.

Tests run on Vitest against an in-memory Postgres (PGlite), so they need no database. External services are replaced by fakes in tests: the AI provider, storage, Paystack, Web Push and the Telegram messenger.

## What is built

All 77 operations answer. The five leaderboard and Wrapped operations are skeletons: boards stay `not_open` and Wrapped answers 409 `wrapped_not_ready`.

| Area | Notes |
|---|---|
| Sign-in | WhatsApp number codes (approved template `florence_signin_code`), email codes, Telegram deep link and WhatsApp code challenges claimed by the bots, Telegram Login Widget and OIDC, Google ID tokens. With a bearer token each one links instead. Merge moves balances and 26 tables in one transaction |
| Student status | School email codes with plus-tag stripping and a disposable-domain list, or Google `hd`. 10 tokens once per address and per account |
| Library | Uploads up to 20 MB (one PDF, one voice note, or up to 30 page photos as one material), dedupe by content hash, a 20 file cap, PDF text per page, OCR for scans and photos, page-numbered chunks with `tsvector`, topics |
| Study | 1 token per session at start, refunded once on failed generation or zero answers. Quiz, flashcards, fill in the blank and mock exam. Local marking for choice items, model marking for written ones. 48 hour offline answers |
| Streak | Study days, the freeze and the 7-day reward, replayed from study days in Africa/Lagos time |
| Ask | Streamed over SSE, 1 token for a text question and 2 with a file or photo attached, refunded once on failure or a closed stream. Answers cite file and page from the student's own chunks |
| Guest | 3 free questions per device, claimable after sign-up |
| Money | Paystack card and bank transfer, webhook with signature check, one credit per reference |
| Platform | Web Push, daily reminders (never after 22:00 Lagos), referral reward, JSON data export, deletion after a 7 day grace |
| Bots | `POST /internal/v1/events` and `GET /internal/v1/streak` behind `X-Service-Key` |

Background work runs in the API process: a Postgres-backed job queue (file reading, session generation, exports) and a 5 minute scheduler (closing the Lagos day, reminders, account erasure).

## Configuration

`.env.example` lists every variable. In production the API refuses to start without `DATABASE_URL`, `JWT_SECRET`, `CODE_PEPPER`, `INTERNAL_API_SECRET`, the Resend mail driver, `ANTHROPIC_API_KEY`, the Supabase storage keys and the VAPID key pair. `node scripts/generate-vapid.mjs .env` writes a VAPID pair.

Outside production the API uses Paystack only with a test key (`sk_test_...`).

## Scripts

| Script | What it does |
|---|---|
| `scripts/spec-coverage.mjs` | Fails when an operation in the spec has no test request. Runs inside `npm test` |
| `scripts/live-check-ai.ts` | Sends a 3-page PDF to Anthropic for transcription and topics |
| `scripts/live-check-study.ts` | Generates 4 quiz items and marks one written answer with Anthropic |
| `scripts/live-check-ask.ts` | Uploads a PDF and streams one cited answer through the API |
| `scripts/load-check.ts` | 200 concurrent Ask streams for 60 seconds with the fake AI provider |
| `scripts/generate-vapid.mjs` | Adds a VAPID key pair to an env file |

## Deploy

`Dockerfile` and `fly.toml` target one long-lived Fly.io machine, since streams and background jobs need a process that stays up. `/v1/health` is the host check. Logs are JSON lines with a request id, which is also returned as `X-Request-Id`.

## Known gaps

- Not yet run against Supabase Postgres through the `pg` driver. Everything has run on PGlite, which is Postgres compiled to WebAssembly.
- Voice notes are refused with 422 `voice_not_available` until a transcription provider is chosen.
- Live checks so far: Anthropic reads, generation, marking and streaming. Paystack, Resend, Google, Supabase Storage and Web Push to a real browser have not been run live.
