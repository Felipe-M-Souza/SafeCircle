/**
 * Formatação de horários para a interface (sem depender de Intl no runtime).
 */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** "17:42" no fuso horário local do dispositivo. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Segundos inteiros até `iso` (negativo quando o instante já passou). */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return 0;
  }
  return Math.round((target - now) / 1000);
}

/** Minutos inteiros decorridos desde `iso` (nunca negativo). */
export function minutesSince(iso: string, now: number = Date.now()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - then) / 60_000));
}
