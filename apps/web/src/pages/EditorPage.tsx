import { newId, secondsToTicks } from '@agent-edit/shared';
import {
  clipAt,
  createCaptionClip,
  deleteClipsOperations,
  findClip,
  firstTrackOfType,
} from '@agent-edit/timeline-engine';
import {
  mediaPlaybackSchema,
  type MediaAsset,
  type MediaPlayback,
  type TimelineOperation,
} from '@agent-edit/validation';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { request } from '../api/client';
import { useProjectEvents } from '../api/events';
import { useMedia } from '../api/media';
import { useProject } from '../api/projects';
import { getMainTimeline, getTimeline } from '../api/timelines';
import { Button } from '../components/Button';
import { FormError } from '../components/Field';
import { EditorContext } from '../editor/EditorContext';
import { HistoryPanel } from '../editor/HistoryPanel';
import { Inspector } from '../editor/Inspector';
import { MediaBin } from '../editor/MediaBin';
import { PlaybackEngine } from '../editor/playback';
import { Preview } from '../editor/Preview';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  clearEditorError,
  commitEdit,
  loadTimeline,
  redo,
  selectClips,
  setMediaLookup,
  setZoom,
  syncFromServer,
  undo,
  useEditor,
} from '../editor/store';
import { TimelineView } from '../editor/TimelineView';
import { errorMessage } from '../lib/form-errors';
import { NotFoundPage } from './NotFoundPage';
import styles from './EditorPage.module.css';

const PLAYBACK_REFRESH_MS = 30 * 60 * 1000;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function splitOperations(engineTime: number): TimelineOperation[] {
  const { timeline, selection } = useEditor.getState();
  if (!timeline) return [];
  const targets =
    selection.length > 0
      ? selection.flatMap((id) => {
          const found = findClip(timeline, id);
          return found ? [found.clip] : [];
        })
      : timeline.tracks.flatMap((track) => {
          if (track.locked) return [];
          const clip = clipAt(track, engineTime);
          return clip ? [clip] : [];
        });
  return targets
    .filter((clip) => clip.start < engineTime && clip.start + clip.duration > engineTime)
    .map((clip) => ({
      op: 'split_clip',
      clipId: clip.id,
      at: engineTime,
      newClipId: newId('clip'),
    }));
}

