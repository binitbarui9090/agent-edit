import type { ApiErrorBody, ErrorCode } from '@agent-edit/shared';
import type { z } from 'zod';

export interface FieldProblem {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    message: string,
    readonly requestId?: string,
    readonly fields: FieldProblem[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions<S extends z.ZodType> {
  schema?: S;
  body?: unknown;
}

const OFFLINE = "Can't reach the server. Check that the API is running.";

export async function request<S extends z.ZodType>(
  method: string,
  path: string,
  { schema, body }: RequestOptions<S> = {},
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network', OFFLINE);
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (!payload?.error) throw new ApiError(res.status, 'network', OFFLINE);
    const { code, message, requestId, details } = payload.error;
    throw new ApiError(
      res.status,
      code,
      message,
      requestId,
      Array.isArray(details) ? (details as FieldProblem[]) : [],
    );
  }

  if (res.status === 204 || !schema) return undefined as z.infer<S>;
  // Parsing at the boundary turns API drift into a visible error instead of bad state.
  return schema.parse(await res.json());
}
