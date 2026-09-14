import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type Metric,
} from "prom-client";

/**
 * Métricas operacionais (Phase 9) — um único registry para todo o processo.
 *
 * Regras invioláveis (ADR 0010):
 * - **Baixa cardinalidade**: NENHUM label carrega userId, groupId, alertId,
 *   checkinId, journeyId, requestId, errorId, token ou URL com UUID. Todo
 *   valor de label vem de um conjunto controlado no código; entradas
 *   desconhecidas caem em `other`/`unmatched`.
 * - **Sem dado pessoal**: métricas são contadores e durações, nunca conteúdo.
 * - Todas as métricas customizadas usam o prefixo `safecircle_`.
 */

export const METRICS_PREFIX = "safecircle_";

export const registry = new Registry();

/** Métricas padrão de processo (CPU, memória, event loop, GC). */
let defaultMetricsStarted = false;
export function startDefaultMetrics(): void {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  collectDefaultMetrics({ register: registry, prefix: METRICS_PREFIX });
}

function register<T extends Metric>(metric: T): T {
  registry.registerMetric(metric);
  return metric;
}

// ------------------------------------------------------------------
// Normalização de labels (a defesa contra cardinalidade explosiva)
// ------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SAFE_LABEL = /^[A-Za-z0-9_:.\-/]{1,60}$/;

/**
 * Valor de label seguro: sem UUID, curto e com alfabeto restrito. Qualquer
 * coisa fora disso vira `other` — é melhor perder detalhe do que criar uma
 * série temporal por ID.
 */
export function safeLabel(value: string | undefined | null, fallback = "other"): string {
  if (!value) return fallback;
  if (UUID_PATTERN.test(value)) return fallback;
  if (!SAFE_LABEL.test(value)) return fallback;
  return value;
}

/**
 * Rota como **template** do Fastify (`/journeys/:journeyId`), nunca a URL
 * concreta. Requisições sem rota casada viram `unmatched`.
 */
export function routeLabel(routeTemplate: string | undefined): string {
  if (!routeTemplate) return "unmatched";
  if (UUID_PATTERN.test(routeTemplate)) return "unmatched";
  return SAFE_LABEL.test(routeTemplate) ? routeTemplate : "unmatched";
}

/** Classe do status (2xx/4xx/5xx) — mantém a cardinalidade mínima. */
export function statusClass(statusCode: number): string {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  if (statusCode >= 200) return "2xx";
  return "1xx";
}

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------

export const httpRequestsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}http_requests_total`,
    help: "Total de requisições HTTP concluídas.",
    labelNames: ["method", "route", "status_class"] as const,
  }),
);

export const httpRequestDuration = register(
  new Histogram({
    name: `${METRICS_PREFIX}http_request_duration_seconds`,
    help: "Duração das requisições HTTP em segundos.",
    labelNames: ["method", "route", "status_class"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
);

export const httpRequestsInFlight = register(
  new Gauge({
    name: `${METRICS_PREFIX}http_requests_in_flight`,
    help: "Requisições HTTP em andamento.",
    labelNames: ["method"] as const,
  }),
);

// ------------------------------------------------------------------
// Realtime (WebSocket)
// ------------------------------------------------------------------

export const realtimeConnections = register(
  new Gauge({
    name: `${METRICS_PREFIX}realtime_connections`,
    help: "Conexões WebSocket abertas no momento.",
  }),
);

export const realtimeConnectionsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}realtime_connections_total`,
    help: "Total de conexões WebSocket aceitas.",
  }),
);

export const realtimeDisconnectsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}realtime_disconnects_total`,
    help: "Total de desconexões WebSocket, por motivo.",
    labelNames: ["reason"] as const,
  }),
);

export const realtimeEventsPublishedTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}realtime_events_published_total`,
    help: "Eventos realtime publicados, por tipo.",
    labelNames: ["event_type"] as const,
  }),
);

export const realtimePublishFailuresTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}realtime_publish_failures_total`,
    help: "Falhas ao publicar eventos realtime, por tipo.",
    labelNames: ["event_type"] as const,
  }),
);

// ------------------------------------------------------------------
// Tarefas em segundo plano
// ------------------------------------------------------------------

export const backgroundTasksStartedTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}background_tasks_started_total`,
    help: "Tarefas em segundo plano iniciadas, por tipo.",
    labelNames: ["task_type"] as const,
  }),
);

export const backgroundTasksCompletedTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}background_tasks_completed_total`,
    help: "Tarefas em segundo plano concluídas com sucesso, por tipo.",
    labelNames: ["task_type"] as const,
  }),
);

export const backgroundTasksFailedTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}background_tasks_failed_total`,
    help: "Tarefas em segundo plano que falharam, por tipo.",
    labelNames: ["task_type"] as const,
  }),
);

export const backgroundTasksDuration = register(
  new Histogram({
    name: `${METRICS_PREFIX}background_tasks_duration_seconds`,
    help: "Duração das tarefas em segundo plano em segundos.",
    labelNames: ["task_type"] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  }),
);

