import { userSchema, type LoginRequest, type RegisterRequest } from '@agent-edit/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, request } from './client';
import { ME_KEY } from './query-client';

const userResponse = z.object({ user: userSchema });

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await request('GET', '/auth/me', { schema: userResponse })).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      request('POST', '/auth/login', { schema: userResponse, body }),
    onSuccess: ({ user }) => client.setQueryData(ME_KEY, user),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) =>
      request('POST', '/auth/register', { schema: userResponse, body }),
    onSuccess: ({ user }) => client.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('POST', '/auth/logout'),
    onSuccess: () => {
      // Not clear(): that drops queries without notifying observers, so the UI would stay signed in.
      client.setQueryData(ME_KEY, null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY[0] });
    },
  });
}
