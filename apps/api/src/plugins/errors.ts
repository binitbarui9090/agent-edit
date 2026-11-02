import type { ApiErrorBody, ErrorCode } from '@agent-edit/shared';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';

function body(
  req: FastifyRequest,
  code: ErrorCode,
  message: string,
  details?: unknown,
): ApiErrorBody {
  return {
    error: { code, message, requestId: req.id, ...(details === undefined ? {} : { details }) },
  };
}

export const errorsPlugin = fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(body(req, 'not_found', 'Route not found'));
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(req, err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(400).send(body(req, 'validation_failed', 'Invalid request', details));
    }
    if (err.statusCode === 429) {
      return reply.status(429).send(body(req, 'rate_limited', 'Too many requests. Slow down.'));
    }
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      // Framework-level client errors: malformed JSON, oversized body, unsupported media type.
      return reply.status(err.statusCode).send(body(req, 'validation_failed', err.message));
    }
    // Never leak internals. The request id ties the response to this log line.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body(req, 'internal', 'Something went wrong'));
  });
});
