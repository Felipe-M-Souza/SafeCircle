/**
 * Erros de aplicação com códigos estáveis e legíveis por máquina (README §16).
 *
 * A API responde com o `code`; o app mobile traduz para mensagens em pt-BR.
 * Nunca retornar stack trace ou mensagens cruas do PostgreSQL ao cliente.
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED"
  | "EMAIL_ALREADY_IN_USE"
  | "INVALID_REFRESH_TOKEN"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const errors = {
  validation: (details?: unknown) =>
    new AppError("VALIDATION_ERROR", 400, "Dados inválidos.", details),
  invalidCredentials: () => new AppError("INVALID_CREDENTIALS", 401, "E-mail ou senha inválidos."),
  unauthorized: () => new AppError("UNAUTHORIZED", 401, "Não autenticado."),
  emailAlreadyInUse: () => new AppError("EMAIL_ALREADY_IN_USE", 409, "E-mail já está em uso."),
  invalidRefreshToken: () => new AppError("INVALID_REFRESH_TOKEN", 401, "Refresh token inválido."),
  sessionExpired: () => new AppError("SESSION_EXPIRED", 401, "Sessão expirada."),
  sessionRevoked: () => new AppError("SESSION_REVOKED", 401, "Sessão revogada."),
};
