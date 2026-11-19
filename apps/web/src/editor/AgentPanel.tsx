import { affectedClipIds } from '@agent-edit/timeline-engine';
import type { AgentRun } from '@agent-edit/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Eye, EyeOff, LoaderCircle, MousePointer2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  agentRunsKey,
  applyAgentRun,
  createAgentRun,
  rejectAgentRun,
  useAgentRuns,
  useAgentSuggestions,
} from '../api/agent';
import { ApiError } from '../api/client';
import { getTimeline } from '../api/timelines';
import { Button, IconButton } from '../components/Button';
import { FormError } from '../components/Field';
import { errorMessage } from '../lib/form-errors';
import { ticksToSeconds } from '@agent-edit/shared';
import { useEditorContext } from './EditorContext';
import { adoptTimeline, clearPreview, flushEdits, showPreview, undo, useEditor } from './store';
import { formatRulerLabel } from './time';
import styles from './AgentPanel.module.css';

const EXAMPLES = [
  'Remove the pauses and repeated takes',
  'What is this video about?',
  'Generate three Shorts',
];

function providerLabel(run: AgentRun): string | null {
  const { provider } = run;
  if (!provider) return null;
  if (provider.isMock) return 'Demo output from a mock provider, not real AI';
  if (provider.id === 'rules') return 'Rule-based plan. No AI model is configured.';
  if (provider.id === 'instant') return 'Understood directly. No model was needed.';
  const name = provider.model ?? provider.id;
  return run.status === 'answered' ? `Answered by ${name}` : `Planned by ${name}`;
}

function duration(seconds: number): string {
  return formatRulerLabel(Math.max(0, Math.round(seconds)));
}

function savedLabel(seconds: number): string | null {
  if (Math.abs(seconds) < 0.05) return null;
  return seconds > 0 ? `−${seconds.toFixed(1)}s` : `+${Math.abs(seconds).toFixed(1)}s`;
}

