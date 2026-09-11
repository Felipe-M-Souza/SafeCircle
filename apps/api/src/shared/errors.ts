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
  | "INTERNAL_ERROR"
  // Phase 2 — Grupos de Confiança
  | "GROUP_NOT_FOUND"
  | "GROUP_NAME_INVALID"
  | "INSUFFICIENT_GROUP_ROLE"
  | "ALREADY_GROUP_MEMBER"
  | "CANNOT_INVITE_SELF"
  | "INVITATION_ALREADY_PENDING"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_PROCESSED"
  | "INVITATION_NOT_FOR_USER"
  | "OWNER_CANNOT_LEAVE_GROUP"
  | "CANNOT_REMOVE_OWNER"
  | "INVALID_GROUP_ROLE"
  | "MEMBER_NOT_FOUND"
  // Genérico: autenticado, mas sem permissão para a ação (README §16).
  | "FORBIDDEN"
  // Phase 3 — Alerta de Emergência
  | "ALERT_NOT_FOUND"
  | "ALERT_ALREADY_ACTIVE"
  | "INVALID_ALERT_TRANSITION"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_REUSED";

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

  // Phase 2 — Grupos de Confiança
  groupNotFound: () => new AppError("GROUP_NOT_FOUND", 404, "Grupo não encontrado."),
  groupNameInvalid: () => new AppError("GROUP_NAME_INVALID", 400, "Nome de grupo inválido."),
  insufficientGroupRole: () =>
    new AppError("INSUFFICIENT_GROUP_ROLE", 403, "Permissão insuficiente no grupo."),
  alreadyGroupMember: () =>
    new AppError("ALREADY_GROUP_MEMBER", 409, "Esta pessoa já é membro do grupo."),
  cannotInviteSelf: () =>
    new AppError("CANNOT_INVITE_SELF", 400, "Você não pode convidar a si mesmo."),
  invitationAlreadyPending: () =>
    new AppError("INVITATION_ALREADY_PENDING", 409, "Já existe um convite pendente."),
  invitationNotFound: () => new AppError("INVITATION_NOT_FOUND", 404, "Convite não encontrado."),
  invitationExpired: () => new AppError("INVITATION_EXPIRED", 410, "Convite expirado."),
  invitationAlreadyProcessed: () =>
    new AppError("INVITATION_ALREADY_PROCESSED", 409, "Convite já processado."),
  invitationNotForUser: () =>
    new AppError("INVITATION_NOT_FOR_USER", 403, "Este convite não é para você."),
  ownerCannotLeaveGroup: () =>
    new AppError("OWNER_CANNOT_LEAVE_GROUP", 403, "O proprietário não pode sair do grupo."),
  cannotRemoveOwner: () =>
    new AppError("CANNOT_REMOVE_OWNER", 403, "Não é possível remover o proprietário."),
  invalidGroupRole: () => new AppError("INVALID_GROUP_ROLE", 400, "Papel de grupo inválido."),
  memberNotFound: () => new AppError("MEMBER_NOT_FOUND", 404, "Membro não encontrado."),

  forbidden: () => new AppError("FORBIDDEN", 403, "Você não tem permissão para esta ação."),

  // Phase 3 — Alerta de Emergência
  alertNotFound: () => new AppError("ALERT_NOT_FOUND", 404, "Alerta não encontrado."),
  alertAlreadyActive: () =>
    new AppError("ALERT_ALREADY_ACTIVE", 409, "Você já possui um alerta ativo neste grupo."),
  invalidAlertTransition: () =>
    new AppError("INVALID_ALERT_TRANSITION", 409, "Transição de estado do alerta inválida."),
  invalidIdempotencyKey: () =>
    new AppError("INVALID_IDEMPOTENCY_KEY", 400, "Cabeçalho Idempotency-Key ausente ou inválido."),
  idempotencyKeyReused: () =>
    new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "Idempotency-Key já utilizada com uma requisição diferente.",
    ),
};
