import { useEffect, useRef, useState } from 'react';
import styles from './Waveform.module.css';

const HEIGHT = 48;

/** Draws the stored min/max pairs. Drawing only what fits keeps long recordings cheap. */
export function Waveform({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Waveform responded with ${response.status}`);
      const peaks = new Int8Array(await response.arrayBuffer());
      const element = canvas.current;
      const context = element?.getContext('2d');
      if (!element || !context) return;

      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      element.width = width * ratio;
      element.height = HEIGHT * ratio;
      context.scale(ratio, ratio);
      context.fillStyle = getComputedStyle(element).color;

      const pairs = peaks.length / 2;
      const middle = HEIGHT / 2;
      for (let x = 0; x < width; x++) {
        const from = Math.floor((x / width) * pairs);
        const to = Math.max(from + 1, Math.floor(((x + 1) / width) * pairs));
        let min = 0;
        let max = 0;
        for (let i = from; i < to; i++) {
          min = Math.min(min, peaks[i * 2] ?? 0);
          max = Math.max(max, peaks[i * 2 + 1] ?? 0);
        }
        const top = middle - (max / 127) * middle;
        const bottom = middle - (min / 127) * middle;
        context.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) {
        console.warn('Could not draw waveform', err);
        setFailed(true);
      }
    });
    return () => controller.abort();
  }, [url]);

  if (failed) return <p className={styles.failed}>Waveform could not be loaded.</p>;
  return <canvas ref={canvas} className={styles.waveform} aria-label="Audio waveform" role="img" />;
}