function RunCard({
  run,
  projectId,
  timelineId,
  latest,
}: {
  run: AgentRun;
  projectId: string;
  timelineId: string;
  latest: boolean;
}) {
  const client = useQueryClient();
  const previewRunId = useEditor((state) => state.previewRunId);
  const previewing = previewRunId === run.id;
  const [enabled, setEnabled] = useState<ReadonlySet<number>>(
    () => new Set(run.steps.filter((step) => !step.error).map((step) => step.index)),
  );
  const [created, setCreated] = useState<string[]>([]);

  useEffect(() => {
    setEnabled(new Set(run.steps.filter((step) => !step.error).map((step) => step.index)));
  }, [run.steps]);

  const refresh = () => client.invalidateQueries({ queryKey: agentRunsKey(timelineId) });

  const apply = useMutation({
    mutationFn: async () => {
      clearPreview();
      const current = await flushEdits();
      if (!current) throw new Error('The timeline is not loaded');
      const steps = [...enabled];
      try {
        return await applyAgentRun(projectId, timelineId, run.id, current.revision, steps);
      } catch (err) {
        // Moved between fetching and applying. The server recompiles against the latest state and
        // refuses if a step broke, so one retry on the newer revision is safe.
        if (!(err instanceof ApiError && err.code === 'revision_conflict')) throw err;
        const latestTimeline = await getTimeline(projectId, timelineId);
        adoptTimeline(latestTimeline);
        return applyAgentRun(projectId, timelineId, run.id, latestTimeline.revision, steps);
      }
    },
    onSuccess: ({ timeline, createdTimelineIds }) => {
      adoptTimeline(timeline);
      setCreated(createdTimelineIds);
      void client.invalidateQueries({ queryKey: ['timelines', projectId] });
      return refresh();
    },
    onSettled: refresh,
  });

  const reject = useMutation({
    mutationFn: () => {
      if (previewing) clearPreview();
      return rejectAgentRun(projectId, timelineId, run.id);
    },
    onSettled: refresh,
  });

  const toggle = (index: number) =>
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const selectionChanged = run.steps.some((step) => !step.error && !enabled.has(step.index));
  const included = run.steps.filter((step) => enabled.has(step.index));
  const totalOps = included.reduce((sum, step) => sum + step.operationCount, 0);
  const saved = included.reduce((sum, step) => sum + step.secondsSaved, 0);
  const label = providerLabel(run);
  const usableShorts = run.shorts.length > 0 && enabled.size > 0;
  const canApply = totalOps > 0 || usableShorts;
  const working = run.status === 'queued' || run.status === 'planning';
  // The creator's own words came straight through, so restating them as reasons adds nothing.
  const understoodDirectly = run.provider?.id === 'instant';
  const showImpact = run.impact && Math.abs(saved) >= 0.05 && run.status === 'proposed';

  return (
    <li className={styles.run} data-status={run.status} data-testid="agent-run">
      <p className={styles.instruction}>{run.instruction}</p>

      <div className={styles.reply}>
        <span className={styles.avatar} aria-hidden="true">
          <Sparkles size={13} strokeWidth={2} />
        </span>
        <div className={styles.replyBody}>
          {working && (
            <p className={styles.stage} role="status">
              <LoaderCircle size={13} className={styles.spin} aria-hidden="true" />
              {run.stage ?? 'Working'}
            </p>
          )}
          {run.error && <FormError message={run.error} />}
          {run.summary && !understoodDirectly && <p className={styles.summary}>{run.summary}</p>}

          {showImpact && run.impact && (
            <div className={styles.impact}>
              <span className={styles.impactTimes}>
                {duration(run.impact.beforeSeconds)}
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> to </span>
                <strong>
                  {selectionChanged && '≈ '}
                  {duration(run.impact.beforeSeconds - saved)}
                </strong>
              </span>
              <span className={styles.impactSaved}>{savedLabel(saved)}</span>
            </div>
          )}

          {run.warnings.map((warning) => (
            <p key={warning} className={styles.warning}>
              {warning}
            </p>
          ))}

          {run.steps.length > 0 && (
            <ul className={styles.steps} aria-label="Proposed steps">
              {run.steps.map((step) => {
                const secondsLabel = step.error ? null : savedLabel(step.secondsSaved);
                return (
                  <li key={step.index} className={styles.step} data-error={step.error !== null}>
                    <label className={styles.stepLabel}>
                      {run.status === 'proposed' && (
                        <input
                          type="checkbox"
                          checked={enabled.has(step.index)}
                          disabled={step.error !== null}
                          onChange={() => toggle(step.index)}
                          aria-label={`Include ${step.summary}`}
                        />
                      )}
                      <span className={styles.stepText}>
                        <span className={styles.stepSummary}>{step.summary}</span>
                        {(step.error || !understoodDirectly) && (
                          <span className={styles.stepReason}>{step.error ?? step.reason}</span>
                        )}
                      </span>
                    </label>
                    {secondsLabel && <span className={styles.stepSaved}>{secondsLabel}</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {run.shorts.length > 0 && (
            <ul className={styles.shorts} aria-label="Proposed Shorts">
              {run.shorts.map((short) => (
                <li key={`${short.sourceMediaId}-${short.sourceIn}`} className={styles.short}>
                  <span className={styles.shortName}>{short.name}</span>
                  <span className={styles.stepReason}>
                    {duration(ticksToSeconds(short.sourceOut - short.sourceIn))} ·{' '}
                    {short.framingSource === 'motion' ? 'Framed on the movement' : 'Centre framed'}{' '}
                    · {short.captions.length} captions
                  </span>
                </li>
              ))}
            </ul>
          )}

          {run.status === 'proposed' && (
            <>
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  disabled={!canApply || apply.isPending}
                  onClick={() => apply.mutate()}
                >
                  {apply.isPending ? 'Applying…' : 'Apply changes'}
                </Button>
                {run.ops.length > 0 &&
                  (previewing ? (
                    <Button onClick={clearPreview}>
                      <EyeOff size={14} aria-hidden="true" />
                      Stop preview
                    </Button>
                  ) : (
                    <Button
                      disabled={selectionChanged}
                      title={
                        selectionChanged
                          ? 'Preview shows the whole plan. Include every step to use it.'
                          : undefined
                      }
                      onClick={() => showPreview(run.id, run.ops, affectedClipIds(run.ops))}
                    >
                      <Eye size={14} aria-hidden="true" />
                      Preview
                    </Button>
                  ))}
                <Button variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate()}>
                  Reject
                </Button>
              </div>
              <FormError message={errorMessage(apply.error ?? reject.error)} />
            </>
          )}

          {run.status === 'applied' && (
            <div className={styles.outcome}>
              <p className={styles.applied} role="status">
                Applied as one edit. Earlier state saved in Versions.
              </p>
              <div className={styles.outcomeActions}>
                {latest && run.ops.length > 0 && (
                  <Button variant="secondary" onClick={() => void undo()}>
                    Undo this edit
                  </Button>
                )}
                {created.map((id, index) => (
                  <Link
                    key={id}
                    className={styles.shortLink}
                    to={`/projects/${projectId}/edit/${id}`}
                  >
                    Open Short {index + 1}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {run.status === 'rejected' && <p className={styles.note}>Rejected. Nothing changed.</p>}
          {run.status === 'stale' && (
            <p className={styles.warning}>The timeline changed after this plan was made.</p>
          )}
          {label && (
            <p
              className={styles.provider}
              data-mock={run.provider?.isMock || run.provider?.id === 'rules'}
            >
              {label}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function AgentPanel({ projectId, timelineId }: { projectId: string; timelineId: string }) {
  const client = useQueryClient();
  const { engine } = useEditorContext();
  const runs = useAgentRuns(projectId, timelineId);
  const revision = useEditor((state) => state.timeline?.revision ?? 0);
  const suggestions = useAgentSuggestions(projectId, timelineId, revision);
  const selection = useEditor((state) => state.selection);
  const [instruction, setInstruction] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  const create = useMutation({
    mutationFn: (text: string) =>
      createAgentRun(projectId, timelineId, text, {
        selectedClipIds: [...useEditor.getState().selection].slice(0, 50),
        playheadSeconds: engine ? ticksToSeconds(engine.time) : 0,
      }),
    onSuccess: () => {
      setInstruction('');
      return client.invalidateQueries({ queryKey: agentRunsKey(timelineId) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (trimmed) create.mutate(trimmed);
  }

  const items = runs.data?.items ?? [];
  const chips = suggestions.data?.items ?? [];

  return (
    <div className={styles.panel}>
      {items.length === 0 && runs.isSuccess ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true">
            <Sparkles size={18} strokeWidth={1.75} />
          </span>
          <p className={styles.emptyTitle}>Describe the edit you want</p>
          <p className={styles.emptyText}>
            I'll propose real timeline changes. Nothing happens until you apply them.
          </p>
          <ul className={styles.examples}>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => {
                    setInstruction(example);
                    input.current?.focus();
                  }}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className={styles.list} aria-label="Agent requests">
          {items.map((run, index) => (
            <RunCard
              key={run.id}
              run={run}
              projectId={projectId}
              timelineId={timelineId}
              latest={index === 0}
            />
          ))}
        </ul>
      )}

      <div className={styles.footer}>
        {chips.length > 0 && (
          <ul className={styles.chips} aria-label="Suggested edits">
            {chips.map((chip) => (
              <li key={chip.id}>
                <button
                  type="button"
                  className={styles.chip}
                  disabled={create.isPending}
                  onClick={() => create.mutate(chip.instruction)}
                >
                  <Sparkles size={11} aria-hidden="true" />
                  {chip.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.compose} onSubmit={submit}>
          <label className="sr-only" htmlFor="agent-instruction">
            Tell the agent what to do
          </label>
          <textarea
            ref={input}
            id="agent-instruction"
            rows={2}
            maxLength={2000}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              // Editor shortcuts must not fire while typing.
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey) submit(event);
              if (event.key === 'Escape') event.currentTarget.blur();
            }}
            placeholder="Ask for an edit, or ask about the footage"
          />
          <div className={styles.composeBar}>
            {selection.length > 0 ? (
              <span className={styles.context}>
                <MousePointer2 size={11} aria-hidden="true" />
                {selection.length} {selection.length === 1 ? 'clip' : 'clips'} selected
              </span>
            ) : (
              <span />
            )}
            <IconButton
              icon={ArrowUp}
              type="submit"
              label="Ask the agent"
              shortcut="Enter"
              tipSide="left"
              className={styles.send}
              disabled={!instruction.trim() || create.isPending}
            />
          </div>
        </form>
        <FormError message={errorMessage(create.error ?? runs.error)} />
      </div>
    </div>
  );
}
