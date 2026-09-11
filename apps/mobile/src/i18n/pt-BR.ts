/**
 * Textos de interface em Português do Brasil (pt-BR).
 *
 * Centralizamos as strings para evitar espalhá-las pelos componentes e para
 * preparar uma futura internacionalização (pt-BR / en-US / es) sem reescrever
 * o domínio.
 */
export const ptBR = {
  common: {
    appName: "SafeCircle",
    loading: "Carregando...",
    genericError: "Algo deu errado. Tente novamente.",
  },
  home: {
    tagline: "Sua rede de confiança para situações de emergência.",
    disclaimer:
      "O SafeCircle não substitui Polícia, SAMU, Corpo de Bombeiros ou outros serviços oficiais de emergência.",
  },
  splash: {
    restoringSession: "Restaurando sua sessão...",
  },
  login: {
    title: "Entre na sua conta",
    email: "E-mail",
    password: "Senha",
    submit: "Entrar",
    noAccountQuestion: "Ainda não possui uma conta?",
    goToRegister: "Criar conta",
    submitting: "Entrando...",
  },
  register: {
    title: "Crie sua conta",
    name: "Nome",
    email: "E-mail",
    password: "Senha",
    confirmPassword: "Confirmar senha",
    submit: "Criar conta",
    hasAccountQuestion: "Já possui uma conta?",
    goToLogin: "Entrar",
    submitting: "Criando conta...",
  },
  authenticatedHome: {
    greeting: (name: string) => `Olá, ${name}.`,
    subtitle: "Sua rede de confiança",
    myGroups: "Meus grupos",
    receivedInvitations: "Convites recebidos",
    pendingInvitations: (count: number) =>
      count === 1 ? "1 convite pendente" : `${count} convites pendentes`,
    logout: "Sair",
    // Phase 3 — Alerta de Emergência
    selectedGroup: "Grupo selecionado",
    chooseGroupHint: "Toque em um grupo para selecioná-lo.",
    loadingGroups: "Carregando seus grupos...",
    noGroups: "Você precisa participar de um grupo de confiança antes de criar um alerta.",
    goToGroups: "Ver meus grupos",
    activeAlerts: "Alertas ativos",
    ownActiveAlert: "Você tem um alerta ativo neste grupo.",
    viewAlert: "Ver alerta",
  },
  sos: {
    holdLabel: "SEGURE PARA PEDIR AJUDA",
    holdHint: "Mantenha pressionado para ativar.",
    accessibilityLabel: "Pedir ajuda ao grupo de confiança",
    accessibilityHint: "Mantenha pressionado por dois segundos para ativar o alerta de emergência.",
    locating: "Obtendo sua localização...",
    activating: "Ativando alerta...",
    // Texto exibido pelo sistema ao pedir permissão de localização (app.json).
    locationPermissionRationale:
      "O SafeCircle pode usar sua localização durante um alerta para ajudar seu grupo de confiança a encontrar você.",
  },
  notifications: {
    title: "Notificações",
    description: "Receba alertas quando alguém do seu grupo pedir ajuda.",
    statusLabel: "Status",
    statusEnabled: "Ativadas",
    statusDisabled: "Desativadas",
    promptTitle: "Ative as notificações",
    promptBody:
      "O SafeCircle usa notificações para avisar quando alguém do seu grupo de confiança pedir ajuda.",
    enable: "Ativar notificações",
    notNow: "Agora não",
    deniedTitle: "Notificações desativadas",
    deniedBody: "Sem notificações, você só verá os alertas ao abrir o SafeCircle.",
    tryAgain: "Tentar novamente",
    blockedBody: "Ative as notificações nas configurações do aparelho para receber alertas.",
    openSettings: "Abrir configurações",
    unavailable: "Notificações push não estão disponíveis nesta plataforma.",
  },
  alertStatus: {
    ACTIVE: "ATIVO",
    RESOLVED: "RESOLVIDO",
    CANCELLED: "CANCELADO",
  } as Record<string, string>,
  alerts: {
    listTitle: "Alertas ativos",
    empty: "Nenhum alerta ativo nos seus grupos.",
    refreshHint: "Puxe para atualizar. A lista também é atualizada ao voltar para o aplicativo.",
    activatedAgo: (minutes: number) => {
      if (minutes < 1) return "Ativado agora";
      if (minutes < 60) return minutes === 1 ? "Ativado há 1 min" : `Ativado há ${minutes} min`;
      const hours = Math.floor(minutes / 60);
      return hours === 1 ? "Ativado há 1 h" : `Ativado há ${hours} h`;
    },
    viewAlert: "Ver alerta",
    loadError: "Não foi possível carregar os alertas.",
  },
  alertDetails: {
    titleActive: "🚨 Alerta ativo",
    titleResolved: "Alerta resolvido",
    titleCancelled: "Alerta cancelado",
    activatedTitle: "Alerta ativado",
    activatedMessage: (groupName: string) => `Seu alerta está ativo no grupo ${groupName}.`,
    activatedNote: "Os membros do grupo poderão visualizar este alerta no SafeCircle.",
    group: "Grupo",
    triggeredBy: "Acionado por",
    time: "Horário",
    status: "Status",
    location: "Localização",
    locationAvailable: "Disponível",
    locationUnavailable: "Não disponível",
    locationAccuracy: (meters: number) => `Precisão aproximada: ${Math.round(meters)} m`,
    resolvedAt: "Encerrado às",
    cancelledAt: "Cancelado às",
    imSafe: "ESTOU EM SEGURANÇA",
    cancelAlert: "CANCELAR ALERTA",
    confirmCancelMessage:
      "Este alerta foi um acionamento acidental? Ele será cancelado e deixará de aparecer como ativo para o grupo.",
    confirmCancel: "Sim, cancelar alerta",
    keepAlert: "Manter alerta",
    resolvedMessage: "Que bom que você está em segurança. O alerta foi encerrado.",
    cancelledMessage: "O alerta foi cancelado.",
    loadError: "Não foi possível carregar o alerta.",
  },
  roles: {
    OWNER: "Proprietário",
    ADMIN: "Administrador",
    MEMBER: "Membro",
  } as Record<string, string>,
  groups: {
    listTitle: "Meus grupos",
    createCta: "+ Criar grupo",
    memberCount: (count: number) => (count === 1 ? "1 membro" : `${count} membros`),
    youAre: (role: string) => `Você é ${(strings.roles[role] ?? role).toLowerCase()}`,
    empty:
      "Você ainda não participa de nenhum grupo de confiança.\n\nCrie um grupo ou aceite um convite para começar.",
    back: "Voltar",
    loadError: "Não foi possível carregar os grupos.",
  },
  createGroup: {
    title: "Criar grupo de confiança",
    nameLabel: "Nome do grupo",
    submit: "Criar grupo",
    submitting: "Criando...",
  },
  groupDetails: {
    membersTitle: (count: number) => (count === 1 ? "1 membro" : `${count} membros`),
    invite: "Convidar pessoa",
    viewInvitations: "Convites pendentes",
    rename: "Renomear grupo",
    leave: "Sair do grupo",
    remove: "Remover",
    promote: "Tornar administrador",
    demote: "Tornar membro",
    confirmLeaveTitle: "Sair do grupo",
    confirmLeaveMessage: "Tem certeza de que deseja sair deste grupo?",
    confirmRemoveTitle: "Remover membro",
    confirmRemoveMessage: (name: string) => `Remover ${name} do grupo?`,
    cancel: "Cancelar",
    confirm: "Confirmar",
  },
  invite: {
    title: (groupName: string) => `Convidar para ${groupName}`,
    emailLabel: "E-mail",
    submit: "Enviar convite",
    submitting: "Enviando...",
    success: "Convite criado com sucesso.",
  },
  invitations: {
    title: "Convites",
    invitedBy: (name: string) => `Convidado por ${name}`,
    accept: "Aceitar",
    reject: "Recusar",
    empty: "Você não tem convites pendentes.",
  },
  validation: {
    nameRequired: "Informe seu nome.",
    emailRequired: "Informe seu e-mail.",
    emailInvalid: "E-mail inválido.",
    passwordRequired: "Informe sua senha.",
    passwordMin: "A senha deve ter ao menos 8 caracteres.",
    confirmPasswordMismatch: "As senhas não coincidem.",
  },
  // Tradução dos códigos de erro estáveis da API para mensagens naturais.
  errors: {
    VALIDATION_ERROR: "Dados inválidos. Verifique os campos.",
    INVALID_CREDENTIALS: "E-mail ou senha inválidos.",
    UNAUTHORIZED: "Sua sessão expirou. Entre novamente.",
    EMAIL_ALREADY_IN_USE: "Este e-mail já está em uso.",
    INVALID_REFRESH_TOKEN: "Sessão inválida. Entre novamente.",
    SESSION_EXPIRED: "Sua sessão expirou. Entre novamente.",
    SESSION_REVOKED: "Sua sessão foi encerrada. Entre novamente.",
    RATE_LIMITED: "Muitas tentativas. Aguarde um instante e tente novamente.",
    INTERNAL_ERROR: "Erro interno. Tente novamente mais tarde.",
    NETWORK: "Não foi possível conectar ao servidor.",
    // Phase 2 — Grupos de Confiança
    GROUP_NOT_FOUND: "Grupo não encontrado.",
    GROUP_NAME_INVALID: "Nome de grupo inválido.",
    INSUFFICIENT_GROUP_ROLE: "Você não tem permissão para esta ação no grupo.",
    ALREADY_GROUP_MEMBER: "Esta pessoa já é membro do grupo.",
    CANNOT_INVITE_SELF: "Você não pode convidar a si mesmo.",
    INVITATION_ALREADY_PENDING: "Já existe um convite pendente para este e-mail.",
    INVITATION_NOT_FOUND: "Convite não encontrado.",
    INVITATION_EXPIRED: "Este convite expirou.",
    INVITATION_ALREADY_PROCESSED: "Este convite já foi processado.",
    INVITATION_NOT_FOR_USER: "Este convite não é para você.",
    OWNER_CANNOT_LEAVE_GROUP: "O proprietário não pode sair do grupo.",
    CANNOT_REMOVE_OWNER: "Não é possível remover o proprietário.",
    INVALID_GROUP_ROLE: "Papel de grupo inválido.",
    MEMBER_NOT_FOUND: "Membro não encontrado.",
    // Phase 3 — Alerta de Emergência
    FORBIDDEN: "Você não tem permissão para esta ação.",
    ALERT_NOT_FOUND: "Alerta não encontrado.",
    ALERT_ALREADY_ACTIVE: "Você já possui um alerta ativo neste grupo.",
    INVALID_ALERT_TRANSITION: "Este alerta já foi encerrado.",
    INVALID_IDEMPOTENCY_KEY: "Não foi possível registrar o alerta. Tente novamente.",
    IDEMPOTENCY_KEY_REUSED: "Não foi possível registrar o alerta. Tente novamente.",
    // Phase 4 — Notificações Push
    INVALID_PUSH_TOKEN: "Não foi possível ativar as notificações neste aparelho.",
    INVALID_DEVICE_ID: "Não foi possível ativar as notificações neste aparelho.",
    INVALID_PUSH_PLATFORM: "Notificações push não estão disponíveis nesta plataforma.",
    PUSH_DEVICE_NOT_FOUND: "Dispositivo de notificações não encontrado.",
  } as Record<string, string>,
} as const;

export type Strings = typeof ptBR;

/** Idioma padrão do produto. */
export const strings = ptBR;

/** Converte um código de erro da API em mensagem pt-BR. */
export function translateErrorCode(code: string | undefined): string {
  if (code && code in ptBR.errors) {
    return ptBR.errors[code] as string;
  }
  return ptBR.common.genericError;
}
