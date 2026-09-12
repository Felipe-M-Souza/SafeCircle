import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { strings, translateErrorCode } from "../i18n/pt-BR";
import { ApiError, type SafeJourney } from "../lib/api";
import { formatTime, secondsUntil } from "../lib/time";
import { useNow } from "../live-location/useLiveLocation";
import { isJourneyEvent, type RealtimeEvent } from "../realtime/events";
import { useRealtimeEvents } from "../realtime/RealtimeProvider";
import { colors } from "../theme/colors";
import type { Nav } from "../navigation/types";
import { PrimaryButton } from "./PrimaryButton";

/**
 * Seção "Trajeto seguro" da Home (Phase 8).
 *
 * O contador é apenas visual: ao chegar a zero o app consulta o backend e
 * aguarda o estado autoritativo — nunca marca OVERDUE por conta própria.
 * Recarrega a cada evento realtime de trajeto, a cada (re)conexão e ao voltar
 * ao primeiro plano.
 */
export function JourneysHomeSection({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.journeys;
  const now = useNow(1000);
  const [journeys, setJourneys] = useState<SafeJourney[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const zeroReloadedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [active, overdue] = await Promise.all([
        api.listMyJourneys("ACTIVE"),
        api.listMyJourneys("OVERDUE"),
      ]);
      setJourneys([...active, ...overdue]);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
      setJourneys((previous) => previous ?? []);
    }
  }, [api, t.loadError]);

  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => subscription.remove();
  }, [load]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (isJourneyEvent(event)) void load();
    },
    [load],
  );
  useRealtimeEvents(onEvent, load);

  const current = journeys?.[0] ?? null;
  const remaining = current ? secondsUntil(current.expectedArrivalAt, now) : 0;

  useEffect(() => {
    if (current?.status === "ACTIVE" && remaining <= 0 && zeroReloadedRef.current !== current.id) {
      zeroReloadedRef.current = current.id;
      void load();
    }
  }, [current, remaining, load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      await load();
      setError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  return (
    <View style={styles.card} testID="journeys-home-section">
      <Text style={styles.title}>{t.sectionTitle}</Text>

      {current ? (
        <View style={styles.block}>
          <Text style={current.status === "OVERDUE" ? styles.overdue : styles.statusOn}>
            {current.status === "OVERDUE" ? t.overdueTitle : t.activeTitle}
          </Text>
          <Text style={styles.body}>
            {current.destinationLabel ? t.destination(current.destinationLabel) : t.noDestination}
          </Text>
          {current.status === "ACTIVE" ? (
            <>
              <Text style={styles.body}>
                {t.expectedArrival(formatTime(current.expectedArrivalAt))}
              </Text>
              <Text style={styles.muted}>{t.remaining(remaining)}</Text>
            </>
          ) : (
            <Text style={styles.muted}>{t.ownerOverdue}</Text>
          )}

          <PrimaryButton
            label={t.arrived}
            onPress={() => void run(() => api.arriveJourney(current.id))}
            loading={busy}
          />
          {confirmingCancel ? (
            <View style={styles.inlineActions}>
              <Pressable
                style={[styles.confirmButton, styles.confirmDanger]}
                onPress={() => void run(() => api.cancelJourney(current.id))}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text style={styles.confirmDangerText}>{t.confirmCancel}</Text>
              </Pressable>
              <Pressable
                style={styles.confirmButton}
                onPress={() => setConfirmingCancel(false)}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>{t.keep}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => setConfirmingCancel(true)}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>{t.cancel}</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => nav.navigate({ name: "journeyDetails", journeyId: current.id })}
            accessibilityRole="button"
          >
            <Text style={styles.link}>{t.viewDetails}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.block}>
          <Text style={styles.body}>{t.intro}</Text>
          <PrimaryButton
            label={t.start}
            onPress={() => nav.navigate({ name: "newJourney" })}
            disabled={journeys === null}
          />
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  block: { gap: 10 },
  title: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  statusOn: { color: colors.accent, fontSize: 15, fontWeight: "800" },
  overdue: { color: colors.danger, fontSize: 15, fontWeight: "800" },
  link: { color: colors.primary, fontWeight: "700", textAlign: "center" },
  cancelText: { color: colors.danger, fontWeight: "800", textAlign: "center", paddingVertical: 8 },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  confirmButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  confirmDangerText: { color: "#450a0a", fontWeight: "800" },
  secondaryText: { color: colors.primaryText, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 14 },
});
