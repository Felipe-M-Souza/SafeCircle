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
  // Rota inexistente (Phase 9): mesmo formato dos demais erros.
  | "NOT_FOUND"
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
  | "IDEMPOTENCY_KEY_REUSED"
  // Phase 4 — Notificações Push
  | "INVALID_PUSH_TOKEN"
  | "INVALID_DEVICE_ID"
  | "INVALID_PUSH_PLATFORM"
  | "PUSH_DEVICE_NOT_FOUND"
  // Phase 5 — Tempo Real / acknowledgements
  | "ALERT_NOT_ACTIVE"
  // Phase 6 — Localização ao Vivo
  | "LIVE_LOCATION_NOT_ACTIVE"
  | "LOCATION_UPDATE_TOO_FREQUENT"
  // Phase 7 — Check-in de Segurança
  | "CHECKIN_NOT_FOUND"
  | "CHECKIN_ALREADY_ACTIVE"
  | "INVALID_CHECKIN_TRANSITION"
  | "INVALID_CHECKIN_DUE_AT"
  // Phase 8 — Trajeto Seguro
  | "JOURNEY_NOT_FOUND"
  | "JOURNEY_ALREADY_ACTIVE"
  | "JOURNEY_NOT_ACTIVE"
  | "INVALID_JOURNEY_EXPECTED_ARRIVAL"
  | "INVALID_JOURNEY_TRANSITION"
  | "JOURNEY_LIVE_LOCATION_NOT_ACTIVE"
  | "JOURNEY_LIVE_LOCATION_DISABLED";

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

  // Phase 4 — Notificações Push
  invalidPushToken: () => new AppError("INVALID_PUSH_TOKEN", 400, "Push token inválido."),
  invalidDeviceId: () =>
    new AppError("INVALID_DEVICE_ID", 400, "Identificador de dispositivo inválido."),
  invalidPushPlatform: () =>
    new AppError("INVALID_PUSH_PLATFORM", 400, "Plataforma de push inválida."),
  pushDeviceNotFound: () =>
    new AppError("PUSH_DEVICE_NOT_FOUND", 404, "Dispositivo de push não encontrado."),

  // Phase 5 — Tempo Real / acknowledgements
  alertNotActive: () => new AppError("ALERT_NOT_ACTIVE", 409, "Este alerta não está mais ativo."),

  // Phase 6 — Localização ao Vivo
  liveLocationNotActive: () =>
    new AppError(
      "LIVE_LOCATION_NOT_ACTIVE",
      409,
      "O compartilhamento de localização ao vivo não está ativo.",
    ),
  locationUpdateTooFrequent: () =>
    new AppError(
      "LOCATION_UPDATE_TOO_FREQUENT",
      429,
      "Atualizações de localização muito frequentes.",
    ),

  // Phase 7 — Check-in de Segurança
  checkinNotFound: () => new AppError("CHECKIN_NOT_FOUND", 404, "Check-in não encontrado."),
  checkinAlreadyActive: () =>
    new AppError("CHECKIN_ALREADY_ACTIVE", 409, "Você já possui um check-in ativo neste grupo."),
  invalidCheckinTransition: () =>
    new AppError("INVALID_CHECKIN_TRANSITION", 409, "Transição de estado do check-in inválida."),
  invalidCheckinDueAt: (message = "Prazo do check-in inválido.") =>
    new AppError("INVALID_CHECKIN_DUE_AT", 400, message),

  // Phase 8 — Trajeto Seguro
  journeyNotFound: () => new AppError("JOURNEY_NOT_FOUND", 404, "Trajeto não encontrado."),
  journeyAlreadyActive: () =>
    new AppError("JOURNEY_ALREADY_ACTIVE", 409, "Você já possui um trajeto em andamento."),
  journeyNotActive: () => new AppError("JOURNEY_NOT_ACTIVE", 409, "Este trajeto não está ativo."),
  invalidJourneyExpectedArrival: (message = "Horário de chegada previsto inválido.") =>
    new AppError("INVALID_JOURNEY_EXPECTED_ARRIVAL", 400, message),
  invalidJourneyTransition: () =>
    new AppError("INVALID_JOURNEY_TRANSITION", 409, "Transição de estado do trajeto inválida."),
  journeyLiveLocationNotActive: () =>
    new AppError(
      "JOURNEY_LIVE_LOCATION_NOT_ACTIVE",
      409,
      "O compartilhamento de localização do trajeto não está ativo.",
    ),
  journeyLiveLocationDisabled: () =>
    new AppError(
      "JOURNEY_LIVE_LOCATION_DISABLED",
      409,
      "Este trajeto não habilitou o compartilhamento de localização.",
    ),
};
