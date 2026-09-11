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
    connected: "Sua conta está conectada.",
    comingSoon: "As funcionalidades de grupos de confiança estarão disponíveis em breve.",
    logout: "Sair",
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
