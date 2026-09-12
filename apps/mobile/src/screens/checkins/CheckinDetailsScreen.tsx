import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type SafetyCheckin } from "../../lib/api";
import { formatTime, secondsUntil } from "../../lib/time";
import { useNow } from "../../live-location/useLiveLocation";
import type { RealtimeEvent } from "../../realtime/events";
import { useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

/**
 * Detalhe do check-in (Phase 7).
 *
 * - O contador é visual; ao zerar, consulta o backend e aguarda o estado
 *   autoritativo (nunca marca OVERDUE localmente).
 * - Dono: ESTOU BEM (ACTIVE/OVERDUE) e CANCELAR (ACTIVE, com confirmação).
 * - Membros em OVERDUE: aviso honesto — não confirma emergência; orientação
 *   sem incentivar confronto.
 * - Eventos realtime do check-in, (re)conexão e volta ao primeiro plano
 *   recarregam via REST.
 */
export function CheckinDetailsScreen({
  nav,
  checkinId,
}: {
  nav: Nav;
  checkinId: string;
}): React.JSX.Element {
  const { api, user } = useAuth();
  const t = strings.checkins;
  const now = useNow(1000);
  const [checkin, setCheckin] = useState<SafetyCheckin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const zeroReloadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setCheckin(await api.getCheckin(checkinId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
    }
  }, [api, checkinId, t.loadError]);

  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => subscription.remove();
  }, [load]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.data.checkinId === checkinId) void load();
    },
    [checkinId, load],
  );
  useRealtimeEvents(onEvent, load);

  const remaining = checkin ? secondsUntil(checkin.dueAt, now) : 0;
  useEffect(() => {
    if (checkin?.status === "ACTIVE" && remaining <= 0 && !zeroReloadedRef.current) {
      zeroReloadedRef.current = true;
      void load();
    }
    if (checkin?.status !== "ACTIVE") zeroReloadedRef.current = false;
  }, [checkin, remaining, load]);

  async function run(action: () => Promise<SafetyCheckin>, message: string) {
    setBusy(true);
    setError(null);
    try {
      setCheckin(await action());
      setFeedback(message);
    } catch (e) {
      await load();
      setError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  if (!checkin) {
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

  const isOwner = checkin.user.id === user?.id;
  const isActive = checkin.status === "ACTIVE";
  const isOverdue = checkin.status === "OVERDUE";

  return (
    <Screen title={t.detailsTitle} onBack={() => nav.goBack()}>
      <Text
        style={isOverdue ? styles.overdue : isActive ? styles.statusOn : styles.statusDone}
        accessibilityRole="header"
      >
        {t.statusLabels[checkin.status] ?? checkin.status}
      </Text>

      {feedback ? (
        <View style={styles.feedback} accessibilityRole="alert">
          <Text style={styles.body}>{feedback}</Text>
        </View>
      ) : null}

      {isActive ? <Text style={styles.countdown}>{t.remaining(remaining)}</Text> : null}

      {isOverdue && isOwner ? <Text style={styles.body}>{t.ownerOverdue}</Text> : null}
      {isOverdue && !isOwner ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeTitle}>{t.overdueTitle}</Text>
          <Text style={styles.body}>{t.memberOverdue(checkin.user.name)}</Text>
          <Text style={styles.muted}>{t.memberOverdueNote}</Text>
          <Text style={styles.muted}>{t.memberOverdueGuidance}</Text>
        </View>
      ) : null}

      <View style={styles.rows}>
        <Row label={t.user} value={checkin.user.name} />
        <Row label={t.group} value={checkin.groupName} />
        <Row label={t.createdAt} value={formatTime(checkin.createdAt)} />
        <Row label={t.dueAt} value={formatTime(checkin.dueAt)} />
        {checkin.confirmedAt ? (
          <Row label={t.confirmedAt} value={formatTime(checkin.confirmedAt)} />
        ) : null}
        {checkin.cancelledAt ? (
          <Row label={t.cancelledAt} value={formatTime(checkin.cancelledAt)} />
        ) : null}
        {checkin.overdueAt ? (
          <Row label={t.overdueAt} value={formatTime(checkin.overdueAt)} />
        ) : null}
      </View>

      {isOwner && (isActive || isOverdue) ? (
        <View style={styles.actions}>
          <PrimaryButton
            label={t.imOk}
            onPress={() => void run(() => api.confirmCheckinSafe(checkin.id), t.safeFeedback)}
            loading={busy}
          />
          {isActive ? (
            confirmingCancel ? (
              <View style={styles.confirmBar}>
                <Text style={styles.body}>{t.confirmCancelMessage}</Text>
                <View style={styles.inlineActions}>
                  <Pressable
                    style={[styles.confirmButton, styles.confirmDanger]}
                    onPress={() =>
                      void run(() => api.cancelCheckin(checkin.id), t.cancelledFeedback)
                    }
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
            )
          ) : null}
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
