import {
  mediaAssetSchema,
  mediaListSchema,
  mediaPlaybackSchema,
  signPartsResponseSchema,
  uploadStateSchema,
  type InitUploadRequest,
  type MediaAsset,
  type MediaList,
  type UpdateMediaRequest,
} from '@agent-edit/validation';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { request } from './client';
import { PROJECTS_KEY, projectKey } from './projects';

export const mediaKey = (projectId: string) => ['media', projectId] as const;
const playbackKey = (projectId: string, mediaId: string) =>
  ['playback', projectId, mediaId] as const;

export function initUpload(projectId: string, body: InitUploadRequest) {
  return request('POST', `/projects/${projectId}/uploads`, { schema: uploadStateSchema, body });
}

export function getUpload(projectId: string, mediaId: string) {
  return request('GET', `/projects/${projectId}/uploads/${mediaId}`, {
    schema: uploadStateSchema,
  });
}

export function signParts(projectId: string, mediaId: string, partNumbers: number[]) {
  return request('POST', `/projects/${projectId}/uploads/${mediaId}/parts`, {
    schema: signPartsResponseSchema,
    body: { partNumbers },
  });
}

export function completeUpload(projectId: string, mediaId: string) {
  return request('POST', `/projects/${projectId}/uploads/${mediaId}/complete`, {
    schema: mediaAssetSchema,
  });
}

export function cancelUpload(projectId: string, mediaId: string) {
  return request('DELETE', `/projects/${projectId}/uploads/${mediaId}`);
}

export function refreshMedia(client: QueryClient, projectId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: mediaKey(projectId) }),
    client.invalidateQueries({ queryKey: projectKey(projectId) }),
    client.invalidateQueries({ queryKey: PROJECTS_KEY }),
  ]);
}

const POLL_WITHOUT_SOCKET_MS = 5000;

export function useMedia(projectId: string, live: boolean) {
  return useInfiniteQuery({
    queryKey: mediaKey(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return request('GET', `/projects/${projectId}/media${query}`, { schema: mediaListSchema });
    },
    getNextPageParam: (page) => page.nextCursor,
    // The socket drives updates. While it is down, progress must still move.
    refetchInterval: (query) => {
      if (live) return false;
      const busy = query.state.data?.pages.some((page) =>
        page.items.some((item) => item.status === 'processing'),
      );
      return busy ? POLL_WITHOUT_SOCKET_MS : false;
    },
  });
}

export function patchJobProgress(
  client: QueryClient,
  projectId: string,
  mediaId: string,
  patch: Pick<MediaAsset['jobs'][number], 'step' | 'status' | 'progress'>,
) {
  client.setQueryData<InfiniteData<MediaList>>(mediaKey(projectId), (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) =>
          item.id !== mediaId
            ? item
            : {
                ...item,
                jobs: item.jobs.map((job) =>
                  job.step === patch.step ? { ...job, ...patch } : job,
                ),
              },
        ),
      })),
    };
  });
}

export function usePlayback(projectId: string, mediaId: string) {
  return useQuery({
    queryKey: playbackKey(projectId, mediaId),
    queryFn: () =>
      request('GET', `/projects/${projectId}/media/${mediaId}`, { schema: mediaPlaybackSchema }),
  });
}

export function useUpdateMedia(projectId: string, mediaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMediaRequest) =>
      request('PATCH', `/projects/${projectId}/media/${mediaId}`, {
        schema: mediaAssetSchema,
        body,
      }),
    onSuccess: () => refreshMedia(client, projectId),
  });
}

export function useDeleteMedia(projectId: string, mediaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('DELETE', `/projects/${projectId}/media/${mediaId}`),
    onSuccess: () => refreshMedia(client, projectId),
  });
}

export function useRetryMedia(projectId: string, mediaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request('POST', `/projects/${projectId}/media/${mediaId}/retry`, {
        schema: mediaAssetSchema,
      }),
    onSuccess: () => refreshMedia(client, projectId),
  });
}

export function useDiscardUpload(projectId: string, mediaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => cancelUpload(projectId, mediaId),
    onSuccess: () => refreshMedia(client, projectId),
  });
}
