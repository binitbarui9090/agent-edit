# Agent Edit

An AI-native video editor. Upload raw footage, describe the edit, and review an agent's proposal as real, reversible operations on a multi-track timeline. The creator always has the final say.

**Status: Phase 2 of 7 (media).** Accounts, projects, resumable uploads, background processing and the media library work. Timeline, AI and rendering are not built yet, and the UI says so rather than showing dead controls. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Requires Node 22.12+, Docker (Colima or Docker Desktop) and FFmpeg (`brew install ffmpeg`).

```sh
npm install
cp .env.example .env
npm run infra:up      # MongoDB on 27017, Redis on 6380, S3 storage on 8333
npm run dev           # web on :5173, API on :4000, plus the worker
```

Open http://localhost:5173 and create an account. `GET /health/ready` reports MongoDB, Redis, storage and live worker count.

## Check it

| Command             | What it does                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | Strict TypeScript across every package, app and test                                                                                                      |
| `npm test`          | Unit and integration tests against the real MongoDB, Redis, storage and FFmpeg, using throwaway databases, buckets and key prefixes. Requires `infra:up`. |
| `npm run test:e2e`  | Browser walkthrough of the real app. Requires `npm run dev`. First run needs `npx playwright install chromium`.                                           |
| `npm run test:long` | Three-hour multi-GB file: interrupted upload, worker killed mid-encode, memory measured. Takes tens of minutes. Requires `npm run dev`.                   |
| `npm run build`     | Production build of everything; run with `npm start -w @agent-edit/api` and `-w @agent-edit/worker`                                                       |

## Layout

```
apps/web              React editor (Vite, CSS Modules, React Query)
apps/api              Fastify API; never runs heavy work
apps/worker           BullMQ consumers; the only place FFmpeg will run
packages/shared       Time math, IDs, formats, error codes
packages/validation   Zod schemas shared by API, web and timeline operations
packages/infra        MongoDB documents, S3 storage, queues and events
packages/media-engine FFmpeg steps: probe, proxy, thumbnails, waveform, audio
```

`timeline-engine` and `ai-engine` join `packages/` in the phases that give them real content.
