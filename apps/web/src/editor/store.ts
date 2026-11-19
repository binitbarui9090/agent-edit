import {
  TimelineError,
  applyOperations,
  findClip,
  type MediaLookup,
} from '@agent-edit/timeline-engine';
import type { Timeline, TimelineOperation } from '@agent-edit/validation';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import { commitTransaction, getTimeline, redoTimeline, undoTimeline } from '../api/timelines';

interface PendingEdit {
  ops: TimelineOperation[];
  summary: string;
  idempotencyKey: string;
}

export const MIN_PX_PER_SECOND = 0.02;
export const MAX_PX_PER_SECOND = 400;
const DEFAULT_PX_PER_SECOND = 40;
const RETRY_DELAY_MS = 1500;

interface EditorState {
  /** Confirmed state plus unconfirmed local edits: what the user sees and acts on. */
  timeline: Timeline | null;
  selection: readonly string[];
  pxPerSecond: number;
  saving: boolean;
  /** The server is unreachable and edits are waiting to be sent. */
  offline: boolean;
  error: string | null;
  /** An agent proposal shown on the timeline without being applied. */
  previewRunId: string | null;
  previewClipIds: ReadonlySet<string>;
  snapping: boolean;
  /** Bumped when a clip is picked on the timeline, which brings its properties into view. */
  inspectRequest: number;
}

export const useEditor = create<EditorState>(() => ({
  timeline: null,
  selection: [],
  pxPerSecond: DEFAULT_PX_PER_SECOND,
  saving: false,
  offline: false,
  error: null,
  previewRunId: null,
  previewClipIds: new Set(),
  snapping: true,
  inspectRequest: 0,
}));

let confirmed: Timeline | null = null;
let pending: PendingEdit[] = [];
let draining: Promise<void> | null = null;
let mediaLookup: MediaLookup | undefined;

/** Rebuilds the view by replaying local edits on confirmed state. An edit that no longer fits is dropped. */
function recompute(): void {
  if (!confirmed) return;
  let view: Timeline = confirmed;
  const kept: PendingEdit[] = [];
  for (const edit of pending) {
    try {
      view = { ...view, ...applyOperations(view, edit.ops).state };
      kept.push(edit);
    } catch (err) {
      if (!(err instanceof TimelineError)) throw err;
      useEditor.setState({
        error: `An edit no longer applies, because the timeline changed: ${err.message}`,
      });
    }
  }
  pending = kept;
  // Any real change underneath makes a proposal's preview out of date.
  useEditor.setState((state) => ({
    previewRunId: null,
    previewClipIds: new Set<string>(),
    timeline: view,
    selection: state.selection.filter((id) => findClip(view, id)),
    saving: pending.length > 0,
  }));
}

