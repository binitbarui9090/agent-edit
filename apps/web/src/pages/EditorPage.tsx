import { newId, secondsToTicks } from '@agent-edit/shared';
import {
  ArrowLeft,
  BarChart3,
  Clapperboard,
  History,
  Keyboard,
  Redo2,
  Settings,
  SlidersHorizontal,
  Sparkles,
  TextQuote,
  Undo2,
  Upload,
  type LucideIcon,
} from 'lucide-react';
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
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { agentRunsKey } from '../api/agent';
import { request } from '../api/client';
import { useProjectEvents } from '../api/events';
import { useMedia } from '../api/media';
import { useProject } from '../api/projects';
import { rendersKey } from '../api/renders';
import { deleteTimeline, getMainTimeline, getTimeline, listTimelines } from '../api/timelines';
import { Button, IconButton } from '../components/Button';
import { FormError } from '../components/Field';
import { AgentPanel } from '../editor/AgentPanel';
import { EditorContext } from '../editor/EditorContext';
import { ExportPanel } from '../editor/ExportPanel';
import { HistoryPanel } from '../editor/HistoryPanel';
import { Inspector } from '../editor/Inspector';
import { appendToTimeline, isEditable, MediaBin } from '../editor/MediaBin';
import { PlaybackEngine } from '../editor/playback';
import { Preview } from '../editor/Preview';
import { ShortcutsDialog } from '../editor/ShortcutsDialog';
import { TranscriptPanel } from '../editor/TranscriptPanel';
import {
  clearEditorError,
  clearPreview,
  commitEdit,
  loadTimeline,
  redo,
  selectClips,
  setMediaLookup,
  setZoom,
  syncFromServer,
  toggleSnapping,
  undo,
  useEditor,
} from '../editor/store';
import { TimelineView } from '../editor/TimelineView';
import { errorMessage } from '../lib/form-errors';
import { consumeAutoPlace } from '../uploads/start';
import { NotFoundPage } from './NotFoundPage';
import styles from './EditorPage.module.css';

const PLAYBACK_REFRESH_MS = 30 * 60 * 1000;
const DEFAULT_TIMELINE_HEIGHT = 366;
const MIN_TIMELINE_HEIGHT = 180;
const MIN_PREVIEW_HEIGHT = 220;
const TIMELINE_HEIGHT_KEY = 'agent-edit:timeline-height';

type LeftPanel = 'media' | 'transcript' | 'inspector' | 'history';

const LEFT_TABS: ReadonlyArray<{ id: LeftPanel; label: string; icon: LucideIcon }> = [
  { id: 'media', label: 'Media', icon: Clapperboard },
  { id: 'transcript', label: 'Transcript', icon: TextQuote },
  { id: 'inspector', label: 'Inspector', icon: SlidersHorizontal },
  { id: 'history', label: 'History', icon: History },
];

function savedTimelineHeight(): number {
  try {
    const saved = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
    return saved >= MIN_TIMELINE_HEIGHT ? saved : DEFAULT_TIMELINE_HEIGHT;
  } catch {
    return DEFAULT_TIMELINE_HEIGHT;
  }
}

