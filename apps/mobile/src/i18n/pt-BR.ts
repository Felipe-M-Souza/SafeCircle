import { ApiError } from "../lib/api";

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
  acknowledgements: {
    sectionTitle: "Respostas do grupo",
    empty: "Nenhuma resposta do grupo ainda.",
    seen: "VI O ALERTA",
    goingToHelp: "ESTOU INDO AJUDAR",
    emergencyContacted: "ACIONEI EMERGÊNCIA",
    yourResponse: "Sua resposta",
    safetyNote:
      "Evite confronto direto. Em risco imediato, acione os serviços oficiais de emergência.",
    closedNote: "O alerta foi encerrado. Novas respostas não são aceitas.",
    types: {
      SEEN: "Viu o alerta",
      ACKNOWLEDGED: "Confirmou o alerta",
      GOING_TO_HELP: "Está indo ajudar",
      EMERGENCY_SERVICES_CONTACTED: "Acionou serviço de emergência",
    } as Record<string, string>,
  },
  realtime: {
    reconnecting: "Reconectando às atualizações em tempo real...",
  },
  errorBoundary: {
    title: "Algo deu errado",
    body: "Não foi possível exibir esta tela.",
    retry: "TENTAR NOVAMENTE",
    // Código curto para o suporte localizar a ocorrência nos logs do servidor.
    supportCode: (code: string) => `Código de suporte: ${code}`,
  },
  checkins: {
    sectionTitle: "Check-in de segurança",
    intro: "Avise seu grupo que você pretende confirmar que está bem até um determinado horário.",
    start: "INICIAR CHECK-IN",
    activeTitle: "Check-in ativo",
    overdueTitle: "Check-in não confirmado",
    confirmBy: (time: string) => `Confirme até ${time}`,
    remaining: (totalSeconds: number) => {
      if (totalSeconds <= 0) return "Prazo encerrado. Aguardando confirmação do servidor...";
      if (totalSeconds < 60) return `Faltam ${totalSeconds} s`;
      const minutes = Math.ceil(totalSeconds / 60);
      return minutes === 1 ? "Falta 1 min" : `Faltam ${minutes} min`;
    },
    imOk: "ESTOU BEM",
    cancel: "CANCELAR CHECK-IN",
    confirmCancelMessage: "Cancelar este check-in? Seu grupo não será avisado.",
    confirmCancel: "Sim, cancelar",
    keep: "Manter check-in",
    viewDetails: "Ver check-in",
    viewGroupCheckins: "Check-ins do grupo",
    newTitle: "Novo check-in",
    groupLabel: "Grupo",
    durationLabel: "Quero confirmar que estou bem em:",
    durations: {
      15: "15 minutos",
      30: "30 minutos",
      60: "1 hora",
      120: "2 horas",
    } as Record<number, string>,
    customDuration: "Personalizado",
    customMinutesLabel: "Minutos (entre 5 e 1440)",
    customMinutesInvalid: "Informe um prazo entre 5 minutos e 24 horas.",
    warning: (time: string, groupName: string) =>
      `Se você não confirmar até ${time}, os membros do grupo ${groupName} serão avisados.`,
    noGroups: "Você precisa participar de um grupo de confiança antes de iniciar um check-in.",
    creating: "Iniciando...",
    detailsTitle: "Check-in",
    statusLabels: {
      ACTIVE: "Aguardando confirmação",
      SAFE: "Confirmou que está bem",
      OVERDUE: "O prazo venceu sem confirmação",
      CANCELLED: "Check-in cancelado",
    } as Record<string, string>,
    user: "Quem",
    group: "Grupo",
    status: "Status",
    createdAt: "Criado às",
    dueAt: "Prazo",
    confirmedAt: "Confirmado às",
    cancelledAt: "Cancelado às",
    overdueAt: "Vencido às",
    ownerOverdue: "Seu check-in venceu sem confirmação.",
    memberOverdue: (name: string) => `O prazo de ${name} venceu sem confirmação.`,
    memberOverdueNote: "Isso não confirma uma emergência. Tente entrar em contato de forma segura.",
    memberOverdueGuidance:
      "Se houver indícios de risco imediato, considere acionar os serviços oficiais de emergência.",
    safeFeedback: "Você confirmou que está bem. Seu grupo foi atualizado.",
    cancelledFeedback: "Check-in cancelado.",
    groupListTitle: (groupName: string) => `Check-ins de ${groupName}`,
    groupListEmpty: "Nenhum check-in neste grupo.",
    loadError: "Não foi possível carregar os check-ins.",
  },
  journeys: {
    sectionTitle: "Trajeto seguro",
    intro: "Compartilhe com seu grupo que você está a caminho e confirme quando chegar.",
    start: "INICIAR TRAJETO",
    activeTitle: "Trajeto em andamento",
    overdueTitle: "Trajeto não confirmado",
    destination: (label: string) => `Destino: ${label}`,
    noDestination: "Sem destino informado",
    expectedArrival: (time: string) => `Chegada prevista: ${time}`,
    remaining: (totalSeconds: number) => {
      if (totalSeconds <= 0) return "Prazo encerrado. Aguardando confirmação do servidor...";
      if (totalSeconds < 60) return `Faltam ${totalSeconds} s`;
      const minutes = Math.ceil(totalSeconds / 60);
      return minutes === 1 ? "Falta 1 min" : `Faltam ${minutes} min`;
    },
    arrived: "CHEGUEI EM SEGURANÇA",
    cancel: "CANCELAR TRAJETO",
    confirmCancelMessage: "Cancelar este trajeto? Seu grupo não será avisado da chegada.",
    confirmCancel: "Sim, cancelar",
    keep: "Manter trajeto",
    viewDetails: "Ver trajeto",
    viewGroupJourneys: "Trajetos do grupo",
    newTitle: "Novo trajeto seguro",
    groupLabel: "Grupo",
    destinationLabel: "Destino (opcional)",
    destinationPlaceholder: "Ex.: Casa, Trabalho, Rodoviária",
    arrivalLabel: "Chegada prevista",
    durations: {
      30: "30 minutos",
      60: "1 hora",
      120: "2 horas",
    } as Record<number, string>,
    customDuration: "Personalizado",
    customMinutesLabel: "Minutos (entre 10 e 1440)",
    customMinutesInvalid: "Informe um prazo entre 10 minutos e 24 horas.",
    shareLocationLabel: "Compartilhar localização durante o trajeto",
    shareLocationHint:
      "Os membros deste grupo poderão acompanhar sua posição enquanto o trajeto estiver ativo.",
    confirmTitle: "Iniciar trajeto seguro?",
    confirmBody: (time: string) =>
      `Seu grupo será avisado se você não confirmar a chegada até ${time}.`,
    confirmSharingOn: "Compartilhamento de localização: Ativado",
    confirmSharingOff: "Compartilhamento de localização: Desativado",
    confirmStart: "Iniciar",
    confirmCancelStart: "Cancelar",
    creating: "Iniciando...",
    noGroups: "Você precisa participar de um grupo de confiança antes de iniciar um trajeto.",
    detailsTitle: "Trajeto",
    statusLabels: {
      ACTIVE: "A caminho",
      ARRIVED: "Chegada confirmada com segurança.",
      OVERDUE: "Chegada não confirmada",
      CANCELLED: "Trajeto cancelado.",
    } as Record<string, string>,
    user: "Quem",
    group: "Grupo",
    destinationRow: "Destino",
    startedAt: "Início",
    expectedAt: "Chegada prevista",
    arrivedAt: "Chegou às",
    cancelledAt: "Cancelado às",
    overdueAt: "Vencido às",
    ownerOverdue: "O prazo esperado passou sem confirmação.",
    ownerOverdueNote: "Isso não confirma uma emergência.",
    memberOverdue: (name: string) => `O prazo de chegada de ${name} passou sem confirmação.`,
    memberOverdueNote: "Isso não confirma uma emergência. Tente entrar em contato de forma segura.",
    memberOverdueGuidance:
      "Se houver indícios de risco imediato, considere acionar os serviços oficiais de emergência.",
    arrivedFeedback: "Chegada confirmada com segurança. Seu grupo foi atualizado.",
    cancelledFeedback: "Trajeto cancelado.",
    locationTitle: "Localização do trajeto",
    locationNotShared: "Localização não compartilhada neste trajeto.",
    groupListTitle: (groupName: string) => `Trajetos de ${groupName}`,
    groupListEmpty: "Nenhum trajeto neste grupo.",
    loadError: "Não foi possível carregar os trajetos.",
  },
  liveLocation: {
    title: "Localização ao vivo",
    description: "Compartilhe sua posição enquanto este alerta estiver ativo.",
    enable: "ATIVAR LOCALIZAÇÃO AO VIVO",
    consentTitle: "Compartilhar localização ao vivo",
    consentBody:
      "Sua localização será compartilhada apenas com os membros deste grupo enquanto o alerta estiver ativo.\n\nVocê pode interromper o compartilhamento a qualquer momento.",
    consentConfirm: "Compartilhar",
    consentCancel: "Agora não",
    starting: "Ativando...",
    statusActive: "Ativa",
    statusStopped: "Interrompida",
    statusStale: "Sem atualização recente",
    statusInactive: "Desativada",
    creatorNote: "Seu grupo pode ver sua localização enquanto o compartilhamento estiver ativo.",
    stop: "PARAR LOCALIZAÇÃO AO VIVO",
    confirmStopMessage: "Parar de compartilhar sua localização com o grupo?",
    confirmStop: "Sim, parar",
    keepSharing: "Continuar compartilhando",
    lastUpdate: (seconds: number) =>
      seconds < 5 ? "Última atualização agora" : `Última atualização há ${seconds} s`,
    accuracy: (meters: number) => `Precisão aproximada: ${Math.round(meters)} m`,
    permissionDenied:
      "Não foi possível ativar a localização ao vivo.\n\nVocê pode continuar usando o alerta normalmente.",
    servicesDisabled:
      "A localização do aparelho está desligada. Ative-a nas configurações para compartilhar sua posição.",
    openSettings: "Abrir configurações",
    degraded: "Sem conexão. A última posição será enviada quando a rede voltar.",
    notSharing: "O usuário não está compartilhando localização ao vivo.",
    waitingFirstPoint: "Localização ainda não disponível.",
    center: "CENTRALIZAR",
    mapUnavailable: "Mapa indisponível nesta plataforma.",
    foregroundOnlyNote:
      "O compartilhamento funciona com o SafeCircle aberto. Em segundo plano, a posição pode deixar de ser atualizada.",
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
    // Phase 5 — Tempo Real / respostas do grupo
    ALERT_NOT_ACTIVE: "Este alerta não está mais ativo.",
    // Phase 6 — Localização ao Vivo
    LIVE_LOCATION_NOT_ACTIVE: "O compartilhamento de localização ao vivo não está ativo.",
    LOCATION_UPDATE_TOO_FREQUENT: "Atualizações de localização muito frequentes.",
    // Phase 7 — Check-in de Segurança
    CHECKIN_NOT_FOUND: "Check-in não encontrado.",
    CHECKIN_ALREADY_ACTIVE: "Você já possui um check-in ativo neste grupo.",
    INVALID_CHECKIN_TRANSITION: "Este check-in já foi encerrado.",
    INVALID_CHECKIN_DUE_AT: "Prazo inválido. Escolha entre 5 minutos e 24 horas.",
    // Phase 8 — Trajeto Seguro
    JOURNEY_NOT_FOUND: "Trajeto não encontrado.",
    JOURNEY_ALREADY_ACTIVE: "Você já possui um trajeto em andamento.",
    JOURNEY_NOT_ACTIVE: "Este trajeto não está mais ativo.",
    INVALID_JOURNEY_EXPECTED_ARRIVAL:
      "Horário de chegada inválido. Escolha entre 10 minutos e 24 horas.",
    INVALID_JOURNEY_TRANSITION: "Este trajeto já foi encerrado.",
    JOURNEY_LIVE_LOCATION_NOT_ACTIVE:
      "O compartilhamento de localização do trajeto não está ativo.",
    JOURNEY_LIVE_LOCATION_DISABLED: "Este trajeto não habilitou o compartilhamento de localização.",
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

/**
 * Mensagem pt-BR para qualquer erro (Phase 9).
 *
 * Erros esperados (validação, autorização, conflito) mostram só a mensagem —
 * acrescentar um código a eles seria ruído. Falhas **inesperadas** (5xx)
 * ganham o código de suporte, que é exatamente o `errorId`/`requestId` do log
 * do servidor: é o que torna um "erro interno" investigável.
 *
 * `fallback` cobre o que não veio da API (ex.: falha ao carregar uma lista).
 */
export function translateApiError(error: unknown, fallback: string = ptBR.common.genericError) {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  const message = translateErrorCode(error.code);
  const unexpected = error.status >= 500 || error.code === "INTERNAL_ERROR";
  return unexpected && error.supportCode
    ? `${message}\n\n${ptBR.errorBoundary.supportCode(error.supportCode)}`
    : message;
}