async function drain(projectId: string): Promise<void> {
  while (pending.length > 0 && confirmed) {
    const edit = pending[0]!;
    try {
      const { timeline } = await commitTransaction(projectId, confirmed.id, {
        baseRevision: confirmed.revision,
        idempotencyKey: edit.idempotencyKey,
        ops: edit.ops,
        summary: edit.summary,
      });
      confirmed = timeline;
      pending.shift();
      useEditor.setState({ offline: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        // Someone else moved the timeline. Fetch it and replay local edits on top.
        confirmed = await getTimeline(projectId, confirmed.id);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // The server's reducer has the last word. Drop the edit and show what is actually stored.
        pending.shift();
        useEditor.setState({ error: err.message });
        confirmed = await getTimeline(projectId, confirmed.id);
      } else {
        // Unreachable. The idempotency key makes retrying safe even if the request did land.
        useEditor.setState({ offline: true });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    recompute();
  }
}

function startDraining(projectId: string): Promise<void> {
  draining ??= drain(projectId).finally(() => {
    draining = null;
    useEditor.setState({ saving: pending.length > 0 });
  });
  return draining;
}

export function loadTimeline(timeline: Timeline): void {
  confirmed = timeline;
  pending = [];
  useEditor.setState({ timeline, selection: [], saving: false, offline: false, error: null });
}

export function setMediaLookup(lookup: MediaLookup | undefined): void {
  mediaLookup = lookup;
}

/**
 * Applies an edit at once and sends it to the server in order. Throwing here means the edit was
 * invalid and nothing changed, so callers can leave the UI where it was.
 */
export function commitEdit(ops: TimelineOperation[], summary: string): boolean {
  const { timeline: view, previewRunId } = useEditor.getState();
  if (!view || ops.length === 0) return false;
  if (previewRunId) {
    useEditor.setState({ error: 'Stop the preview before editing. Nothing in it is applied yet.' });
    return false;
  }
  try {
    const { state } = applyOperations(view, ops, mediaLookup);
    pending.push({ ops, summary, idempotencyKey: crypto.randomUUID() });
    useEditor.setState((current) => ({
      timeline: { ...view, ...state },
      saving: true,
      error: null,
      selection: current.selection.filter((id) => findClip(state, id)),
    }));
    void startDraining(view.projectId);
    return true;
  } catch (err) {
    if (!(err instanceof TimelineError)) throw err;
    useEditor.setState({ error: err.message });
    return false;
  }
}

/** Waits for local edits to land, so undo and export act on what the user actually sees. */
export async function flushEdits(): Promise<Timeline | null> {
  const view = useEditor.getState().timeline;
  if (view && pending.length > 0) await startDraining(view.projectId);
  return confirmed;
}

async function step(action: typeof undoTimeline): Promise<void> {
  clearPreview();
  const current = await flushEdits();
  if (!current) return;
  try {
    const { timeline } = await action(current.projectId, current.id, current.revision);
    confirmed = timeline;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'revision_conflict') {
      confirmed = await getTimeline(current.projectId, current.id);
      useEditor.setState({ error: 'The timeline changed elsewhere. Try again.' });
    } else {
      useEditor.setState({ error: err instanceof Error ? err.message : 'Could not do that' });
    }
  }
  recompute();
}

export const undo = () => step(undoTimeline);
export const redo = () => step(redoTimeline);

/** For anything that changed the timeline on the server: another tab, the agent, a restore. */
export async function syncFromServer(revision?: number): Promise<void> {
  if (!confirmed) return;
  if (revision !== undefined && revision <= confirmed.revision) return;
  if (pending.length > 0) return; // The drain loop reconciles when it next talks to the server.
  confirmed = await getTimeline(confirmed.projectId, confirmed.id);
  recompute();
}

/** Shows a proposal on the timeline and in playback. Nothing is stored or sent. */
export function showPreview(
  runId: string,
  ops: TimelineOperation[],
  clipIds: readonly string[],
): void {
  recompute();
  const view = useEditor.getState().timeline;
  if (!view) return;
  try {
    const { state } = applyOperations(view, ops);
    useEditor.setState({
      timeline: { ...view, ...state },
      previewRunId: runId,
      previewClipIds: new Set(clipIds),
      selection: [],
    });
  } catch (err) {
    if (!(err instanceof TimelineError)) throw err;
    useEditor.setState({ error: `This plan no longer fits the timeline: ${err.message}` });
  }
}

export function clearPreview(): void {
  if (useEditor.getState().previewRunId) recompute();
}

export function adoptTimeline(timeline: Timeline): void {
  confirmed = timeline;
  recompute();
}

export function selectClips(ids: readonly string[]): void {
  useEditor.setState({ selection: ids });
}

export function toggleClip(id: string, additive: boolean): void {
  useEditor.setState((state) => {
    if (!additive) return { selection: [id] };
    return {
      selection: state.selection.includes(id)
        ? state.selection.filter((other) => other !== id)
        : [...state.selection, id],
    };
  });
}

export function setZoom(pxPerSecond: number): void {
  useEditor.setState({
    pxPerSecond: Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, pxPerSecond)),
  });
}

export function toggleSnapping(): void {
  useEditor.setState((state) => ({ snapping: !state.snapping }));
}

export function requestInspect(): void {
  useEditor.setState((state) => ({ inspectRequest: state.inspectRequest + 1 }));
}

export function clearEditorError(): void {
  useEditor.setState({ error: null });
}
