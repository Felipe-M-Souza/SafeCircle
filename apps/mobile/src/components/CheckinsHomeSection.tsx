import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { strings, translateApiError } from "../i18n/pt-BR";
import { type SafetyCheckin } from "../lib/api";
import { formatTime, secondsUntil } from "../lib/time";
import { useNow } from "../live-location/useLiveLocation";
import { isCheckinEvent, type RealtimeEvent } from "../realtime/events";
import { useRealtimeEvents } from "../realtime/RealtimeProvider";
import { colors } from "../theme/colors";
import type { Nav } from "../navigation/types";
import { PrimaryButton } from "./PrimaryButton";

/**
 * Seção "Check-in de segurança" da Home (Phase 7).
 *
 * O contador é apenas visual: quando chega a zero o app consulta o backend e
 * aguarda o estado autoritativo — nunca marca OVERDUE por conta própria.
 * Recarrega a cada evento realtime de check-in, a cada (re)conexão e ao
 * voltar ao primeiro plano.
 */
export function CheckinsHomeSection({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.checkins;
  const now = useNow(1000);
  const [checkins, setCheckins] = useState<SafetyCheckin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const zeroReloadedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [active, overdue] = await Promise.all([
        api.listMyCheckins("ACTIVE"),
        api.listMyCheckins("OVERDUE"),
      ]);
      setCheckins([...active, ...overdue]);
      setError(null);
    } catch (e) {
      setError(translateApiError(e, t.loadError));
      setCheckins((previous) => previous ?? []);
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
      if (isCheckinEvent(event)) void load();
    },
    [load],
  );
  useRealtimeEvents(onEvent, load);

  const current = checkins?.[0] ?? null;
  const remaining = current ? secondsUntil(current.dueAt, now) : 0;

  // Contador zerou: consulta o backend uma vez por check-in (sem mudar status local).
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
      // Recarrega primeiro: o estado autoritativo vem do servidor; a mensagem fica visível.
      await load();
      setError(translateApiError(e, strings.common.genericError));
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  return (
    <View style={styles.card} testID="checkins-home-section">
      <Text style={styles.title}>{t.sectionTitle}</Text>

      {current ? (
        <View style={styles.block}>
          <Text style={current.status === "OVERDUE" ? styles.overdue : styles.statusOn}>
            {current.status === "OVERDUE" ? t.overdueTitle : t.activeTitle}
          </Text>
          <Text style={styles.body}>{current.groupName}</Text>
          {current.status === "ACTIVE" ? (
            <>
              <Text style={styles.body}>{t.confirmBy(formatTime(current.dueAt))}</Text>
              <Text style={styles.muted}>{t.remaining(remaining)}</Text>
            </>
          ) : (
            <Text style={styles.muted}>{t.ownerOverdue}</Text>
          )}

          <PrimaryButton
            label={t.imOk}
            onPress={() => void run(() => api.confirmCheckinSafe(current.id))}
            loading={busy}
          />
          {current.status === "ACTIVE" ? (
            confirmingCancel ? (
              <View style={styles.inlineActions}>
                <Pressable
                  style={[styles.confirmButton, styles.confirmDanger]}
                  onPress={() => void run(() => api.cancelCheckin(current.id))}
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
            )
          ) : null}
          <Pressable
            onPress={() => nav.navigate({ name: "checkinDetails", checkinId: current.id })}
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
            onPress={() => nav.navigate({ name: "newCheckin" })}
            disabled={checkins === null}
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
