import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { useEditorContext } from './EditorContext';
import { useEditor } from './store';
import { formatTimecode } from './time';
import styles from './Preview.module.css';

export function Preview({ stageRef }: { stageRef: (element: HTMLDivElement | null) => void }) {
  const { engine } = useEditorContext();
  const timeline = useEditor((state) => state.timeline);
  const frameRate = timeline?.frameRate;
  const timecode = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!engine || !frameRate) return;
    const stopTime = engine.subscribe((time) => {
      // Written directly: this changes on every frame, and a React render here would be wasteful.
      if (timecode.current) timecode.current.textContent = formatTimecode(time, frameRate);
    });
    const stopPlaying = engine.subscribePlaying(setPlaying);
    return () => {
      stopTime();
      stopPlaying();
    };
  }, [engine, frameRate]);

  return (
    <section className={styles.preview} aria-label="Preview">
      <div className={styles.viewport}>
        <div
          ref={stageRef}
          className={styles.stage}
          data-testid="stage"
          style={timeline ? { aspectRatio: `${timeline.width} / ${timeline.height}` } : undefined}
        />
      </div>
      <div className={styles.transport}>
        <span ref={timecode} className={styles.timecode} data-testid="timecode">
          00:00:00:00
        </span>
        <Button
          variant="ghost"
          aria-label="Go to start"
          disabled={!engine}
          onClick={() => engine?.seek(0)}
        >
          ⏮
        </Button>
        <Button
          variant="ghost"
          aria-label="Previous frame"
          disabled={!engine}
          onClick={() => engine?.stepFrames(-1)}
        >
          ◀
        </Button>
        <Button
          variant="secondary"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!engine}
          onClick={() => engine?.toggle()}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          variant="ghost"
          aria-label="Next frame"
          disabled={!engine}
          onClick={() => engine?.stepFrames(1)}
        >
          ▶
        </Button>
        <Button
          variant="ghost"
          aria-label="Go to end"
          disabled={!engine}
          onClick={() => engine?.seek(engine.duration)}
        >
          ⏭
        </Button>
      </div>
    </section>
  );
}
