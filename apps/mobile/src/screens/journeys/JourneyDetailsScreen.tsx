import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { JourneyLiveLocationSection } from "../../components/JourneyLiveLocationSection";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { getJourneyLiveLocationController } from "../../live-location/LiveLocationController";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type SafeJourney } from "../../lib/api";
import { formatTime, secondsUntil } from "../../lib/time";
import { useNow } from "../../live-location/useLiveLocation";
import { isJourneyEvent, type RealtimeEvent } from "../../realtime/events";
import { useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

/**
 * Detalhe do trajeto (Phase 8).
 *
 * - O contador é visual; ao zerar, consulta o backend e aguarda o estado
 *   autoritativo (nunca marca OVERDUE localmente).
 * - Dono: CHEGUEI EM SEGURANÇA (ACTIVE/OVERDUE) e CANCELAR (com confirmação).
 * - Membros em OVERDUE: aviso honesto — não confirma emergência.
 * - Eventos realtime do trajeto (exceto localização, tratada pela seção),
 *   (re)conexão e volta ao primeiro plano recarregam via REST.
 */
export function JourneyDetailsScreen({
  nav,
  journeyId,
}: {
  nav: Nav;
  journeyId: string;
}): React.JSX.Element {
  const { api, user } = useAuth();
  const t = strings.journeys;
  const now = useNow(1000);
  const [journey, setJourney] = useState<SafeJourney | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const zeroReloadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setJourney(await api.getJourney(journeyId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
    }
  }, [api, journeyId, t.loadError]);

  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => subscription.remove();
  }, [load]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      // Eventos de localização são tratados pela própria seção.
      if (
        event.data.journeyId === journeyId &&
        isJourneyEvent(event) &&
        event.type !== "JOURNEY_LOCATION_UPDATED"
      ) {
        void load();
      }
    },
    [journeyId, load],
  );
  useRealtimeEvents(onEvent, load);

  const remaining = journey ? secondsUntil(journey.expectedArrivalAt, now) : 0;
  useEffect(() => {
    if (journey?.status === "ACTIVE" && remaining <= 0 && !zeroReloadedRef.current) {
      zeroReloadedRef.current = true;
      void load();
    }
    if (journey?.status !== "ACTIVE") zeroReloadedRef.current = false;
  }, [journey, remaining, load]);

  async function run(action: () => Promise<SafeJourney>, message: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setJourney(next);
      setFeedback(message);
      // O backend já encerrou a sessão ao vivo na mesma transação; o watcher
      // local para imediatamente (nunca continuar enviando depois).
      void getJourneyLiveLocationController(journeyId, api).stop({ notifyBackend: false });
    } catch (e) {
      await load();
      setError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  if (!journey) {
    return (
      <Screen title={t.detailsTitle} onBack={() => nav.goBack()}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </Screen>
    );
  }

  const isOwner = journey.user.id === user?.id;
  const isActive = journey.status === "ACTIVE";
  const isOverdue = journey.status === "OVERDUE";

  return (
    <Screen title={t.detailsTitle} onBack={() => nav.goBack()}>
      <Text
        style={isOverdue ? styles.overdue : isActive ? styles.statusOn : styles.statusDone}
        accessibilityRole="header"
      >
        {t.statusLabels[journey.status] ?? journey.status}
      </Text>

      {feedback ? (
        <View style={styles.feedback} accessibilityRole="alert">
          <Text style={styles.body}>{feedback}</Text>
        </View>
      ) : null}

      {isActive ? <Text style={styles.countdown}>{t.remaining(remaining)}</Text> : null}

      {isOverdue && isOwner ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeTitle}>{t.overdueTitle}</Text>
          <Text style={styles.body}>{t.ownerOverdue}</Text>
          <Text style={styles.muted}>{t.ownerOverdueNote}</Text>
        </View>
      ) : null}
      {isOverdue && !isOwner ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeTitle}>{t.overdueTitle}</Text>
          <Text style={styles.body}>{t.memberOverdue(journey.user.name)}</Text>
          <Text style={styles.muted}>{t.memberOverdueNote}</Text>
          <Text style={styles.muted}>{t.memberOverdueGuidance}</Text>
        </View>
      ) : null}

      <View style={styles.rows}>
        <Row label={t.user} value={journey.user.name} />
        <Row label={t.group} value={journey.groupName} />
        <Row label={t.destinationRow} value={journey.destinationLabel ?? t.noDestination} />
        <Row label={t.startedAt} value={formatTime(journey.startedAt)} />
        <Row label={t.expectedAt} value={formatTime(journey.expectedArrivalAt)} />
        {journey.arrivedAt ? (
          <Row label={t.arrivedAt} value={formatTime(journey.arrivedAt)} />
        ) : null}
        {journey.cancelledAt ? (
          <Row label={t.cancelledAt} value={formatTime(journey.cancelledAt)} />
        ) : null}
        {journey.overdueAt ? (
          <Row label={t.overdueAt} value={formatTime(journey.overdueAt)} />
        ) : null}
      </View>

      <JourneyLiveLocationSection journey={journey} isOwner={isOwner} />

      {isOwner && (isActive || isOverdue) ? (
        <View style={styles.actions}>
          <PrimaryButton
            label={t.arrived}
            onPress={() => void run(() => api.arriveJourney(journey.id), t.arrivedFeedback)}
            loading={busy}
          />
          {confirmingCancel ? (
            <View style={styles.confirmBar}>
              <Text style={styles.body}>{t.confirmCancelMessage}</Text>
              <View style={styles.inlineActions}>
                <Pressable
                  style={[styles.confirmButton, styles.confirmDanger]}
                  onPress={() => void run(() => api.cancelJourney(journey.id), t.cancelledFeedback)}
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
            </View>
          ) : (
            <Pressable
              style={styles.cancelButton}
              onPress={() => setConfirmingCancel(true)}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>{t.cancel}</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusOn: { color: colors.accent, fontSize: 18, fontWeight: "800" },
  statusDone: { color: colors.mutedText, fontSize: 18, fontWeight: "800" },
  overdue: { color: colors.danger, fontSize: 18, fontWeight: "800" },
  countdown: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  feedback: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  notice: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  noticeTitle: { color: colors.primaryText, fontSize: 16, fontWeight: "800" },
  rows: { gap: 12 },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 2,
  },
  rowLabel: { color: colors.mutedText, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.primaryText, fontSize: 17, fontWeight: "700" },
  actions: { gap: 12 },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelText: { color: colors.danger, fontSize: 15, fontWeight: "800" },
  confirmBar: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 12,
    gap: 10,
  },
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
