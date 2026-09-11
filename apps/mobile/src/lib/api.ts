import { API_BASE_URL } from "../config";

/**
 * Cliente HTTP centralizado (README §17).
 * Responsável por base URL, JSON, Authorization Bearer, tratamento de erros
 * padronizado e renovação automática (single-flight) em 401.
 */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface PublicUser extends AuthUser {
  createdAt: string;
}

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface AuthBridge {
  getAccessToken(): string | null;
  /** Renova o access token (single-flight). Retorna o novo token ou null. */
  refreshAccessToken(): Promise<string | null>;
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const code = (data && data.code) || "INTERNAL_ERROR";
    const message = (data && data.message) || "Erro na requisição.";
    throw new ApiError(code, message, response.status);
  }

  return data as T;
}

async function doFetch<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError("NETWORK", "Não foi possível conectar ao servidor.", 0);
  }
  return parse<T>(response);
}

export function createApiClient(bridge?: AuthBridge) {
  async function authedGet<T>(path: string, retry = true): Promise<T> {
    const token = bridge?.getAccessToken() ?? null;
    try {
      return await doFetch<T>(path, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && retry && bridge) {
        const refreshed = await bridge.refreshAccessToken();
        if (refreshed) {
          return authedGet<T>(path, false);
        }
      }
      throw error;
    }
  }

  return {
    register(input: { name: string; email: string; password: string }): Promise<AuthResponse> {
      return doFetch<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    login(input: { email: string; password: string }): Promise<AuthResponse> {
      return doFetch<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    refresh(refreshToken: string): Promise<TokenPair> {
      return doFetch<TokenPair>("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    },
    async logout(refreshToken: string): Promise<void> {
      await doFetch<void>("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    },
    me(): Promise<PublicUser> {
      return authedGet<PublicUser>("/me");
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
