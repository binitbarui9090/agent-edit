import {
  createProjectRequestSchema,
  listProjectsQuerySchema,
  projectIdParamsSchema,
  updateProjectRequestSchema,
} from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../plugins/auth.js';
import type { ProjectService } from './service.js';

export async function projectRoutes(
  app: FastifyInstance,
  { projects }: { projects: ProjectService },
) {
  app.addHook('preHandler', app.requireUser);

  app.post('/', async (req, reply) => {
    const input = createProjectRequestSchema.parse(req.body);
    const project = await projects.create(currentUser(req)._id, input);
    return reply.status(201).send(project);
  });

  app.get('/', async (req) => {
    const { limit, cursor } = listProjectsQuerySchema.parse(req.query);
    return projects.list(currentUser(req)._id, limit, cursor);
  });

  app.get('/:id', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    return projects.get(currentUser(req)._id, id);
  });

  app.patch('/:id', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    const input = updateProjectRequestSchema.parse(req.body);
    return projects.update(currentUser(req)._id, id, input);
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    await projects.remove(currentUser(req)._id, id);
    return reply.status(204).send();
  });
}