export function EditorPage() {
  const { id: projectId = '', timelineId } = useParams();
  const project = useProject(projectId);
  const timelineQuery = useQuery({
    queryKey: ['timeline', projectId, timelineId ?? 'main'],
    queryFn: () => (timelineId ? getTimeline(projectId, timelineId) : getMainTimeline(projectId)),
    // The store owns timeline state after this first load. Refetching here would overwrite edits.
    staleTime: Infinity,
    gcTime: 0,
  });

  const live = useProjectEvents(projectId, (revision) => void syncFromServer(revision));
  const mediaQuery = useMedia(projectId, live);
  const assets: MediaAsset[] = useMemo(
    () => mediaQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [mediaQuery.data],
  );
  const mediaMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  useEffect(() => {
    setMediaLookup((id) => {
      const duration = mediaMap.get(id)?.probe?.duration;
      return duration === undefined ? undefined : { duration };
    });
    return () => setMediaLookup(undefined);
  }, [mediaMap]);

  const loaded = timelineQuery.data;
  useEffect(() => {
    if (loaded) loadTimeline(loaded);
    return () => useEditor.setState({ timeline: null, selection: [] });
  }, [loaded]);

  const timeline = useEditor((state) => state.timeline);
  const saving = useEditor((state) => state.saving);
  const offline = useEditor((state) => state.offline);
  const editorError = useEditor((state) => state.error);
  const pxPerSecond = useEditor((state) => state.pxPerSecond);
  const [panel, setPanel] = useState<'inspector' | 'history'>('inspector');

  const usedMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const track of timeline?.tracks ?? []) {
      for (const clip of track.clips) {
        if (clip.kind === 'media') ids.add(clip.sourceMediaId);
      }
    }
    return [...ids];
  }, [timeline?.tracks]);

  const playbackResults = useQueries({
    queries: usedMediaIds.map((mediaId) => ({
      queryKey: ['playback', projectId, mediaId],
      queryFn: () =>
        request('GET', `/projects/${projectId}/media/${mediaId}`, { schema: mediaPlaybackSchema }),
      // Signed URLs last at least two hours, so refreshing well before that keeps playback going.
      refetchInterval: PLAYBACK_REFRESH_MS,
      staleTime: PLAYBACK_REFRESH_MS,
    })),
  });
  const playbackSignature = playbackResults.map((result) => result.data?.proxyUrl ?? '').join('|');
  const playback = useMemo(() => {
    const map = new Map<string, MediaPlayback>();
    for (const result of playbackResults) {
      if (result.data) map.set(result.data.id, result.data);
    }
    return map;
    // The array is new on every render, so the URLs are what identify a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackSignature]);

  const [engine, setEngine] = useState<PlaybackEngine | null>(null);
  const stageRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const created = new PlaybackEngine(element);
    setEngine(created);
    return () => {
      created.destroy();
      setEngine(null);
    };
  }, []);

  useEffect(() => {
    if (engine && timeline) engine.setTimeline(timeline);
  }, [engine, timeline]);

  useEffect(() => {
    if (!engine) return;
    for (const [mediaId, info] of playback) {
      if (info.proxyUrl) engine.setMediaUrl(mediaId, info.proxyUrl);
    }
  }, [engine, playback]);

  const splitAtPlayhead = useCallback(() => {
    if (!engine) return;
    const ops = splitOperations(engine.time);
    if (ops.length > 0) {
      commitEdit(ops, ops.length > 1 ? `Split ${ops.length} clips` : 'Split clip');
    }
  }, [engine]);

  const addCaption = useCallback(() => {
    const { timeline: current } = useEditor.getState();
    if (!engine || !current) return;
    const track = firstTrackOfType(current, 'CAPTIONS');
    if (!track) return;
    const clip = createCaptionClip(
      { start: engine.time, duration: secondsToTicks(3), text: 'New caption' },
      current.frameRate,
    );
    if (commitEdit([{ op: 'add_caption', trackId: track.id, clip }], 'Add caption')) {
      selectClips([clip.id]);
      setPanel('inspector');
    }
  }, [engine]);

  const deleteSelection = useCallback((ripple: boolean) => {
    const { timeline: current, selection } = useEditor.getState();
    if (!current || selection.length === 0) return;
    const count = selection.length;
    const noun = count === 1 ? 'clip' : `${count} clips`;
    commitEdit(
      deleteClipsOperations(current, [...selection], ripple),
      `${ripple ? 'Ripple delete' : 'Delete'} ${noun}`,
    );
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTyping(event.target)) return;
      const command = event.metaKey || event.ctrlKey;
      const { timeline: current } = useEditor.getState();

      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void (event.shiftKey ? redo() : undo());
      } else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectClips(current?.tracks.flatMap((t) => t.clips.map((c) => c.id)) ?? []);
      } else if (event.key === ' ') {
        event.preventDefault();
        engine?.toggle();
      } else if (event.key.toLowerCase() === 's' && !command) {
        splitAtPlayhead();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        deleteSelection(event.shiftKey);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        if (event.shiftKey && current) {
          const fps = Math.round(current.frameRate.num / current.frameRate.den);
          engine?.stepFrames(direction * fps);
        } else {
          engine?.stepFrames(direction);
        }
      } else if (event.key === 'Home') {
        engine?.seek(0);
      } else if (event.key === 'End') {
        if (engine) engine.seek(engine.duration);
      } else if (event.key === 'Escape') {
        selectClips([]);
      } else if (event.key === '=' || event.key === '+') {
        setZoom(useEditor.getState().pxPerSecond * 1.5);
      } else if (event.key === '-') {
        setZoom(useEditor.getState().pxPerSecond / 1.5);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, splitAtPlayhead, deleteSelection]);

  const context = useMemo(
    () => ({ engine, media: mediaMap, playback }),
    [engine, mediaMap, playback],
  );

  if (project.isError || timelineQuery.isError) {
    return (
      <NotFoundPage
        title="Timeline not found"
        detail={errorMessage(project.error ?? timelineQuery.error)}
      />
    );
  }

  return (
    <EditorContext.Provider value={context}>
      <div className={styles.editor}>
        <title>{`${timeline?.name ?? 'Editor'} · Agent Edit`}</title>
        <header className={styles.toolbar}>
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link>
            <span aria-hidden="true">/</span>
            <span>{timeline?.name}</span>
          </nav>
          <div className={styles.tools}>
            <Button
              variant="ghost"
              disabled={!timeline?.canUndo && !saving}
              onClick={() => void undo()}
            >
              Undo
            </Button>
            <Button variant="ghost" disabled={!timeline?.canRedo} onClick={() => void redo()}>
              Redo
            </Button>
            <span className={styles.divider} />
            <Button variant="ghost" onClick={splitAtPlayhead}>
              Split
            </Button>
            <Button variant="ghost" onClick={() => deleteSelection(false)}>
              Delete
            </Button>
            <Button variant="ghost" onClick={() => deleteSelection(true)}>
              Ripple delete
            </Button>
            <Button variant="ghost" onClick={addCaption}>
              Add caption
            </Button>
            <span className={styles.divider} />
            <label className={styles.zoom}>
              <span>Zoom</span>
              <input
                type="range"
                min={Math.log(MIN_PX_PER_SECOND)}
                max={Math.log(MAX_PX_PER_SECOND)}
                step={0.01}
                value={Math.log(pxPerSecond)}
                onChange={(event) => setZoom(Math.exp(Number(event.target.value)))}
              />
            </label>
          </div>
          <span className={styles.state} role="status" data-testid="save-state">
            {offline ? 'Offline, edits queued' : saving ? 'Saving…' : 'Saved'}
            {!live && ' · reconnecting'}
          </span>
        </header>

        {editorError && (
          <div className={styles.error}>
            <FormError message={editorError} />
            <Button variant="ghost" onClick={clearEditorError}>
              Dismiss
            </Button>
          </div>
        )}

        <div className={styles.upper}>
          <MediaBin projectId={projectId} assets={assets} />
          <Preview stageRef={stageRef} />
          <aside className={styles.side} aria-label="Details">
            <div className={styles.tabs} role="tablist">
              {(
                [
                  ['inspector', 'Inspector'],
                  ['history', 'History'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={panel === value}
                  className={styles.tab}
                  data-active={panel === value}
                  onClick={() => setPanel(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.panel}>
              {panel === 'inspector' && <Inspector />}
              {panel === 'history' && timeline && (
                <HistoryPanel projectId={projectId} timelineId={timeline.id} />
              )}
            </div>
          </aside>
        </div>
        <TimelineView />
      </div>
    </EditorContext.Provider>
  );
}
