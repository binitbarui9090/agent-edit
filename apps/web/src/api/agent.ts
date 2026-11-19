import {
  agentRunSchema,
  agentSuggestionSchema,
  mediaAnalysisSchema,
  timelineSchema,
  type AgentRunContext,
} from '@agent-edit/validation';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from './client';

const base = (projectId: string, timelineId: string) =>
  `/projects/${projectId}/timelines/${timelineId}/agent-runs`;

export const agentRunsKey = (timelineId: string) => ['agent-runs', timelineId] as const;

const ACTIVE_POLL_MS = 3000;

export function useAgentRuns(projectId: string, timelineId: string) {
  return useQuery({
    queryKey: agentRunsKey(timelineId),
    queryFn: () =>
      request('GET', base(projectId, timelineId), {
        schema: z.object({ items: z.array(agentRunSchema) }),
      }),
    // Events drive this. Polling while a run is active covers a dropped socket.
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'queued' || run.status === 'planning')
        ? ACTIVE_POLL_MS
        : false,
  });
}

export const createAgentRun = (
  projectId: string,
  timelineId: string,
  instruction: string,
  context: AgentRunContext,
) =>
  request('POST', base(projectId, timelineId), {
    schema: agentRunSchema,
    body: { instruction, context },
  });

/** Keyed by revision, because each suggestion's numbers are measured against the current edit. */
export function useAgentSuggestions(projectId: string, timelineId: string, revision: number) {
  return useQuery({
    queryKey: ['agent-suggestions', timelineId, revision],
    queryFn: () =>
      request('GET', `/projects/${projectId}/timelines/${timelineId}/agent-suggestions`, {
        schema: z.object({ items: z.array(agentSuggestionSchema) }),
      }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
}

export const rejectAgentRun = (projectId: string, timelineId: string, runId: string) =>
  request('POST', `${base(projectId, timelineId)}/${runId}/reject`, { schema: agentRunSchema });

export const applyAgentRun = (
  projectId: string,
  timelineId: string,
  runId: string,
  baseRevision: number,
  enabledSteps: number[],
) =>
  request('POST', `${base(projectId, timelineId)}/${runId}/apply`, {
    schema: z.object({
      run: agentRunSchema,
      timeline: timelineSchema,
      createdTimelineIds: z.array(z.string()),
    }),
    body: { baseRevision, enabledSteps },
  });

export function useMediaAnalysis(projectId: string, mediaId: string | null) {
  return useQuery({
    queryKey: ['analysis', mediaId],
    enabled: mediaId !== null,
    queryFn: () =>
      request('GET', `/projects/${projectId}/media/${mediaId}/analysis`, {
        schema: mediaAnalysisSchema,
      }),
  });
}
