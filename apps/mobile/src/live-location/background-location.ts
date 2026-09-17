import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { strings } from "../i18n/pt-BR";
import { colors } from "../theme/colors";
import {
  toLocationSample,
  WATCH_DISTANCE_INTERVAL_M,
  WATCH_TIME_INTERVAL_MS,
  type LocationSample,
} from "./location-sample";

/**
 * Fonte única de GPS do compartilhamento ao vivo (Phase 13).
 *
 * Substitui o `watchPositionAsync` de primeiro plano por atualizações de
 * localização do sistema operacional, para que a posição continue chegando com
 * **a tela bloqueada ou o app em segundo plano** — a situação real de quem está
 * a caminho de casa com o celular no bolso.
 *
 * No Android isso é um **serviço em primeiro plano**: existe uma notificação
 * fixa enquanto o compartilhamento está ligado. Duas consequências, ambas
 * desejadas:
 *
 * 1. A pessoa vê, o tempo todo, que está compartilhando — nada acontece às
 *    escondidas.
 * 2. Não é preciso a permissão `ACCESS_BACKGROUND_LOCATION`, que continua
 *    bloqueada no `app.json` e exigiria declaração formal na Google Play. O
 *    compartilhamento só pode ser iniciado com o app aberto, que é exatamente
 *    o fluxo do produto (ADR 0015).
 *
 * No iOS são atualizações em segundo plano com o indicador azul visível, pelo
 * mesmo motivo.
 *
 * Um único stream do SO alimenta todos os compartilhamentos ativos (alerta e
 * trajeto ao mesmo tempo, por exemplo): as atualizações começam no primeiro
 * assinante e param no último.
 */

export const LIVE_LOCATION_TASK = "safecircle-live-location";

type SampleListener = (sample: LocationSample) => void;

const listeners = new Set<SampleListener>();
/** Evita chamadas concorrentes de start/stop ao SO. */
let transition: Promise<void> = Promise.resolve();

function deliver(sample: LocationSample): void {
  for (const listener of [...listeners]) {
    listener(sample);
  }
}

interface LocationTaskData {
  locations?: Location.LocationObject[];
}

/**
 * A task é definida no import, não sob demanda: o SO pode reativar o processo
 * já esperando que ela exista.
 */
if (!TaskManager.isTaskDefined(LIVE_LOCATION_TASK)) {
  TaskManager.defineTask<LocationTaskData>(LIVE_LOCATION_TASK, async ({ data, error }) => {
    // Erro do SO (GPS desligado, permissão revogada): o controller já trata a
    // ausência de amostras; aqui não há o que fazer além de não quebrar.
    if (error) return;
    const locations = data?.locations ?? [];
    if (listeners.size === 0) {
      // Processo reiniciado pelo SO sem nenhum compartilhamento ativo: desliga
      // para não deixar um serviço em primeiro plano órfão consumindo bateria.
      await stopUpdates().catch(() => undefined);
      return;
    }
    for (const position of locations) {
      const sample = toLocationSample(position);
      if (sample) deliver(sample);
    }
  });
}

function taskOptions(): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.High,
    timeInterval: WATCH_TIME_INTERVAL_MS,
    distanceInterval: WATCH_DISTANCE_INTERVAL_M,
    // iOS: mantém o indicador azul visível; nunca rastrear sem sinal na tela.
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: strings.liveLocation.serviceNotificationTitle,
      notificationBody: strings.liveLocation.serviceNotificationBody,
      notificationColor: colors.primary,
      // App encerrado pela pessoa encerra o compartilhamento: sem serviço
      // sobrevivente que ela não consiga ver nem parar.
      killServiceOnDestroy: true,
    },
  };
}

async function startUpdates(): Promise<void> {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return;
  const started = await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
  if (started) return;
  await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, taskOptions());
}

async function stopUpdates(): Promise<void> {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return;
  const started = await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK).catch(
    () => false,
  );
  if (!started) return;
  await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK);
}

/** Serializa start/stop: dois compartilhamentos entrando ao mesmo tempo não corrida. */
function enqueueTransition(work: () => Promise<void>): Promise<void> {
  transition = transition.then(work, work);
  return transition;
}

/**
 * Assina o stream de posições. O primeiro assinante liga as atualizações do SO
 * (e o serviço em primeiro plano no Android); o último as desliga.
 */
export async function subscribeLocationUpdates(
  listener: SampleListener,
): Promise<{ remove: () => void }> {
  listeners.add(listener);
  try {
    await enqueueTransition(startUpdates);
  } catch (error) {
    listeners.delete(listener);
    throw error;
  }

  let removed = false;
  return {
    remove: () => {
      if (removed) return;
      removed = true;
      listeners.delete(listener);
      if (listeners.size === 0) {
        void enqueueTransition(stopUpdates);
      }
    },
  };
}

/** Só para testes e para o encerramento de sessão: derruba tudo sem esperar. */
export async function stopAllLocationUpdates(): Promise<void> {
  listeners.clear();
  await enqueueTransition(stopUpdates);
}

export function activeListenerCount(): number {
  return listeners.size;
}
