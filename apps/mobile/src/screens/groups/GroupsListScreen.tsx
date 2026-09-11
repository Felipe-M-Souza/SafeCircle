import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError, type GroupSummary } from "../../lib/api";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

export function GroupsListScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.groups;
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setGroups(await api.listGroups());
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
      setGroups([]);
    }
  }, [api, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen title={t.listTitle} onBack={() => nav.goBack()}>
      {groups === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : groups.length === 0 ? (
        <Text style={styles.empty}>{t.empty}</Text>
      ) : (
        groups.map((group) => (
          <Pressable
            key={group.id}
            style={styles.item}
            onPress={() => nav.navigate({ name: "groupDetails", groupId: group.id })}
            accessibilityRole="button"
          >
            <Text style={styles.name}>{group.name}</Text>
            <Text style={styles.meta}>{t.memberCount(group.memberCount)}</Text>
            <Text style={styles.role}>{t.youAre(group.role)}</Text>
          </Pressable>
        ))
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <PrimaryButton label={t.createCta} onPress={() => nav.navigate({ name: "createGroup" })} />
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
  name: { color: colors.primaryText, fontSize: 18, fontWeight: "700" },
  meta: { color: colors.mutedText, fontSize: 14 },
  role: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.mutedText, fontSize: 15, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 14 },
});
