import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (count, error) => count < 3 && (!(error instanceof ApiError) || error.retryable),
        retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
