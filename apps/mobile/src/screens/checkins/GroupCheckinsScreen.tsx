import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type SafetyCheckin } from "../../lib/api";
import { formatTime } from "../../lib/time";
import { isCheckinEvent, type RealtimeEvent } from "../../realtime/events";
import { useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

/** Check-ins recentes do grupo (Phase 7) — somente membros atuais; sem histórico ilimitado. */
export function GroupCheckinsScreen({
  nav,
  groupId,
  groupName,
}: {
  nav: Nav;
  groupId: string;
  groupName: string;
}): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.checkins;
  const [checkins, setCheckins] = useState<SafetyCheckin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCheckins(await api.listGroupCheckins(groupId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
      setCheckins((previous) => previous ?? []);
    }
  }, [api, groupId, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (isCheckinEvent(event) && event.data.groupId === groupId) void load();
    },
    [groupId, load],
  );
  useRealtimeEvents(onEvent, load);

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
      title={t.groupListTitle(groupName)}
      onBack={() => nav.goBack()}
      onRefresh={() => void handleRefresh()}
      refreshing={refreshing}
    >
      {checkins === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : checkins.length === 0 ? (
        <Text style={styles.empty}>{t.groupListEmpty}</Text>
      ) : (
        checkins.map((checkin) => (
          <Pressable
            key={checkin.id}
            style={[styles.item, checkin.status === "OVERDUE" ? styles.itemOverdue : null]}
            onPress={() => nav.navigate({ name: "checkinDetails", checkinId: checkin.id })}
            accessibilityRole="button"
          >
            <Text style={styles.name}>{checkin.user.name}</Text>
            <Text style={checkin.status === "OVERDUE" ? styles.overdue : styles.meta}>
              {t.statusLabels[checkin.status] ?? checkin.status}
            </Text>
            <Text style={styles.meta}>{t.confirmBy(formatTime(checkin.dueAt))}</Text>
          </Pressable>
        ))
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 4,
  },
  itemOverdue: { borderColor: colors.danger },
  name: { color: colors.primaryText, fontSize: 17, fontWeight: "700" },
  meta: { color: colors.mutedText, fontSize: 14 },
  overdue: { color: colors.danger, fontSize: 14, fontWeight: "700" },
  empty: { color: colors.mutedText, fontSize: 15, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 14 },
});
