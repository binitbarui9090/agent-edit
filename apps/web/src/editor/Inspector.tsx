import { secondsToTicks, snapToFrame, ticksToSeconds } from '@agent-edit/shared';
import { findClip } from '@agent-edit/timeline-engine';
import type {
  CaptionClip,
  TimelineClip,
  TimelineOperation,
  Transform,
} from '@agent-edit/validation';
import { useEffect, useState, type ReactNode } from 'react';
import { commitEdit, useEditor } from './store';
import styles from './Inspector.module.css';

/** Holds a local draft while typing, and commits one transaction when the change is finished. */
function NumberField({
  label,
  value,
  step,
  min,
  max,
  onCommit,
  suffix,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <span className={styles.inputWrap}>
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </span>
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  );
}

function CaptionFields({ clip }: { clip: CaptionClip }) {
  const [text, setText] = useState(clip.text);
  useEffect(() => setText(clip.text), [clip.text]);
  const { style } = clip;
  const updateStyle = (patch: Partial<CaptionClip['style']>) =>
    commitEdit(
      [{ op: 'update_caption', clipId: clip.id, style: { ...style, ...patch } }],
      'Restyle caption',
    );
  const backgroundColor = style.background?.slice(0, 7) ?? '#000000';
  return (
    <Group title="Caption">
      <label className={styles.field}>
        <span>Text</span>
        <textarea
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const trimmed = text.trim();
            if (trimmed && trimmed !== clip.text) {
              commitEdit(
                [{ op: 'update_caption', clipId: clip.id, text: trimmed }],
                'Edit caption text',
              );
            } else {
              setText(clip.text);
            }
          }}
        />
      </label>
      <label className={styles.field}>
        <span>Font</span>
        <select value={style.font} onChange={(e) => updateStyle({ font: e.target.value })}>
          {['Arial', 'Helvetica', 'Georgia', 'Impact', 'Courier New', 'Verdana'].map((font) => (
            <option key={font}>{font}</option>
          ))}
        </select>
      </label>
      <NumberField
        label="Size"
        value={style.size}
        step={1}
        min={6}
        max={300}
        onCommit={(size) => updateStyle({ size })}
      />
      <label className={styles.field}>
        <span>Position</span>
        <select
          value={style.position}
          onChange={(e) =>
            updateStyle({ position: e.target.value as CaptionClip['style']['position'] })
          }
        >
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </select>
      </label>
      <label className={styles.field}>
        <span>Color</span>
        <input
          type="color"
          value={style.color}
          onChange={(e) => updateStyle({ color: e.target.value })}
        />
      </label>
      <Check
        label="Background"
        checked={style.background !== null}
        onChange={(checked) => updateStyle({ background: checked ? '#000000b3' : null })}
      />
      {style.background !== null && (
        <label className={styles.field}>
          <span>Background color</span>
          <input
            type="color"
            value={backgroundColor}
            onChange={(e) => updateStyle({ background: `${e.target.value}b3` })}
          />
        </label>
      )}
    </Group>
  );
}

