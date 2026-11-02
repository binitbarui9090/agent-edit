import { affectedClipIds } from '@agent-edit/timeline-engine';
import type { AgentRun } from '@agent-edit/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  agentRunsKey,
  applyAgentRun,
  createAgentRun,
  rejectAgentRun,
  useAgentRuns,
} from '../api/agent';
import { ApiError } from '../api/client';
import { getTimeline } from '../api/timelines';
import { Button } from '../components/Button';
import { FormError } from '../components/Field';
import { errorMessage } from '../lib/form-errors';
import { adoptTimeline, clearPreview, flushEdits, showPreview, undo, useEditor } from './store';
import styles from './AgentPanel.module.css';

const EXAMPLES = [
  'Remove unnecessary pauses and repeated takes.',
  'Create subtitles.',
  'Generate three YouTube Shorts from this project.',
];

function providerLabel(run: AgentRun): string | null {
  const { provider } = run;
  if (!provider) return null;
  if (provider.isMock) return 'Demo output from a mock provider, not real AI';
  if (provider.id === 'rules') return 'Rule-based plan. No AI model is configured.';
  return `Planned by ${provider.model ?? provider.id}`;
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
  const totalOps = run.steps
    .filter((step) => enabled.has(step.index))
    .reduce((sum, step) => sum + step.operationCount, 0);
  const label = providerLabel(run);
  const usableShorts = run.shorts.length > 0 && enabled.size > 0;
  const canApply = totalOps > 0 || usableShorts;

  return (
    <li className={styles.run} data-status={run.status} data-testid="agent-run">
      <p className={styles.instruction}>{run.instruction}</p>

      {(run.status === 'queued' || run.status === 'planning') && (
        <p className={styles.stage} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {run.stage ?? 'Working'}
        </p>
      )}
      {run.error && <FormError message={run.error} />}
      {run.summary && <p className={styles.summary}>{run.summary}</p>}
      {label && (
        <p
          className={styles.provider}
          data-mock={run.provider?.isMock || run.provider?.id === 'rules'}
        >
          {label}
        </p>
      )}
      {run.warnings.map((warning) => (
        <p key={warning} className={styles.warning}>
          {warning}
        </p>
      ))}

      {run.steps.length > 0 && (
        <ul className={styles.steps} aria-label="Proposed steps">
          {run.steps.map((step) => (
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
                <span>
                  <span className={styles.stepSummary}>{step.summary}</span>
                  <span className={styles.stepReason}>{step.error ?? step.reason}</span>
                </span>
              </label>
              {step.operationCount > 0 && (
                <span className={styles.ops}>{step.operationCount} ops</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {run.shorts.length > 0 && (
        <ul className={styles.shorts} aria-label="Proposed Shorts">
          {run.shorts.map((short) => (
            <li key={`${short.sourceMediaId}-${short.sourceIn}`}>
              {short.name}
              <span className={styles.stepReason}>
                {short.framingSource === 'vision' ? 'Framed on the subject' : 'Centre framed'} ·{' '}
                {short.captions.length} captions
              </span>
            </li>
          ))}
        </ul>
      )}

      {run.status === 'proposed' && (
        <>
          {selectionChanged && (
            <p className={styles.note}>
              Operation counts are rechecked when you apply, since later steps depend on earlier
              ones.
            </p>
          )}
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
                <Button onClick={clearPreview}>Stop preview</Button>
              ) : (
                <Button
                  disabled={selectionChanged}
                  onClick={() => showPreview(run.id, run.ops, affectedClipIds(run.ops))}
                >
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
          {latest && run.ops.length > 0 && (
            <Button variant="secondary" onClick={() => void undo()}>
              Undo this edit
            </Button>
          )}
          {created.map((id, index) => (
            <Link key={id} className={styles.shortLink} to={`/projects/${projectId}/edit/${id}`}>
              Open Short {index + 1}
            </Link>
          ))}
        </div>
      )}
      {run.status === 'rejected' && <p className={styles.note}>Rejected. Nothing changed.</p>}
      {run.status === 'stale' && (
        <p className={styles.warning}>The timeline changed after this plan was made.</p>
      )}
    </li>
  );
}

export function AgentPanel({ projectId, timelineId }: { projectId: string; timelineId: string }) {
  const client = useQueryClient();
  const runs = useAgentRuns(projectId, timelineId);
  const [instruction, setInstruction] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  const create = useMutation({
    mutationFn: (text: string) => createAgentRun(projectId, timelineId, text),
    onSuccess: () => {
      setInstruction('');
      if (scroller.current) scroller.current.scrollTop = 0;
      return client.invalidateQueries({ queryKey: agentRunsKey(timelineId) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (trimmed) create.mutate(trimmed);
  }

  const items = runs.data?.items ?? [];

  return (
    <div className={styles.panel}>
      <form className={styles.compose} onSubmit={submit}>
        <label className={styles.composeLabel} htmlFor="agent-instruction">
          Tell the agent what to do
        </label>
        <textarea
          id="agent-instruction"
          rows={3}
          maxLength={2000}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            // Editor shortcuts must not fire while typing, and Cmd+Enter sends.
            event.stopPropagation();
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
          }}
          placeholder="Remove repeated takes and normalize the dialogue"
        />
        <div className={styles.composeActions}>
          <Button
            type="submit"
            variant="primary"
            disabled={!instruction.trim() || create.isPending}
          >
            Ask the agent
          </Button>
        </div>
        <FormError message={errorMessage(create.error ?? runs.error)} />
      </form>

      <div ref={scroller} className={styles.runs}>
        {items.length === 0 && runs.isSuccess && (
          <div className={styles.empty}>
            <p>
              The agent proposes edits. You review them here and nothing changes until you apply.
            </p>
            <ul>
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => setInstruction(example)}>
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
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
      </div>
    </div>
  );
}
