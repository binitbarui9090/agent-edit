import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

export const ME_KEY = ['me'] as const;

function handleExpiredSession(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && error.code === 'unauthenticated') {
    queryClient.setQueryData(ME_KEY, null);
  }
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleExpiredSession }),
  mutationCache: new MutationCache({ onError: handleExpiredSession }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});
