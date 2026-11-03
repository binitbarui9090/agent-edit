# Agent Edit

An AI-native video editor. Upload raw footage, describe the edit, and review an agent's proposal as real, reversible operations on a multi-track timeline. The creator always has the final say.

All seven build phases are complete. The whole demonstration runs end to end: upload, analysis, an agent's plan, review, a manual edit, undo and redo, render, and download. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [its limitations section](docs/ARCHITECTURE.md#9-known-limitations) for what it does not do.

## Run it

Requires Node 22.12+, Docker (Colima or Docker Desktop) and FFmpeg with libass, which captions need (`brew install ffmpeg-full`, then set `FFMPEG_PATH` and `FFPROBE_PATH` from `.env.example`).

```sh
npm install
cp .env.example .env
npm run infra:up      # MongoDB on 27017, Redis on 6380, S3 storage on 8333
npm run dev           # web on :5173, API on :4000, plus the worker
```

Open http://localhost:5173 and create an account. `GET /health/ready` reports MongoDB, Redis, storage and live worker count.

## AI providers

Each capability is chosen in `.env`, and each can be off. Without a language model the agent falls back to labelled rule-based planning.

| Variable          | Free and local                                                      | Paid                                  |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `SPEECH_PROVIDER` | `whisper` (run `brew install whisper-cpp`, `npm run setup:whisper`) | `deepgram` (also identifies speakers) |
| `LLM_PROVIDER`    | `ollama` (`OLLAMA_MODEL`)                                           | `anthropic` (`ANTHROPIC_API_KEY`)     |
| `VISION_PROVIDER` | `ollama` (`OLLAMA_VISION_MODEL`)                                    | `anthropic`                           |

## Check it

| Command             | What it does                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | Strict TypeScript across every package, app and test                                                                                                            |
| `npm test`          | Unit and integration tests against the real MongoDB, Redis, storage and FFmpeg, using throwaway databases, buckets and key prefixes. Requires `infra:up`.       |
| `npm run test:demo` | The acceptance test: the full demonstration in a browser with real speech, Whisper and a language model, then transcribes the export. Requires `npm run dev`.   |
| `npm run test:e2e`  | Every other browser suite. Requires `npm run dev` and, on first use, `npx playwright install chromium`.                                                         |
| `npm run test:long` | A 3-hour, multi-GB file: interrupted upload, worker killed mid-encode, a 500-clip export and a full-length export, with memory measured. Takes an hour or more. |

The browser suites accept `E2E_BASE_URL`, so they can run against a production build too.

## Deploy it

`npm run build` builds everything. With `WEB_DIST=apps/web/dist` the API also serves the web app under a strict content security policy, so `npm start -w @agent-edit/api` and `npm start -w @agent-edit/worker` are a complete deployment behind TLS.

[compose.production.yml](compose.production.yml) runs the same thing in containers: one image per process, non-root, on read-only filesystems, with bounded resources for the worker. Its header lists what to configure. Replace every development credential first.

Local `.env` choices do not carry over: the images have no whisper.cpp, so use `SPEECH_PROVIDER=deepgram` or add it to the worker image.

## Layout

```
apps/web                  React editor (Vite, CSS Modules, Zustand, React Query)
apps/api                  Fastify API and WebSocket gateway. Never runs heavy work.
apps/worker               BullMQ consumers. The only place FFmpeg and models run.
packages/shared           Time math, IDs, formats, step graph, error codes
packages/validation       Zod schemas shared by API, web and timeline operations
packages/timeline-engine  The pure operation reducer shared by browser and server
packages/media-engine     FFmpeg: probing, proxies, analysis and the render compiler
packages/ai-engine        Provider adapters, planners and the plan compiler
packages/infra            MongoDB documents, S3 storage, queues and events
```
