import {
  ASPECT_RATIOS,
  ASPECT_RATIO_KEYS,
  FRAME_RATES,
  RESOLUTION_PRESETS,
  type AspectRatio,
} from '@agent-edit/shared';
import type { ProjectSettings } from '@agent-edit/validation';
import { FormatFrame } from './FormatFrame';
import styles from './SettingsFields.module.css';

export const DEFAULT_SETTINGS: ProjectSettings = {
  aspectRatio: '16:9',
  width: 1920,
  height: 1080,
  frameRate: { num: 30, den: 1 },
};

export function SettingsFields({
  value,
  onChange,
}: {
  value: ProjectSettings;
  onChange: (next: ProjectSettings) => void;
}) {
  const presets = RESOLUTION_PRESETS[value.aspectRatio];
  const presetIndex = presets.findIndex(
    (p) => p.width === value.width && p.height === value.height,
  );
  const rateIndex = FRAME_RATES.findIndex(
    (r) => r.num === value.frameRate.num && r.den === value.frameRate.den,
  );

  function changeAspect(aspect: AspectRatio) {
    // Keep the same quality tier when the frame shape changes.
    const tier =
      RESOLUTION_PRESETS[aspect][Math.max(presetIndex, 0)] ?? RESOLUTION_PRESETS[aspect][0]!;
    onChange({ ...value, aspectRatio: aspect, width: tier.width, height: tier.height });
  }

  return (
    <div className={styles.fields}>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Aspect ratio</legend>
        <div className={styles.options}>
          {ASPECT_RATIO_KEYS.map((aspect) => (
            <label key={aspect} className={styles.aspect}>
              <input
                type="radio"
                name="aspect"
                className={styles.radio}
                checked={value.aspectRatio === aspect}
                onChange={() => changeAspect(aspect)}
              />
              <span className={styles.aspectBody}>
                <FormatFrame aspect={aspect} size={30} />
                <span className={styles.data}>{aspect}</span>
                <span className={styles.caption}>{ASPECT_RATIOS[aspect].label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Resolution</legend>
        <div className={styles.segments}>
          {presets.map((preset, index) => (
            <label key={preset.label} className={styles.segment}>
              <input
                type="radio"
                name="resolution"
                className={styles.radio}
                checked={presetIndex === index}
                onChange={() => onChange({ ...value, width: preset.width, height: preset.height })}
              />
              <span className={styles.segmentBody}>{preset.label}</span>
            </label>
          ))}
        </div>
        <p className={styles.readout}>
          {value.width} × {value.height}
        </p>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Frame rate</legend>
        <div className={styles.segments}>
          {FRAME_RATES.map((rate, index) => (
            <label key={rate.label} className={styles.segment}>
              <input
                type="radio"
                name="frame-rate"
                className={styles.radio}
                checked={rateIndex === index}
                onChange={() => onChange({ ...value, frameRate: { num: rate.num, den: rate.den } })}
              />
              <span className={styles.segmentBody}>{rate.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
