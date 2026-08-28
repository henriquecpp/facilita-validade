import { getSession, refreshSession } from './session';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  canRefresh = true,
): Promise<T> {
  const token = getSession()?.accessToken;
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: options.signal ?? AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Não foi possível confirmar a resposta. Verifique a conexão e tente novamente.',
    );
  }
  if (response.status === 401 && canRefresh) {
    const session = await refreshSession(token);
    if (session) return api<T>(path, options, false);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string | string[];
      requestId?: string;
    };
    const message =
      typeof body.message === 'string'
        ? body.message
        : Array.isArray(body.message)
          ? body.message.join(' ')
          : response.status === 403
            ? 'Seu usuário não tem permissão para esta ação.'
            : response.status === 404
              ? 'O registro não foi encontrado.'
              : 'Não foi possível concluir a operação.';
    throw new ApiError(response.status, body.code ?? 'REQUEST_FAILED', message, body.requestId);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export function queryString(values: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}