export const backgroundTasksPending = register(
  new Gauge({
    name: `${METRICS_PREFIX}background_tasks_pending`,
    help: "Tarefas em segundo plano pendentes.",
  }),
);

/** Tipo de tarefa a partir do nome usado no código (sem IDs). */
export function taskTypeLabel(name: string): string {
  return safeLabel(name);
}

// ------------------------------------------------------------------
// Push
// ------------------------------------------------------------------

export const pushDispatchTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}push_dispatch_total`,
    help: "Lotes de push despachados, por tipo de mensagem e resultado.",
    labelNames: ["message_type", "result"] as const,
  }),
);

export const pushMessagesTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}push_messages_total`,
    help: "Mensagens de push processadas, por tipo e resultado.",
    labelNames: ["message_type", "result"] as const,
  }),
);

export const pushInvalidTokensTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}push_invalid_tokens_total`,
    help: "Tokens de push invalidados pelo provedor (desativados).",
    labelNames: ["message_type"] as const,
  }),
);

export const pushFailuresTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}push_failures_total`,
    help: "Falhas de envio de push, por tipo de mensagem.",
    labelNames: ["message_type"] as const,
  }),
);

export const pushDuration = register(
  new Histogram({
    name: `${METRICS_PREFIX}push_duration_seconds`,
    help: "Duração do despacho de push em segundos.",
    labelNames: ["message_type"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }),
);

// ------------------------------------------------------------------
// Schedulers
// ------------------------------------------------------------------

export const schedulerRunsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}scheduler_runs_total`,
    help: "Execuções de scheduler, por scheduler e resultado.",
    labelNames: ["scheduler", "result"] as const,
  }),
);

export const schedulerRunDuration = register(
  new Histogram({
    name: `${METRICS_PREFIX}scheduler_run_duration_seconds`,
    help: "Duração das execuções de scheduler em segundos.",
    labelNames: ["scheduler"] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  }),
);

export const schedulerItemsProcessedTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}scheduler_items_processed_total`,
    help: "Itens marcados como vencidos pelos schedulers.",
    labelNames: ["scheduler"] as const,
  }),
);

export const schedulerFailuresTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}scheduler_failures_total`,
    help: "Falhas em execuções de scheduler (ou em efeitos por item).",
    labelNames: ["scheduler"] as const,
  }),
);

// ------------------------------------------------------------------
// Domínio (apenas transições — nunca conteúdo, geografia ou IDs)
// ------------------------------------------------------------------

export const alertTransitionsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}alert_transitions_total`,
    help: "Transições de estado de alertas de emergência.",
    labelNames: ["transition"] as const,
  }),
);

export const checkinTransitionsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}checkin_transitions_total`,
    help: "Transições de estado de check-ins de segurança.",
    labelNames: ["transition"] as const,
  }),
);

export const journeyTransitionsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}journey_transitions_total`,
    help: "Transições de estado de trajetos seguros.",
    labelNames: ["transition"] as const,
  }),
);

export const liveLocationUpdatesTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}live_location_updates_total`,
    help: "Pontos de localização ao vivo aceitos, por recurso.",
    labelNames: ["resource"] as const,
  }),
);

// ------------------------------------------------------------------
// Auditoria
// ------------------------------------------------------------------

export const auditEventsTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}audit_events_total`,
    help: "Eventos de auditoria persistidos, por tipo e desfecho.",
    labelNames: ["event_type", "outcome"] as const,
  }),
);

export const auditFailuresTotal = register(
  new Counter({
    name: `${METRICS_PREFIX}audit_failures_total`,
    help: "Falhas ao persistir eventos de auditoria, por tipo.",
    labelNames: ["event_type"] as const,
  }),
);

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export function metricsContentType(): string {
  return registry.contentType;
}

/**
 * Valor atual de um counter/gauge (testes e diagnóstico). Soma todas as séries
 * que casam com os labels informados; 0 quando a série ainda não existe.
 */
export async function metricValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  type Entry = { value: number; labels: Record<string, unknown>; metricName?: string };
  const json = await registry.getMetricsAsJSON();

  // Histogramas expõem séries derivadas (`_count`, `_sum`, `_bucket`) dentro da
  // métrica base; aceitamos tanto o nome base quanto o derivado.
  const base = json.find((item) => item.name === name);
  const derived = base
    ? undefined
    : json.find((item) => name.startsWith(`${item.name}_`) && "values" in item);
  const metric = base ?? derived;
  if (!metric) return 0;

  const entries = (metric as { values?: Entry[] }).values ?? [];
  return entries
    .filter((entry) => (derived ? entry.metricName === name : (entry.metricName ?? name) === name))
    .filter((entry) =>
      Object.entries(labels).every(([key, value]) => String(entry.labels[key]) === value),
    )
    .reduce((total, entry) => total + entry.value, 0);
}

/** Apenas para testes: zera todas as séries. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
