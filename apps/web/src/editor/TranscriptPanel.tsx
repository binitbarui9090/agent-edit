import { ticksToSeconds } from '@agent-edit/shared';
import { cutRangesOperations, sourceToTimeline } from '@agent-edit/timeline-engine';
import { mediaAnalysisSchema } from '@agent-edit/validation';
import { useQueries } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../api/client';
import { IconButton } from '../components/Button';
import { useEditorContext } from './EditorContext';
import { commitEdit, useEditor } from './store';
import { formatRulerLabel } from './time';
import styles from './TranscriptPanel.module.css';

interface Line {
  key: string;
  start: number;
  end: number;
  text: string;
}

export function TranscriptPanel({ projectId }: { projectId: string }) {
  const { engine } = useEditorContext();
  const timeline = useEditor((state) => state.timeline);
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLUListElement>(null);

  const mediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const track of timeline?.tracks ?? []) {
      if (track.type !== 'VIDEO') continue;
      for (const clip of track.clips) if (clip.kind === 'media') ids.add(clip.sourceMediaId);
    }
    return [...ids];
  }, [timeline?.tracks]);

  const analyses = useQueries({
    queries: mediaIds.map((mediaId) => ({
      queryKey: ['analysis', mediaId],
      queryFn: () =>
        request('GET', `/projects/${projectId}/media/${mediaId}/analysis`, {
          schema: mediaAnalysisSchema,
        }),
      staleTime: 60_000,
    })),
  });
  const signature = analyses.map((query) => query.dataUpdatedAt).join('|');

  const lines = useMemo(() => {
    if (!timeline) return [];
    const found: Line[] = [];
    for (const query of analyses) {
      if (!query.data) continue;
      const { mediaId, segments } = query.data;
      for (const [index, segment] of segments.entries()) {
        const places = sourceToTimeline(timeline, {
          mediaId,
          start: segment.start,
          end: segment.end,
        });
        for (const place of places) {
          found.push({
            key: `${mediaId}-${index}-${place.clip.id}`,
            start: place.start,
            end: place.end,
            text: segment.text,
          });
        }
      }
    }
    return found.sort((a, b) => a.start - b.start);
    // The array is new on every render, so the fetch times identify a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, timeline?.tracks]);

  const needle = filter.trim().toLowerCase();
  const visible = needle ? lines.filter((line) => line.text.toLowerCase().includes(needle)) : lines;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!engine) return;
    let shown: string | null = null;
    return engine.subscribe((time) => {
      // Written to the DOM directly: this runs every frame during playback.
      const current =
        visibleRef.current.find((line) => time >= line.start && time < line.end)?.key ?? null;
      if (current === shown || !list.current) return;
      list.current.querySelector('[data-current="true"]')?.removeAttribute('data-current');
      shown = current;
      if (!current) return;
      const row = list.current.querySelector(`[data-line="${CSS.escape(current)}"]`);
      row?.setAttribute('data-current', 'true');
      if (engine.isPlaying) row?.scrollIntoView({ block: 'nearest' });
    });
  }, [engine]);

  function removeLine(line: Line) {
    const { timeline: current } = useEditor.getState();
    if (!current) return;
    const music = new Set(current.tracks.filter((t) => t.type === 'MUSIC').map((t) => t.id));
    const ops = cutRangesOperations(current, [{ start: line.start, end: line.end }], {
      excludeTrackIds: music,
    });
    commitEdit(ops, `Cut "${line.text.slice(0, 40)}"`);
  }

  const loading = analyses.some((query) => query.isPending);

  return (
    <section className={styles.panel} aria-label="Transcript">
      <header className={styles.header}>
        <h2 className={styles.title}>Transcript</h2>
      </header>
      <label className={styles.search}>
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search the transcript"
          placeholder="Search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {lines.length === 0 && !loading && (
        <p className={styles.empty}>
          {mediaIds.length === 0
            ? 'Put footage on the timeline to read it here.'
            : 'No speech has been transcribed in the footage on this timeline.'}
        </p>
      )}
      {lines.length > 0 && visible.length === 0 && (
        <p className={styles.empty}>Nothing matches that search.</p>
      )}
      <ul ref={list} className={styles.lines} aria-label="Transcript lines">
        {visible.map((line) => (
          <li key={line.key} className={styles.line} data-line={line.key}>
            <button
              type="button"
              className={styles.seek}
              aria-label={`Go to ${formatRulerLabel(Math.floor(ticksToSeconds(line.start)))}: ${line.text}`}
              onClick={() => engine?.seek(line.start)}
            >
              <span className={styles.time}>
                {formatRulerLabel(Math.floor(ticksToSeconds(line.start)))}
              </span>
              <span className={styles.text}>{line.text}</span>
            </button>
            <IconButton
              icon={X}
              size={13}
              className={styles.remove}
              label="Cut this line"
              tipSide="left"
              onClick={() => removeLine(line)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
