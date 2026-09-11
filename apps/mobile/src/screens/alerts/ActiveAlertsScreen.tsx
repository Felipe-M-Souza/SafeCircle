import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type EmergencyAlert } from "../../lib/api";
import { minutesSince } from "../../lib/time";
import { isAlertEvent, type RealtimeEvent } from "../../realtime/events";
import { useRealtime, useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

/**
 * Alertas ativos dos grupos do usuário (Phase 3/5).
 * A lista é atualizada ao abrir a tela, ao puxar para atualizar, ao voltar ao
 * primeiro plano, a cada evento realtime de alerta e a cada (re)conexão do
 * realtime — sempre recarregando pela API (fonte de verdade).
 */
export function ActiveAlertsScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const realtime = useRealtime();
  const t = strings.alerts;
  const [alerts, setAlerts] = useState<EmergencyAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAlerts(await api.listAlerts("ACTIVE"));
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
      setAlerts((previous) => previous ?? []);
    }
  }, [api, t.loadError]);

  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
      }
    });
    return () => subscription.remove();
  }, [load]);

  const onRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      if (isAlertEvent(event)) {
        void load();
      }
    },
    [load],
  );
  useRealtimeEvents(onRealtimeEvent, load);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen
      title={t.listTitle}
      onBack={() => nav.goBack()}
      onRefresh={() => void handleRefresh()}
      refreshing={refreshing}
    >
      {realtime?.state === "RECONNECTING" ? (
        <Text style={styles.hint}>{strings.realtime.reconnecting}</Text>
      ) : null}

      {alerts === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : alerts.length === 0 ? (
        <Text style={styles.empty}>{t.empty}</Text>
      ) : (
        alerts.map((alert) => (
          <View key={alert.id} style={styles.item}>
            <Text style={styles.name}>🚨 {alert.createdBy.name}</Text>
            <Text style={styles.meta}>{alert.groupName}</Text>
            <Text style={styles.meta}>{t.activatedAgo(minutesSince(alert.activatedAt))}</Text>
            <Pressable
              style={styles.button}
              onPress={() => nav.navigate({ name: "alertDetails", alertId: alert.id })}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>{t.viewAlert}</Text>
            </Pressable>
          </View>
        ))
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.hint}>{t.refreshHint}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 16,
    gap: 4,
  },
  name: { color: colors.primaryText, fontSize: 18, fontWeight: "700" },
  meta: { color: colors.mutedText, fontSize: 14 },
  button: {
    marginTop: 8,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: colors.primaryText, fontWeight: "700" },
  empty: { color: colors.mutedText, fontSize: 15, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 14 },
  hint: { color: colors.mutedText, fontSize: 12, lineHeight: 18 },
});