function ClipFields({ clip }: { clip: TimelineClip }) {
  const timeline = useEditor((state) => state.timeline);
  if (!timeline) return null;
  const rate = timeline.frameRate;

  const seconds = (ticks: number) => Math.round(ticksToSeconds(ticks) * 100) / 100;
  const edit = (op: TimelineOperation, summary: string) => commitEdit([op], summary);
  const setTransform = (patch: Partial<Transform>) =>
    edit(
      { op: 'update_transform', clipId: clip.id, transform: { ...clip.transform, ...patch } },
      'Change transform',
    );

  return (
    <>
      <Group title="Timing">
        <dl className={styles.facts}>
          <dt>Start</dt>
          <dd>{seconds(clip.start)} s</dd>
          <dt>Duration</dt>
          <dd>{seconds(clip.duration)} s</dd>
          {clip.kind === 'media' && (
            <>
              <dt>Source</dt>
              <dd>
                {seconds(clip.sourceIn)}–{seconds(clip.sourceOut)} s
              </dd>
            </>
          )}
        </dl>
        {clip.kind === 'media' && (
          <NumberField
            label="Speed"
            value={clip.speed}
            step={0.05}
            min={0.25}
            max={4}
            suffix="×"
            onCommit={(speed) => {
              const duration = Math.max(
                snapToFrame(1, rate),
                snapToFrame((clip.sourceOut - clip.sourceIn) / speed, rate),
              );
              edit({ op: 'change_speed', clipId: clip.id, speed, duration }, 'Change speed');
            }}
          />
        )}
        <Check
          label="Enabled"
          checked={clip.enabled}
          onChange={(enabled) =>
            edit(
              { op: 'set_clip_enabled', clipId: clip.id, enabled },
              enabled ? 'Enable clip' : 'Disable clip',
            )
          }
        />
      </Group>

      {clip.kind === 'caption' && <CaptionFields clip={clip} />}

      {clip.kind === 'media' && (
        <Group title="Audio">
          <NumberField
            label="Volume"
            value={clip.volume}
            step={0.05}
            min={0}
            max={4}
            suffix="×"
            onCommit={(volume) =>
              edit({ op: 'change_volume', clipId: clip.id, volume }, 'Change volume')
            }
          />
          <NumberField
            label="Fade in"
            value={seconds(clip.audio.fadeIn)}
            step={0.1}
            min={0}
            max={Math.min(60, seconds(clip.duration))}
            suffix="s"
            onCommit={(value) =>
              edit(
                { op: 'update_audio', clipId: clip.id, fadeIn: secondsToTicks(value) },
                'Change fade in',
              )
            }
          />
          <NumberField
            label="Fade out"
            value={seconds(clip.audio.fadeOut)}
            step={0.1}
            min={0}
            max={Math.min(60, seconds(clip.duration))}
            suffix="s"
            onCommit={(value) =>
              edit(
                { op: 'update_audio', clipId: clip.id, fadeOut: secondsToTicks(value) },
                'Change fade out',
              )
            }
          />
          <Check
            label="Normalize loudness"
            checked={clip.audio.normalize}
            onChange={(normalize) =>
              edit({ op: 'update_audio', clipId: clip.id, normalize }, 'Change normalization')
            }
          />
          <Check
            label="Reduce noise"
            checked={clip.audio.denoise}
            onChange={(denoise) =>
              edit({ op: 'update_audio', clipId: clip.id, denoise }, 'Change noise reduction')
            }
          />
          <p className={styles.note}>
            Normalization and noise reduction apply in the final render.
          </p>
        </Group>
      )}

      {clip.kind === 'media' && (
        <Group title="Transform">
          <NumberField
            label="Scale"
            value={clip.transform.scale}
            step={0.05}
            min={0.01}
            max={20}
            onCommit={(scale) => setTransform({ scale })}
          />
          <NumberField
            label="X"
            value={clip.transform.x}
            step={0.01}
            min={-10}
            max={10}
            onCommit={(x) => setTransform({ x })}
          />
          <NumberField
            label="Y"
            value={clip.transform.y}
            step={0.01}
            min={-10}
            max={10}
            onCommit={(y) => setTransform({ y })}
          />
          <NumberField
            label="Rotation"
            value={clip.transform.rotation}
            step={1}
            min={-360}
            max={360}
            suffix="°"
            onCommit={(rotation) => setTransform({ rotation })}
          />
          <NumberField
            label="Opacity"
            value={clip.transform.opacity}
            step={0.05}
            min={0}
            max={1}
            onCommit={(opacity) => setTransform({ opacity })}
          />
        </Group>
      )}

      {clip.kind === 'media' && (
        <Group title="Transitions">
          {(['in', 'out'] as const).map((side) => {
            const transition = side === 'in' ? clip.transitionIn : clip.transitionOut;
            return (
              <label className={styles.field} key={side}>
                <span>Fade {side}</span>
                <select
                  value={transition?.type ?? 'none'}
                  onChange={(event) => {
                    const value = event.target.value;
                    edit(
                      {
                        op: 'update_transition',
                        clipId: clip.id,
                        side,
                        transition:
                          value === 'none'
                            ? null
                            : {
                                type: 'fade_black',
                                duration: snapToFrame(secondsToTicks(0.5), rate),
                              },
                      },
                      `Change ${side} transition`,
                    );
                  }}
                >
                  <option value="none">None</option>
                  <option value="fade_black">Fade from/to black</option>
                </select>
              </label>
            );
          })}
        </Group>
      )}
    </>
  );
}

export function Inspector() {
  const timeline = useEditor((state) => state.timeline);
  const selection = useEditor((state) => state.selection);
  if (!timeline) return null;
  if (selection.length === 0) {
    return <p className={styles.empty}>Select a clip to see its properties.</p>;
  }
  if (selection.length > 1) {
    return <p className={styles.empty}>{selection.length} clips selected.</p>;
  }
  const located = findClip(timeline, selection[0]!);
  if (!located) return null;
  return <ClipFields key={located.clip.id} clip={located.clip} />;
}
