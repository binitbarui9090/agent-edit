import { ASPECT_RATIOS, type AspectRatio } from '@agent-edit/shared';
import styles from './FormatFrame.module.css';

/** The project's true frame shape. Stands in where a thumbnail goes until footage exists. */
export function FormatFrame({ aspect, size = 28 }: { aspect: AspectRatio; size?: number }) {
  const { w, h } = ASPECT_RATIOS[aspect];
  const scale = size / Math.max(w, h);
  return (
    <span className={styles.slot} style={{ width: size, height: size }} aria-hidden="true">
      <span className={styles.frame} style={{ width: w * scale, height: h * scale }} />
    </span>
  );
}
