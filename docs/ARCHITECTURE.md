# Agent Edit — System Architecture

> **Central principle.** AI decides what could be edited. The timeline shows exactly how it was edited. The creator always has the final say.

Status of each section is tracked in [Phased plan](#8-phased-development-plan). Anything described here but not yet shipped is design, not a claim that it works.

## 1. Environment findings (Phase 0)

| Item             | Finding                                                                                             | Consequence                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Repository       | Empty, not a git repo                                                                               | Greenfield; nothing to preserve                                                          |
| Node / npm       | 26.13 / 11.20; no pnpm                                                                              | npm workspaces, no extra tooling                                                         |
| Docker           | CLI + Compose via Colima; the `vdo` project's stack shares this runtime and publishes Redis on 6379 | All infra runs through `docker-compose.yml`; Agent Edit's Redis is on host port **6380** |
| MongoDB, Redis   | Not installed                                                                                       | Containers only                                                                          |
| FFmpeg / FFprobe | 9.0.2 via Homebrew, with libx264, aac and flac                                                      | Required on any machine running the worker                                               |
| Ollama           | Running; `gemma3:4b`, `qwen3:1.7b`, `qwen3:8b`                                                      | Free local LLM adapter is viable for development                                         |
| Hardware         | Apple Silicon, 10 cores, 24 GB, 261 GB free                                                         | Local Whisper is viable; long proxies and renders are slow but workable                  |

## 2. System overview

```
                         Browser (apps/web)
     React · Zustand (editor) · React Query (server) · PlaybackEngine
        │ REST + cookie       │ WebSocket            │ PUT parts / GET proxy
        ▼                     ▼                      │ (presigned URLs, bytes
 ┌──────────────── apps/api (Fastify) ─────────┐     │  never pass through API)
 │ auth · projects · media · uploads · timeline│     │
 │ agent · render · realtime gateway           │     │
 └──┬───────────────┬──────────────────┬───────┘     │
    │               │ enqueue          │ presign     │
    ▼               ▼                  ▼             ▼
 MongoDB          Redis          S3-compatible object storage
 (metadata,    (BullMQ, pub/sub,  originals/ (immutable)
  op log,       rate limits,      derived/ (proxy, thumbs, waveform, audio)
  versions)     heartbeats)       renders/
    ▲               │ jobs             ▲
    │               ▼                  │
 ┌──┴──────────── apps/worker ─────────┴──┐
 │ media (probe, thumbs, waveform, proxy) │──► FFmpeg / FFprobe (no shell,
 │ analysis (STT, scenes, speakers, ...)  │    per-job temp dir, limits)
 │ agent (edit planner)                   │──► AI providers via adapters
 │ render (timeline → filter graph)       │
 └────────────────────────────────────────┘
```

### Monorepo layout

```
apps/web                 React editor
apps/api                 HTTP + WebSocket; never runs heavy work
apps/worker              BullMQ consumers; the only process that spawns FFmpeg
packages/shared          Time math, IDs, constants, error codes (no dependencies)
packages/validation      Zod schemas: the single contract for API, DB and operations
packages/infra           MongoDB documents, S3 storage, queues and events shared by API and worker
packages/timeline-engine Pure operation reducer + invariants (Phase 3)
packages/media-engine    FFmpeg steps with no knowledge of queues or storage; render compiler (Phase 5)
packages/ai-engine       Provider adapters, edit planner, plan compiler (Phase 4)
```

Packages are created in the phase that gives them real content. Empty placeholders would imply work that does not exist.

### Key decisions

| Decision         | Choice                                                            | Why                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time unit        | Integer **flicks** (705,600,000/s)                                | Exact for 23.976–60 fps and 44.1/48 kHz, so splits and sums never drift. JSON-safe up to about 147 days. Floats and microseconds both accumulate rounding error at 29.97 fps.      |
| Timeline storage | One Mongo document per timeline, compare-and-set on `revision`    | Single-document writes are atomic without a replica set. 16 MB holds tens of thousands of clips.                                                                                   |
| Edit authority   | Pure reducer shared by client and server                          | The same code runs optimistic edits, AI preview and server commit, so the three cannot disagree.                                                                                   |
| History          | Append-only transaction log; undo is a new transaction            | Nothing is ever rewritten; AI vs. manual attribution survives undo.                                                                                                                |
| Uploads          | Browser → S3 multipart with presigned URLs                        | API stays small; resume is `ListParts`, not custom state.                                                                                                                          |
| Object storage   | SeaweedFS in development, any S3-compatible service in production | Tested against presigned multipart, `ListParts` resume, ETag under CORS, range requests and signature rejection before adoption. The MinIO image could not be pulled when checked. |
| Sessions         | Opaque token, SHA-256 stored in Mongo, httpOnly cookie            | Instantly revocable; no JWT key management.                                                                                                                                        |
| ODM              | Native driver + Zod                                               | One schema source; no parallel Mongoose definitions.                                                                                                                               |
| Password hash    | `node:crypto` scrypt                                              | No native addon to break across Node versions.                                                                                                                                     |

## 3. Data flow

**Ingest.**

1. `POST /uploads` validates name, size and extension, then creates a `MediaAsset(uploading)` and an S3 multipart upload.
2. The browser requests presigned part URLs in batches and PUTs parts with bounded parallelism.
3. To resume, the client matches on a file fingerprint, calls `GET /uploads/:id` (server-side `ListParts`) and sends only the missing parts.
4. `complete` verifies with `HeadObject` and enqueues `media.probe`. FFprobe decides whether the file is real media; the extension is never trusted.
5. A job DAG fans out: `probe → {thumbnails, waveform, proxy, audio} → analysis steps`. Each step is an `AnalysisJob` with real progress, published through Redis pub/sub to the WebSocket gateway.

**Manual edit.**

1. A gesture produces operations.
2. The local reducer applies them optimistically.
3. `POST /timelines/:id/transactions {baseRevision, idempotencyKey, ops}` reaches the server.
4. The server replays them on its own state, validates invariants, and commits with compare-and-set.
5. A `409` triggers refetch and replay. A failed validation rolls the client back.

**Agent edit.**

```
instruction → enqueue agent.plan → worker retrieves context (timeline, chapter
summaries, transcript search) → LLM with read-only tools → structured plan (seconds)
→ Zod validation → compile to canonical ops (ticks, frame-snapped, IDs assigned)
→ dry-run in reducer → AgentRun(proposed) → client previews via the same reducer
→ user approves all or a subset → transaction(source=ai) → automatic snapshot first
```

The LLM has no database access. Its only output channel is a plan that must survive validation and a dry run. Transcript text is untrusted input and is delimited as data in prompts, so a spoken "ignore your instructions" cannot gain any capability beyond proposing operations the user must still approve.

**Render.** `POST /renders` snapshots the timeline revision, then a worker compiles it to a filter graph against **original** media, writes to `renders/`, streams progress, and the API serves a signed download URL.

## 4. Database schemas

All IDs are prefixed random strings (`prj_…`, `clip_…`). All times are integer ticks unless the field says otherwise. Large media never enters MongoDB.

```ts
User            { _id, email (unique), passwordHash, displayName, createdAt, updatedAt }
Session         { _id, tokenHash (unique), userId, createdAt, expiresAt (TTL), userAgent }

Project         { _id, ownerId, name, settings: { aspectRatio, width, height, frameRate: {num, den} },
                  mainTimelineId?, createdAt, updatedAt, deletedAt? }

MediaAsset      { _id, projectId, ownerId, name, folder?, kind: video|audio|image,
                  status: uploading|uploaded|processing|ready|failed,
                  upload: { s3UploadId, partSize, fingerprint, size, contentType },
                  storage: { originalKey, proxyKey?, audioKey?, waveformKey?, thumbnailKeys[] },
                  probe?: { duration, width, height, frameRate, isVfr, videoCodec, audioCodec,
                            audioChannels, sampleRate, bitrate, rotation }, createdAt, updatedAt }

AnalysisJob     { _id, projectId, mediaId, step, status: queued|running|done|failed|skipped,
                  progress (0..1, real values only), provider: { id, isMock }, attempts, error?,
                  startedAt?, finishedAt? }            // unique (mediaId, step)

Transcript      { _id, mediaId, language, provider, isMock, segmentCount }
TranscriptSegment { _id, transcriptId, mediaId, start, end, speakerId?, text,
                    words: [{ w, s, e, conf }] }       // index (mediaId, start); text index
Scene           { _id, mediaId, start, end, score, visualSummary?, provider?, isMock }
Speaker         { _id, mediaId, label, name?, totalSpeechTicks, provider, isMock }
Moment          { _id, mediaId, kind: hook|highlight|chapter|repeated_take|silence,
                  start, end, score, title?, reason, provider, isMock }

Timeline        { _id, projectId, kind: main|short, name, revision, frameRate, width, height,
                  tracks: TimelineTrack[], createdAt, updatedAt }
TimelineTrack   { id, type: VIDEO|BROLL|AUDIO|MUSIC|CAPTIONS|OVERLAYS, name, locked, muted, volume,
                  clips: TimelineClip[] }

TimelineClip    // base
                { id, start, duration, speed, volume, enabled,
                  transform: { x, y, scale, rotation, opacity },
                  audio: { normalize, denoise, fadeIn, fadeOut },
                  transitionIn?, transitionOut? }
                // kind = media:   { sourceMediaId, sourceIn, sourceOut }
                // kind = caption: { text, style: { font, size, color, background, position } }

EditTransaction { _id, timelineId, revision (unique with timelineId), baseRevision, idempotencyKey
                  (unique), source: manual|ai|undo|redo|restore, author: { userId, agentRunId?,
                  model? }, ops[], inverseOps[], undoes?, summary?, createdAt }
TimelineVersion { _id, timelineId, revision, name, trigger: manual|pre_ai|pre_restore,
                  snapshot: Timeline, createdBy, createdAt }

AgentRun        { _id, projectId, timelineId, instruction, status: queued|planning|proposed|
                  applied|rejected|stale|failed, baseRevision, plan?, ops?, rejectedOps?,
                  provider: { id, model, isMock }, appliedTransactionId?, createdAt }
RenderJob       { _id, projectId, timelineId, revision, preset, status, progress, attempts, logKey?,
                  outputKey?, outputSize?, error?, createdAt, finishedAt? }
```

Additions beyond the brief, because the design needs them: `Session`, `TranscriptSegment` (a 3-hour transcript must not be one unbounded document), `Moment`, `EditTransaction` (the concrete form of `EditOperation` plus its grouping) and `AgentRun`.

## 5. Timeline operation protocol

Implemented as Zod schemas in [packages/validation/src/operations.ts](../packages/validation/src/operations.ts).

### Two layers

1. **Agent plan** (LLM-facing): seconds, a human-readable `reason`, and the shape from the brief, for example `{operation:"trim_clip", clipId, newStart, newEnd, reason}`.
2. **Canonical ops** (engine-facing): integer ticks, frame-snapped, with absolute post-state values and pre-assigned IDs.

Keeping them separate means a model can never produce an off-grid time, and the LLM format can change without migrating history.

### Canonical operations

| Operation                                              | Payload                                               | Notes                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `add_clip` / `add_broll` / `add_music` / `add_caption` | `{ trackId, clip }`                                   | Full clip with assigned ID. The variant is enforced against track type. |
| `remove_clip`                                          | `{ clipId }`                                          |                                                                         |
| `trim_clip`                                            | `{ clipId, start, duration, sourceIn, sourceOut }`    | Absolute values                                                         |
| `split_clip`                                           | `{ clipId, at, newClipId }`                           | ID pre-assigned, so a retry is deterministic                            |
| `move_clip`                                            | `{ clipId, start }`                                   | Same track                                                              |
| `change_track`                                         | `{ clipId, trackId, start }`                          | Track types must be compatible                                          |
| `change_volume`                                        | `{ clipId, volume }`                                  | 0–4 linear                                                              |
| `change_speed`                                         | `{ clipId, speed, duration }`                         | Source range unchanged                                                  |
| `update_transition`                                    | `{ clipId, side, transition \| null }`                |                                                                         |
| `update_audio`                                         | `{ clipId, normalize?, denoise?, fadeIn?, fadeOut? }` | Added: the demo needs "normalize dialogue"                              |
| `update_caption`                                       | `{ clipId, text?, style? }`                           | Added: captions must be editable                                        |
| `update_transform`                                     | `{ clipId, transform }`                               | Added: reframing and manual transform                                   |
| `set_clip_enabled`                                     | `{ clipId, enabled }`                                 | Added: enable/disable                                                   |
| `update_track`                                         | `{ trackId, locked?, muted?, volume? }`               | Added: track controls. The one operation allowed on a locked track.     |

Ripple delete is not an operation. It compiles to `remove_clip` plus `move_clip`s, so every effect stays visible in the preview.

### Invariants (checked after every transaction)

- A referenced clip and track exist; IDs are unique across the timeline.
- Clips on one track do not overlap. `start` and `duration` lie on the sequence frame grid; `duration > 0`.
- `sourceIn < sourceOut ≤ media.duration`. The source span matches `duration × speed` to within one source frame.
- Clip kind is compatible with track type; locked tracks reject edits.
- A referenced media asset belongs to the same project.

### Transaction semantics

- **All or nothing.** Ops apply to an in-memory copy; any failure discards the copy. The stored document changes only through a single compare-and-set: `findOneAndUpdate({_id, revision: base}, …)`.
- **Safe to retry.** A repeated `idempotencyKey` returns the original result.
- **Crash safety.** The `EditTransaction` is inserted first, with unique `(timelineId, revision)` acting as the lock, and then the timeline is updated. If a crash separates the two, reads detect `lastTxn.revision > timeline.revision` and roll forward, because replay is deterministic.
- **Undo.** Each transaction stores `inverseOps`. Undo applies them as a new transaction with `undoes: <id>`, so an AI edit undoes as one unit.
- **Conflicts.** A proposal whose `baseRevision` is stale is re-validated against the current state. If it no longer applies cleanly, it is marked `stale` and the user is told. It never overwrites newer edits.

## 6. Video, playback and rendering

**Proxy.** 720p H.264 with 1-second GOPs, AAC audio, `+faststart`; streamed with HTTP range requests through signed URLs. Whole files never enter browser memory.

**Playback.** A `PlaybackEngine` lives outside React and owns a master clock, a small per-track pool of `<video>` elements (current and pre-rolled next clip), and WebAudio gain nodes. It uses `requestVideoFrameCallback` for drift correction. The playhead updates through refs, so playback does not re-render React. Only visible clips mount.

**Known limitation, stated up front.** `<video>` seeks are not frame-guaranteed. Expect up to about ±1 frame at cut points and brief gaps on rapid multi-track cuts. Timeline _data_ and the final _render_ stay frame-accurate. WebCodecs is the upgrade path if preview precision becomes the bottleneck.

**Measured on a 500-clip timeline** (`e2e/editor.mjs`): 6 clips mounted at once, scrolling at 16.9 ms per frame at the 95th percentile, and 178 ms from an edit to the server's confirmation.

**Render compiler.** A pure function from a timeline snapshot to FFmpeg arguments, always against **original** footage. It uses per-clip `trim`/`setpts`/`scale`/`overlay` for picture and `atempo`/`volume`/`afftdn`/`amix` for sound, with captions burned in through `ass`, and the graph is passed as a file so long timelines do not hit argument limits.

Timelines render in **chunks** of at most 5 minutes or 24 clips, each its own FFmpeg process, joined without re-encoding. One command would hold a decoder open per clip and memory would grow with clip count. A retry repeats only unfinished chunks, and chunk boundaries are moved out of any fade. Audio stays PCM until the final join, so no AAC gap appears at a seam.

**Normalization** measures each clip's loudness once and applies a fixed gain toward -16 LUFS, capped at 20 dB. A fixed gain cannot pump, and it is unaffected by chunking.

**Verification.** A job only reports success after probing its own output for the expected length and size. Tests go further and read real pixels and audio levels back out of rendered files.

**Fades.** `fade_black` fades against whatever is underneath. A true crossfade needs two overlapping clips on a track, which the timeline does not allow, so the UI does not offer one.

**FFmpeg safety.** Worker process only; `spawn` with an argv array and no shell; `-nostdin`; `-protocol_whitelist file,pipe` plus `-format_whitelist mov,matroska,webm`. The second flag matters: a file named `.mp4` whose content is an ffconcat script would otherwise follow relative paths to sibling files, and a test proves that attack succeeds without it. Each job gets its own scratch directory, a read-only source copy and a kill-on-stall timer. Originals are never modified, and storage keys are generated rather than taken from user input.

**Not implemented yet:** per-process CPU and memory limits. In production these belong on the worker container, which must be isolated from the API and from secrets it does not need.

**Processing pipeline.** `complete` seeds one `AnalysisJob` per step and enqueues `probe`, which enqueues `thumbnails`, `waveform`, `proxy` and `audio`. Proxy encodes have their own queue so a long encode cannot delay quick steps on other footage. BullMQ job ids are deterministic, so enqueueing is safe to repeat. Required steps are `probe` and `proxy`; if a thumbnail or waveform step fails, the asset is still usable and the failure stays visible and retryable. A periodic sweep purges deleted media, aborts uploads abandoned for 7 days, requeues jobs whose queue entry was lost and removes stale scratch directories.

**Measured on a 3-hour, 3.32 GB file** (Apple Silicon, 10 cores; `npm run test:long`): processing took 9.6 minutes including a crash, about 19x real time. Peak memory was 264 MB for the worker, 314 MB for FFmpeg and 32 MB of browser heap. Seeking the proxy to the 2-hour mark took about 200 ms. The footage is synthetic noise, so these are indicative rather than a benchmark of real recordings.

**Realtime.** Workers publish to Redis; the API relays to sockets watching that project. MongoDB stays the source of truth, so a missed event costs nothing beyond a refetch. The client treats 60 seconds without a server heartbeat, or a browser `offline` event, as a lost connection, says so, and polls until it reconnects.

## 7. AI and infrastructure requirements

Every capability sits behind a provider interface selected by environment variable, and every result records `provider` and `isMock`. The UI labels mock output as demo data.

| Capability                | Free / local                                                         | Paid                             | Plan                            |
| ------------------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------- |
| Silence, scenes, loudness | FFmpeg `silencedetect`, `scdet`, `loudnorm`                          | None                             | Always local; no adapter needed |
| Speech-to-text            | whisper.cpp (word timestamps; about real-time or faster on this Mac) | Deepgram, AssemblyAI, OpenAI     | **Decide in Phase 4**           |
| LLM edit planner          | Ollama (installed; small models, quality on long footage unproven)   | Anthropic, OpenAI, Google        | **Decide in Phase 4**           |
| Vision summaries          | Ollama vision model, sampled frames                                  | Same LLM providers               | Follows LLM choice              |
| Speaker segmentation      | pyannote (needs Python and a free HF token)                          | Bundled with Deepgram/AssemblyAI | Follows STT choice              |
| B-roll source             | User's own uploads                                                   | Stock API, generative video      | User uploads first              |
| Reframing                 | Local face detection (ONNX); centre crop fallback                    | None                             | Phase 6                         |

Infrastructure: MongoDB, Redis (`noeviction`, which BullMQ requires) and S3-compatible storage all run in local containers at no cost. Production hosting is a later decision and no paid service is introduced without asking.

### How the agent is built

The model outputs a **plan**, never timeline edits. A deterministic compiler turns each step into exact operations using measured facts (silence ranges, repeated takes, word timings), and the reducer dry-runs every step. A small local model therefore produces a worse plan, not a corrupted timeline, and a step that cannot apply is reported on its own while the rest still work. Only the creator's approval in the API can commit anything, and it recompiles against the current timeline so newer edits are never overwritten.

**Tested end to end on this Mac:** whisper.cpp `base.en` and Ollama `qwen3:8b`. The Claude and Deepgram adapters are tested against local stand-ins only, because no paid key was used. Speaker identification requires Deepgram: whisper.cpp does not provide it and the step says so.

## 8. Phased development plan

| Phase                | Scope                                                                                                                 | Acceptance                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **1. Foundation** ✅ | Monorepo, web/api/worker, Mongo, Redis, shared contracts, auth, project CRUD                                          | Tests pass against real services; browser walk-through works          |
| **2. Media** ✅      | Storage, resumable multipart upload, FFprobe, thumbnails, waveform, proxy, job DAG, WebSocket progress, media library | Interrupt and resume a multi-GB upload; proxy plays                   |
| **3. Timeline** ✅   | `timeline-engine`, op log, multi-track editor, playback, undo/redo, versions                                          | Every gesture changes persisted state; 500-clip timeline stays smooth |
| **4. AI** ✅         | Adapters, transcription, scenes, speakers, moments, planner, proposal flow                                            | Plan → preview → apply → undo with attribution                        |
| **5. Render** ✅     | Compiler, multi-track output, audio, captions, export jobs, signed download                                           | Output duration and streams match the timeline when probed            |
| **6. Advanced**      | B-roll, Shorts as independent timelines, reframing, advanced audio                                                    | Demo steps 7–11 end to end                                            |
| **7. Hardening**     | Profiling, integration tests, security review, render validation                                                      | The full 15-step demo is the acceptance test                          |

Each phase ends with: what was built, files changed, test results, what works, remaining limitations and the exact next step.
