import {
  historyEntrySchema,
  timelineSchema,
  timelineSummarySchema,
  timelineVersionSchema,
  type TimelineOperation,
} from '@agent-edit/validation';
import { z } from 'zod';
import { request } from './client';

const commitResponse = z.object({
  timeline: timelineSchema,
  transactionId: z.string(),
  replayed: z.boolean(),
});

const base = (projectId: string, timelineId: string) =>
  `/projects/${projectId}/timelines/${timelineId}`;

export const getMainTimeline = (projectId: string) =>
  request('GET', `/projects/${projectId}/timelines/main`, { schema: timelineSchema });

export const getTimeline = (projectId: string, timelineId: string) =>
  request('GET', base(projectId, timelineId), { schema: timelineSchema });

export const listTimelines = (projectId: string) =>
  request('GET', `/projects/${projectId}/timelines`, {
    schema: z.object({ items: z.array(timelineSummarySchema) }),
  });

export const commitTransaction = (
  projectId: string,
  timelineId: string,
  body: {
    baseRevision: number;
    idempotencyKey: string;
    ops: TimelineOperation[];
    summary?: string;
  },
) =>
  request('POST', `${base(projectId, timelineId)}/transactions`, { schema: commitResponse, body });

export const undoTimeline = (projectId: string, timelineId: string, baseRevision: number) =>
  request('POST', `${base(projectId, timelineId)}/undo`, {
    schema: commitResponse,
    body: { baseRevision },
  });

export const redoTimeline = (projectId: string, timelineId: string, baseRevision: number) =>
  request('POST', `${base(projectId, timelineId)}/redo`, {
    schema: commitResponse,
    body: { baseRevision },
  });

export const getHistory = (projectId: string, timelineId: string) =>
  request('GET', `${base(projectId, timelineId)}/history`, {
    schema: z.object({ items: z.array(historyEntrySchema) }),
  });

export const getVersions = (projectId: string, timelineId: string) =>
  request('GET', `${base(projectId, timelineId)}/versions`, {
    schema: z.object({ items: z.array(timelineVersionSchema) }),
  });

export const createVersion = (projectId: string, timelineId: string, name: string) =>
  request('POST', `${base(projectId, timelineId)}/versions`, {
    schema: timelineVersionSchema,
    body: { name },
  });

export const restoreVersion = (
  projectId: string,
  timelineId: string,
  versionId: string,
  baseRevision: number,
) =>
  request('POST', `${base(projectId, timelineId)}/versions/${versionId}/restore`, {
    schema: commitResponse,
    body: { baseRevision },
  });
