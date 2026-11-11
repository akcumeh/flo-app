# Florence API

NestJS 12 (ES modules) on Postgres. The contract is `openapi.yaml`. Requests and responses are validated against it in every test, so the code cannot drift from the spec without a test failing.

## Run

```bash
cp .env.example .env
npm run migrate
npm run dev
```

`npm run migrate` applies `db/migrations/*.sql` to `DATABASE_URL`. It is not run on boot.

```bash
npm test
npm run lint:spec
npm run build
```

Tests run on Vitest against an in-memory Postgres (PGlite), so they need no database.

## What exists

10 of the 77 operations in the spec:

| Area | Endpoints |
|---|---|
| System | `GET /v1/health`, `GET /v1/status` |
| Email sign-in | `POST /v1/auth/email/start`, `/email/verify`, `/refresh`, `/logout` |
| Account | `GET /v1/me`, `PATCH /v1/me` |
| Tokens | `GET /v1/tokens`, `GET /v1/tokens/ledger` |

Every other path in the spec answers `501 not_implemented`.

Behaviour that is built and tested:
- 6 digit email codes, 10 minute expiry, 5 wrong tries lock a code, 3 sends per address and 10 per IP per hour.
- Refresh tokens rotate on every use. Replaying an old one revokes the whole family.
- New accounts get 10 tokens once, guarded on the account, so signing in again never grants them again.
- The token ledger changes balances in one statement. A balance cannot go below zero, a repeated idempotency key applies once, and a charge gets at most one refund.

## Not built, and known gaps

- Email is printed to the console. No real mail provider is connected.
- Linking an identity to a signed-in account answers 501.
- Telegram, WhatsApp, Google and student verification.
- Study sessions, streak, leaderboard, Wrapped, courses, guest Ask, chat, files, push, payments and the bot endpoints.
- Nothing has been run against a real Postgres through the `pg` driver. The migration and queries run on PGlite, which is real Postgres compiled to WebAssembly.
