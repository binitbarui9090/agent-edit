import {
  projectListSchema,
  projectSchema,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from '@agent-edit/validation';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { request } from './client';

const PROJECTS_KEY = ['projects'] as const;
const projectKey = (id: string) => ['project', id] as const;

/**
 * Refetches the list even while no dashboard is mounted, and resolves first. Mutations navigate back
 * to the dashboard on success, which would otherwise briefly show the stale list.
 */
function refreshProjects(client: QueryClient) {
  return client.invalidateQueries({ queryKey: PROJECTS_KEY, refetchType: 'all' });
}

export function useProjects() {
  return useInfiniteQuery({
    queryKey: PROJECTS_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return request('GET', `/projects${query}`, { schema: projectListSchema });
    },
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKey(id),
    queryFn: () => request('GET', `/projects/${id}`, { schema: projectSchema }),
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      request('POST', '/projects', { schema: projectSchema, body }),
    onSuccess: (project) => {
      client.setQueryData(projectKey(project.id), project);
      return refreshProjects(client);
    },
  });
}

export function useUpdateProject(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      request('PATCH', `/projects/${id}`, { schema: projectSchema, body }),
    onSuccess: (project) => {
      client.setQueryData(projectKey(id), project);
      return refreshProjects(client);
    },
  });
}

export function useDeleteProject(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('DELETE', `/projects/${id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: projectKey(id) });
      return refreshProjects(client);
    },
  });
}
