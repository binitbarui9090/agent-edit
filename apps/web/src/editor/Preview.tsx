import { ticksToSeconds, frameRateLabel } from '@agent-edit/shared';
import { timelineDuration } from '@agent-edit/timeline-engine';
import { Maximize, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { IconButton } from '../components/Button';
import { useEditorContext } from './EditorContext';
import { useEditor } from './store';
import { formatTimecode } from './time';
import styles from './Preview.module.css';

function totalLabel(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function Preview({ stageRef }: { stageRef: (element: HTMLDivElement | null) => void }) {
  const { engine } = useEditorContext();
  const timeline = useEditor((state) => state.timeline);
  const frameRate = timeline?.frameRate;
  const duration = timeline ? timelineDuration(timeline) : 0;
  const timecode = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!engine || !frameRate) return;
    const stopTime = engine.subscribe((time) => {
      // Written directly: these change on every frame, and a React render here would be wasteful.
      if (timecode.current) timecode.current.textContent = formatTimecode(time, frameRate);
      const total = engine.duration;
      if (fill.current) fill.current.style.transform = `scaleX(${total > 0 ? time / total : 0})`;
    });
    const stopPlaying = engine.subscribePlaying(setPlaying);
    return () => {
      stopTime();
      stopPlaying();
    };
  }, [engine, frameRate]);

  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (!engine) return;
    const bar = event.currentTarget;
    const seekTo = (clientX: number) => {
      const rect = bar.getBoundingClientRect();
      const share = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      engine.seek(share * engine.duration);
    };
    seekTo(event.clientX);
    const onMove = (move: PointerEvent) => seekTo(move.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <section className={styles.preview} aria-label="Preview">
      <div ref={viewport} className={styles.viewport}>
        <div
          ref={stageRef}
          className={styles.stage}
          data-testid="stage"
          style={
            timeline
              ? ({ '--ratio': timeline.width / timeline.height } as CSSProperties)
              : undefined
          }
        />
        {timeline && (
          <span className={styles.format}>
            {timeline.width} × {timeline.height} · {frameRateLabel(timeline.frameRate)} fps
          </span>
        )}
      </div>
      <div className={styles.scrub} onPointerDown={scrub} data-disabled={duration === 0}>
        <div className={styles.scrubTrack}>
          <div ref={fill} className={styles.scrubFill} />
        </div>
      </div>
      <div className={styles.transport}>
        <div className={styles.times}>
          <span ref={timecode} className={styles.timecode} data-testid="timecode">
            00:00:00:00
          </span>
          <span className={styles.total}>/ {totalLabel(ticksToSeconds(duration))}</span>
        </div>
        <div className={styles.controls}>
          <IconButton
            icon={SkipBack}
            label="Go to start"
            shortcut="Home"
            disabled={!engine}
            onClick={() => engine?.seek(0)}
          />
          <IconButton
            icon={StepBack}
            label="Previous frame"
            shortcut="←"
            disabled={!engine}
            onClick={() => engine?.stepFrames(-1)}
          />
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? 'Pause' : 'Play'}
            shortcut="Space"
            className={styles.play}
            size={18}
            disabled={!engine}
            onClick={() => engine?.toggle()}
          />
          <IconButton
            icon={StepForward}
            label="Next frame"
            shortcut="→"
            disabled={!engine}
            onClick={() => engine?.stepFrames(1)}
          />
          <IconButton
            icon={SkipForward}
            label="Go to end"
            shortcut="End"
            disabled={!engine}
            onClick={() => engine?.seek(engine.duration)}
          />
        </div>
        <div className={styles.end}>
          <IconButton
            icon={Maximize}
            label="Full screen"
            onClick={() => void viewport.current?.requestFullscreen()}
          />
        </div>
      </div>
    </section>
  );
}