function artifactsReady(asset: MediaAsset | undefined): number {
  return (asset?.jobs ?? []).filter(
    (job) => job.status === 'done' && ['proxy', 'thumbnails', 'waveform'].includes(job.step),
  ).length;
}

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

  const client = useQueryClient();
  const live = useProjectEvents(projectId, {
    onTimelineChanged: (revision) => void syncFromServer(revision),
    onAgentChanged: (changedTimelineId) => {
      void client.invalidateQueries({ queryKey: agentRunsKey(changedTimelineId) });
    },
    onRenderChanged: () => {
      void client.invalidateQueries({ queryKey: rendersKey(projectId) });
    },
  });
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
  const previewing = useEditor((state) => state.previewRunId !== null);
  const selectionCount = useEditor((state) => state.selection.length);
  const inspectRequest = useEditor((state) => state.inspectRequest);
  const [leftPanel, setLeftPanel] = useState<LeftPanel | null>('media');
  const [rightPanel, setRightPanel] = useState<'agent' | 'export'>('agent');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(savedTimelineHeight);
  const workspace = useRef<HTMLDivElement>(null);
  // Set when picking a clip opened the inspector, so clearing the selection can put Media back.
  const openedForSelection = useRef(false);
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const removeShort = useMutation({
    mutationFn: () => deleteTimeline(projectId, timelineId ?? ''),
    onSuccess: async () => {
      setConfirmingDelete(false);
      await client.invalidateQueries({ queryKey: ['timelines', projectId] });
      void navigate(`/projects/${projectId}/edit`, { replace: true });
    },
    onError: (err) => useEditor.setState({ error: errorMessage(err) }),
  });
  const timelines = useQuery({
    queryKey: ['timelines', projectId],
    queryFn: () => listTimelines(projectId),
  });

  useEffect(() => {
    if (inspectRequest === 0) return;
    setLeftPanel((current) => {
      if (current !== 'media' && current !== null) return current;
      openedForSelection.current = true;
      return 'inspector';
    });
  }, [inspectRequest]);

  useEffect(() => {
    if (selectionCount > 0 || !openedForSelection.current) return;
    openedForSelection.current = false;
    setLeftPanel((current) => (current === 'inspector' ? 'media' : current));
  }, [selectionCount]);

  function chooseLeft(next: LeftPanel) {
    openedForSelection.current = false;
    // Choosing the open panel closes it, which gives the picture the room.
    setLeftPanel((current) => (current === next ? null : next));
  }

  const editable = useMemo(() => assets.filter(isEditable), [assets]);
  const emptyTimeline = timeline?.tracks.every((track) => track.clips.length === 0) ?? false;

  // A file dropped on the dashboard means "edit this", so it goes on the timeline as soon as it can.
  useEffect(() => {
    const first = editable.at(-1);
    if (timeline?.kind === 'main' && emptyTimeline && first && consumeAutoPlace(projectId)) {
      appendToTimeline(first);
    }
  }, [editable, emptyTimeline, projectId, timeline?.kind]);

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
      // Footage can be used while analysis runs, so its thumbnails and waveform can arrive later.
      queryKey: ['playback', projectId, mediaId, artifactsReady(mediaMap.get(mediaId))],
      queryFn: () =>
        request('GET', `/projects/${projectId}/media/${mediaId}`, { schema: mediaPlaybackSchema }),
      // Signed URLs last at least two hours, so refreshing well before that keeps playback going.
      refetchInterval: PLAYBACK_REFRESH_MS,
      staleTime: PLAYBACK_REFRESH_MS,
    })),
  });
  const playbackSignature = playbackResults
    .map((result) => `${result.data?.proxyUrl ?? ''}:${result.data?.thumbnailUrls.length ?? 0}`)
    .join('|');
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
      setLeftPanel((panel) => {
        openedForSelection.current = panel === 'media' || panel === null;
        return 'inspector';
      });
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

  /** Jumps to the next cut on any track. */
  const jumpToEdit = useCallback(
    (direction: 1 | -1) => {
      const { timeline: current } = useEditor.getState();
      if (!engine || !current) return;
      const edges = new Set([0, engine.duration]);
      for (const track of current.tracks) {
        for (const clip of track.clips) {
          edges.add(clip.start);
          edges.add(clip.start + clip.duration);
        }
      }
      const sorted = [...edges].sort((a, b) => a - b);
      const here = engine.time;
      const target =
        direction === 1
          ? sorted.find((edge) => edge > here + 1)
          : sorted.findLast((edge) => edge < here - 1);
      if (target !== undefined) engine.seek(target);
    },
    [engine],
  );

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
      } else if (event.key.toLowerCase() === 'c' && !command) {
        addCaption();
      } else if (event.key.toLowerCase() === 'n' && !command) {
        toggleSnapping();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        jumpToEdit(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === '/' && !command) {
        event.preventDefault();
        setRightPanel('agent');
        requestAnimationFrame(() => document.getElementById('agent-instruction')?.focus());
      } else if (event.key === '?') {
        setShortcutsOpen(true);
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
  }, [engine, splitAtPlayhead, deleteSelection, addCaption, jumpToEdit]);

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

  function resizeTimeline(event: ReactPointerEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = timelineHeight;
    const available = workspace.current?.clientHeight ?? window.innerHeight;
    let latest = startHeight;
    const onMove = (move: PointerEvent) => {
      latest = Math.max(
        MIN_TIMELINE_HEIGHT,
        Math.min(available - MIN_PREVIEW_HEIGHT, startHeight + startY - move.clientY),
      );
      setTimelineHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        localStorage.setItem(TIMELINE_HEIGHT_KEY, String(latest));
      } catch {
        // Only a convenience: the next visit starts at the default height.
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const firstEditable = editable.at(-1);
  const emptyHint = firstEditable ? (
    <>
      <Button variant="primary" onClick={() => appendToTimeline(firstEditable)}>
        Start with {firstEditable.name}
      </Button>
      <span>or drag footage here from Media</span>
    </>
  ) : assets.length > 0 ? (
    <span>Your footage is still processing. It can go on the timeline as soon as it plays.</span>
  ) : (
    <span>Import footage from the Media panel to begin.</span>
  );

  return (
    <EditorContext.Provider value={context}>
      <div className={styles.editor}>
        <title>{`${timeline?.name ?? 'Editor'} · Agent Edit`}</title>
        <header className={styles.top}>
          <div className={styles.topLeft}>
            <Link
              to={`/projects/${projectId}`}
              className={styles.back}
              aria-label={`Back to ${project.data?.name ?? 'project'}`}
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            </Link>
            <nav className={styles.crumbs} aria-label="Breadcrumb">
              <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link>
              <span aria-hidden="true">/</span>
              {(timelines.data?.items.length ?? 0) > 1 ? (
                <select
                  className={styles.switcher}
                  aria-label="Timeline"
                  value={timeline?.id ?? ''}
                  onChange={(event) =>
                    void navigate(`/projects/${projectId}/edit/${event.target.value}`)
                  }
                >
                  {timelines.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={styles.timelineName}>{timeline?.name}</span>
              )}
            </nav>
          </div>
          <div className={styles.topCentre}>
            <IconButton
              icon={Undo2}
              label="Undo"
              shortcut="⌘Z"
              tipSide="bottom"
              disabled={!timeline?.canUndo && !saving}
              onClick={() => void undo()}
            />
            <IconButton
              icon={Redo2}
              label="Redo"
              shortcut="⇧⌘Z"
              tipSide="bottom"
              disabled={!timeline?.canRedo}
              onClick={() => void redo()}
            />
          </div>
          <div className={styles.topRight}>
            <span
              className={styles.state}
              role="status"
              data-testid="save-state"
              data-saving={saving}
              data-offline={offline}
            >
              <span className={styles.stateDot} aria-hidden="true" />
              {offline ? 'Offline, edits queued' : saving ? 'Saving…' : 'Saved'}
              {!live && ' · reconnecting'}
            </span>
            {timeline?.kind === 'short' &&
              (confirmingDelete ? (
                <>
                  <Button variant="danger" onClick={() => removeShort.mutate()}>
                    Confirm delete
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
                  Delete this Short
                </Button>
              ))}
            <Button variant="primary" onClick={() => setRightPanel('export')}>
              <Upload size={14} aria-hidden="true" />
              Export
            </Button>
          </div>
        </header>

        <div className={styles.body}>
          <nav className={styles.rail} aria-label="Editor tools">
            <div role="tablist" aria-orientation="vertical" className={styles.railGroup}>
              {LEFT_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={leftPanel === id}
                  className={styles.railItem}
                  onClick={() => chooseLeft(id)}
                >
                  <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className={styles.railGroup}>
              <Link to={`/projects/${projectId}/analysis`} className={styles.railItem}>
                <BarChart3 size={18} strokeWidth={1.6} aria-hidden="true" />
                <span>Analysis</span>
              </Link>
              <Link to={`/projects/${projectId}/settings`} className={styles.railItem}>
                <Settings size={18} strokeWidth={1.6} aria-hidden="true" />
                <span>Settings</span>
              </Link>
              <button
                type="button"
                className={styles.railItem}
                onClick={() => setShortcutsOpen(true)}
              >
                <Keyboard size={18} strokeWidth={1.6} aria-hidden="true" />
                <span>Keys</span>
              </button>
            </div>
          </nav>

          <div
            ref={workspace}
            className={styles.workspace}
            style={{ '--timeline-height': `${timelineHeight}px` } as CSSProperties}
          >
            <div className={styles.upper} data-left-open={leftPanel !== null}>
              {leftPanel && (
                <aside className={styles.left} aria-label="Project panel">
                  {leftPanel === 'media' && <MediaBin projectId={projectId} assets={assets} />}
                  {leftPanel === 'transcript' && <TranscriptPanel projectId={projectId} />}
                  {leftPanel === 'inspector' && (
                    <div className={styles.scrollPanel}>
                      <header className={styles.panelHeader}>
                        <h2>Inspector</h2>
                      </header>
                      <div className={styles.panelBody}>
                        <Inspector />
                      </div>
                    </div>
                  )}
                  {leftPanel === 'history' && timeline && (
                    <div className={styles.scrollPanel}>
                      <header className={styles.panelHeader}>
                        <h2>History</h2>
                      </header>
                      <div className={styles.panelBody}>
                        <HistoryPanel projectId={projectId} timelineId={timeline.id} />
                      </div>
                    </div>
                  )}
                </aside>
              )}
              <div className={styles.stageColumn}>
                {previewing && (
                  <div className={styles.banner} role="status">
                    <Sparkles size={13} aria-hidden="true" />
                    <span>Previewing the agent's proposal. Nothing has been applied.</span>
                    <Button variant="ghost" onClick={clearPreview}>
                      Stop preview
                    </Button>
                  </div>
                )}
                {editorError && (
                  <div className={styles.error}>
                    <FormError message={editorError} />
                    <Button variant="ghost" onClick={clearEditorError}>
                      Dismiss
                    </Button>
                  </div>
                )}
                <Preview stageRef={stageRef} />
              </div>
            </div>
            <div
              className={styles.resizer}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize timeline"
              onPointerDown={resizeTimeline}
            />
            <TimelineView
              onSplit={splitAtPlayhead}
              onDelete={deleteSelection}
              onAddCaption={addCaption}
              emptyHint={emptyHint}
            />
          </div>

          <aside className={styles.right} aria-label="Agent and export">
            <div className={styles.tabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightPanel === 'agent'}
                className={styles.tab}
                onClick={() => setRightPanel('agent')}
              >
                <Sparkles size={13} aria-hidden="true" />
                Agent
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightPanel === 'export'}
                className={styles.tab}
                onClick={() => setRightPanel('export')}
              >
                <Upload size={13} aria-hidden="true" />
                Export
              </button>
            </div>
            <div className={styles.rightBody}>
              {rightPanel === 'agent' && timeline && (
                <AgentPanel projectId={projectId} timelineId={timeline.id} />
              )}
              {rightPanel === 'export' && timeline && (
                <div className={styles.panelBody}>
                  <ExportPanel projectId={projectId} timelineId={timeline.id} />
                </div>
              )}
            </div>
          </aside>
        </div>
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      </div>
    </EditorContext.Provider>
  );
}
