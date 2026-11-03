import { renderJobSchema, type RenderPreset } from '@agent-edit/validation';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from './client';

export const rendersKey = (projectId: string) => ['renders', projectId] as const;
export const RECENT_RENDERS_KEY = ['renders', 'recent'] as const;

const ACTIVE_POLL_MS = 3000;

const isActive = (status: string) => status === 'queued' || status === 'running';

export function useRenders(projectId: string) {
  return useQuery({
    queryKey: rendersKey(projectId),
    queryFn: () =>
      request('GET', `/projects/${projectId}/renders`, {
        schema: z.object({ items: z.array(renderJobSchema) }),
      }),
    // Events carry progress. Polling while a job is active covers a dropped socket.
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => isActive(job.status)) ? ACTIVE_POLL_MS : false,
  });
}

export function useRecentRenders() {
  return useQuery({
    queryKey: RECENT_RENDERS_KEY,
    queryFn: () =>
      request('GET', '/renders', {
        schema: z.object({
          items: z.array(renderJobSchema.extend({ projectName: z.string() })),
        }),
      }),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => isActive(job.status)) ? 5000 : false,
  });
}

export const createRender = (
  projectId: string,
  timelineId: string,
  body: { preset: RenderPreset; burnCaptions: boolean; baseRevision: number },
) =>
  request('POST', `/projects/${projectId}/timelines/${timelineId}/renders`, {
    schema: renderJobSchema,
    body,
  });

export const cancelRender = (projectId: string, renderId: string) =>
  request('POST', `/projects/${projectId}/renders/${renderId}/cancel`, { schema: renderJobSchema });

export const retryRender = (projectId: string, renderId: string) =>
  request('POST', `/projects/${projectId}/renders/${renderId}/retry`, { schema: renderJobSchema });
