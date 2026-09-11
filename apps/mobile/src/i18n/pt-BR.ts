/**
 * Textos de interface em Português do Brasil (pt-BR).
 *
 * Centralizamos as strings para evitar espalhá-las pelos componentes e para
 * preparar uma futura internacionalização (pt-BR / en-US / es) sem reescrever
 * o domínio. Na Phase 0 mantemos apenas o necessário para a tela inicial.
 */
export const ptBR = {
  home: {
    appName: "SafeCircle",
    tagline: "Sua rede de confiança para situações de emergência.",
    environmentReady: "Ambiente de desenvolvimento configurado.",
    disclaimer:
      "O SafeCircle não substitui Polícia, SAMU, Corpo de Bombeiros ou outros serviços oficiais de emergência.",
    phaseLabel: "Phase 0 — Fundação",
  },
} as const;

export type Strings = typeof ptBR;

/** Idioma padrão do produto na Phase 0. */
export const strings = ptBR;
