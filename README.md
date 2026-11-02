# Agent Edit

An AI-native video editor. Upload raw footage, describe the edit, and review an agent's proposal as real, reversible operations on a multi-track timeline. The creator always has the final say.

**Status: Phase 1 of 7 (foundation).** Accounts and projects work. Upload, timeline, AI and rendering are not built yet, and the UI says so rather than showing dead controls. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Requires Node 22.12+ and Docker (Colima or Docker Desktop).

```sh
npm install
cp .env.example .env
npm run infra:up      # MongoDB on 27017, Redis on 6380
npm run dev           # web on :5173, API on :4000, plus the worker
```

Open http://localhost:5173 and create an account. `GET /health/ready` reports MongoDB, Redis and live worker count.

## Check it

| Command             | What it does                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | Strict TypeScript across every package, app and test                                                                            |
| `npm test`          | Unit and integration tests against the real MongoDB and Redis, using throwaway databases and key prefixes. Requires `infra:up`. |
| `npm run test:e2e`  | Browser walkthrough of the real app. Requires `npm run dev`. First run needs `npx playwright install chromium`.                 |
| `npm run build`     | Production build of everything; run with `npm start -w @agent-edit/api` and `-w @agent-edit/worker`                             |

## Layout

```
apps/web              React editor (Vite, CSS Modules, React Query)
apps/api              Fastify API; never runs heavy work
apps/worker           BullMQ consumers; the only place FFmpeg will run
packages/shared       Time math, IDs, formats, error codes
packages/validation   Zod schemas shared by API, web and timeline operations
```

`timeline-engine`, `media-engine` and `ai-engine` join `packages/` in the phases that give them real content.
