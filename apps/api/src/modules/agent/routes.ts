import {
  agentRunParamsSchema,
  applyAgentRunRequestSchema,
  createAgentRunRequestSchema,
  timelineParamsSchema,
} from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../plugins/auth.js';
import type { AgentService } from './service.js';

export async function agentRoutes(app: FastifyInstance, { agent }: { agent: AgentService }) {
  app.addHook('preHandler', app.requireUser);
  const base = '/:id/timelines/:timelineId/agent-runs';

  // A plan can cost real money, and models are slow, so this is limited well below the API default.
  app.post(
    base,
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id, timelineId } = timelineParamsSchema.parse(req.params);
      const { instruction, context } = createAgentRunRequestSchema.parse(req.body);
      const run = await agent.create(
        currentUser(req)._id,
        id,
        timelineId,
        instruction,
        context ?? null,
      );
      return reply.status(201).send(run);
    },
  );

  app.get(base, async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    return { items: await agent.list(currentUser(req)._id, id, timelineId) };
  });

  app.get('/:id/timelines/:timelineId/agent-suggestions', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    return { items: await agent.suggestions(currentUser(req)._id, id, timelineId) };
  });

  app.get(`${base}/:runId`, async (req) => {
    const { id, timelineId, runId } = agentRunParamsSchema.parse(req.params);
    return agent.get(currentUser(req)._id, id, timelineId, runId);
  });

  app.post(`${base}/:runId/reject`, async (req) => {
    const { id, timelineId, runId } = agentRunParamsSchema.parse(req.params);
    return agent.reject(currentUser(req)._id, id, timelineId, runId);
  });

  app.post(`${base}/:runId/apply`, async (req) => {
    const { id, timelineId, runId } = agentRunParamsSchema.parse(req.params);
    const { baseRevision, enabledSteps } = applyAgentRunRequestSchema.parse(req.body);
    return agent.apply(currentUser(req)._id, id, timelineId, runId, baseRevision, enabledSteps);
  });
}
