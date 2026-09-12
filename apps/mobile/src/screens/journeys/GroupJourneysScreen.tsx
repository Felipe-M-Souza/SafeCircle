import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type SafeJourney } from "../../lib/api";
import { formatTime } from "../../lib/time";
import { isJourneyEvent, type RealtimeEvent } from "../../realtime/events";
import { useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

/** Trajetos recentes do grupo (Phase 8) — somente membros atuais. */
export function GroupJourneysScreen({
  nav,
  groupId,
  groupName,
}: {
  nav: Nav;
  groupId: string;
  groupName: string;
}): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.journeys;
  const [journeys, setJourneys] = useState<SafeJourney[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setJourneys(await api.listGroupJourneys(groupId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
      setJourneys((previous) => previous ?? []);
    }
  }, [api, groupId, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (isJourneyEvent(event) && event.data.groupId === groupId) void load();
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
      {journeys === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : journeys.length === 0 ? (
        <Text style={styles.empty}>{t.groupListEmpty}</Text>
      ) : (
        journeys.map((journey) => (
          <Pressable
            key={journey.id}
            style={[styles.item, journey.status === "OVERDUE" ? styles.itemOverdue : null]}
            onPress={() => nav.navigate({ name: "journeyDetails", journeyId: journey.id })}
            accessibilityRole="button"
          >
            <Text style={styles.name}>{journey.user.name}</Text>
            <Text style={journey.status === "OVERDUE" ? styles.overdue : styles.meta}>
              {t.statusLabels[journey.status] ?? journey.status}
            </Text>
            <Text style={styles.meta}>
              {journey.destinationLabel ? t.destination(journey.destinationLabel) : t.noDestination}
            </Text>
            <Text style={styles.meta}>
              {t.expectedArrival(formatTime(journey.expectedArrivalAt))}
            </Text>
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
