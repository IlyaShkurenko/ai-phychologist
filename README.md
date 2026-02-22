# Telegram Chat Analyzer (MVP)

MVP web app for analyzing selected Telegram messages using TDLib + OpenAI.

## What this MVP does

- Connects one Telegram account per session.
- Supports Telegram auth flow: phone, code, optional 2FA password.
- Supports QR login flow (scan in Telegram app).
- Shows chats list and chat message history.
- Sends only selected message subsets for analysis:
  - last 300 messages
  - date range
  - manually selected messages
- Provides configurable analysis options in a collapsible bottom sheet.
- Displays concise structured analysis with summary/signals/reply options/outcomes.
- Includes `Prompts` tab to manage versioned gaslighting system prompts (step1/step2/step3) with active version selection.

## Privacy/storage policy (MVP)

- Full chat history is **not persisted** in app databases.
- Session state is in-memory in `api` and `tdlib-service` with TTL cleanup.
- TDLib local storage is used only for Telegram client state/auth keys.
- Analysis results are returned to UI and kept in browser memory only.

## Architecture

- `web` (React + TypeScript + Vite)
- `api` (Node.js + Express + TypeScript + WebSocket)
- `tdlib-service` (Node.js + Express + TypeScript + TDLib adapter, SSE events)

Flow:

1. Web calls `POST /api/sessions`.
2. API creates session in `tdlib-service` and returns `sessionId`.
3. Web opens `ws://.../ws?sessionId=...` to API.
4. API bridges TDLib SSE events to web socket.
5. On analysis request, API fetches selected messages from TDLib service and calls OpenAI.

## Requirements

- Node.js 20+ (22 recommended)
- npm 10+
- Telegram API credentials for real TDLib mode (`TDLIB_API_ID`, `TDLIB_API_HASH`)
- OpenAI API key for model-backed analysis (`OPENAI_API_KEY`)

## Environment variables

Copy `.env.example` to `.env` and adjust values.

### Core

- `API_PORT` (default `4001`)
- `TDLIB_BASE_URL` (default `http://localhost:4002`)
- `OPENAI_API_KEY` (optional; if empty, API uses fallback heuristic analysis)
- `OPENAI_MODEL` (default `gpt-5.2`)
- `VITE_REQUEST_TIMEOUT_MS` (optional; default `60000`)
- `TDLIB_REQUEST_TIMEOUT_MS` (optional; default `30000`)
- `SESSION_TTL_MS` (default `604800000` = 7 days)
- `TDLIB_REQUEST_TIMEOUT_MS` (default `60000`)
- `TDLIB_RANGE_REQUEST_TIMEOUT_MS` (default `180000`)
- `RANGE_SCAN_MAX_BATCHES` (default `500`)
- `MONGODB_URI` (required for prompt version storage)
- `MONGODB_DB_NAME` (default `telegram_chat_analyzer`)
- `MONGODB_PROMPTS_COLLECTION` (default `prompt_versions`)

### TDLib service

- `TDLIB_SERVICE_PORT` (default `4002`)
- `TDLIB_MODE` (`mock` or `real`, default `mock`)
- `TDLIB_API_ID` (required in `real`)
- `TDLIB_API_HASH` (required in `real`)
- `TDLIB_LIBRARY_PATH` (optional path to TDLib binary)
- `TDLIB_DATA_DIR` (default `./tdlib-data`)

### Web

- `VITE_API_BASE_URL` (default `http://localhost:4001`)
- `VITE_REQUEST_TIMEOUT_MS` (default `60000`)
- `VITE_RANGE_REQUEST_TIMEOUT_MS` (default `300000`)

## Run locally (without Docker)

1. Install dependencies:

```bash
npm install
```

2. Start all services in separate terminals:

```bash
npm run dev --workspace tdlib-service
npm run dev --workspace api
npm run dev --workspace web
```

3. Open:

- Web: `http://localhost:5173`
- API health: `http://localhost:4001/health`
- TDLib service health: `http://localhost:4002/health`

## Run with Docker Compose

```bash
docker compose up --build
```

Then open `http://localhost:5173`.

## TDLib mode notes

- Default mode is `mock` so UI/flow can be tested immediately.
- Switch to `real` by setting:

```env
TDLIB_MODE=real
TDLIB_API_ID=...
TDLIB_API_HASH=...
```

If your environment needs explicit TDLib binary path, set `TDLIB_LIBRARY_PATH`.

### Troubleshooting: `Dynamic Loading Error ... libtdjson.dylib`

On macOS, install TDLib native library and point the service to it:

```bash
brew install tdlib
```

Then in `.env`:

```env
TDLIB_MODE=real
TDLIB_LIBRARY_PATH=/opt/homebrew/lib/libtdjson.dylib
```

Common alternative path on Intel Mac: `/usr/local/lib/libtdjson.dylib`.

## Basic error handling included

- Telegram auth errors (wrong code/password)
- Unknown/expired sessions
- TDLib event stream failures with reconnect attempts
- OpenAI rate limiting guard (in-memory, per session)
- API retries for OpenAI analysis (small retry window)

## Prompt versioning (Gaslighting steps)

- Open `Prompts` tab in UI.
- Theme `Gaslighting` contains 3 editable steps (`step1`, `step2`, `step3`).
- Saving creates a **new version** for that step.
- Any version can be marked **active**.
- Active versions are loaded by backend and used as system prompts for gaslighting pipeline.
- Dynamic per-request transcript/context is still injected separately; only system prompt text is versioned.

## Mobile responsiveness

- Single-column layout on narrow screens
- Fixed bottom sheet remains usable on mobile
- Chat controls and analysis panel adapt to small widths

## MVP scope reminders

- No persistent message history database.
- No background monitoring.
- Text messages only.
- Single session/account at a time.
Quick diagnostics:

- `GET http://localhost:4001/health` now returns:
  - `openaiConfigured: true|false`
  - `openaiModel`
- If `openaiConfigured` is `false`, API process did not receive `OPENAI_API_KEY` at startup.
