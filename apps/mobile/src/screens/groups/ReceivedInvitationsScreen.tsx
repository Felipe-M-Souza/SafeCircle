import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { Screen } from "../../components/Screen";
import { strings, translateApiError } from "../../i18n/pt-BR";
import { type MyInvitation } from "../../lib/api";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

export function ReceivedInvitationsScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.invitations;
  const [invitations, setInvitations] = useState<MyInvitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvitations(await api.listMyInvitations());
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
      setInvitations([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(invitation: MyInvitation) {
    setBusyId(invitation.id);
    setError(null);
    try {
      const { groupId } = await api.acceptInvitation(invitation.id);
      nav.navigate({ name: "groupDetails", groupId });
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function reject(invitation: MyInvitation) {
    setBusyId(invitation.id);
    setError(null);
    try {
      await api.rejectInvitation(invitation.id);
      await load();
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen title={t.title} onBack={() => nav.goBack()}>
      {invitations === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : invitations.length === 0 ? (
        <Text style={styles.empty}>{t.empty}</Text>
      ) : (
        invitations.map((invitation) => (
          <View key={invitation.id} style={styles.item}>
            <Text style={styles.name}>{invitation.group.name}</Text>
            <Text style={styles.meta}>{t.invitedBy(invitation.invitedBy.name)}</Text>
            <View style={styles.actions}>
              <Pressable
                style={[styles.button, styles.accept]}
                onPress={() => accept(invitation)}
                disabled={busyId === invitation.id}
                accessibilityRole="button"
              >
                <Text style={styles.acceptText}>{t.accept}</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.reject]}
                onPress={() => reject(invitation)}
                disabled={busyId === invitation.id}
                accessibilityRole="button"
              >
                <Text style={styles.rejectText}>{t.reject}</Text>
              </Pressable>
            </View>
          </View>
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
    gap: 8,
  },
  name: { color: colors.primaryText, fontSize: 18, fontWeight: "700" },
  meta: { color: colors.mutedText, fontSize: 14 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  button: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  accept: { backgroundColor: colors.accent },
  acceptText: { color: "#052e16", fontWeight: "800" },
  reject: { borderWidth: 1, borderColor: colors.border },
  rejectText: { color: colors.primaryText, fontWeight: "700" },
  empty: { color: colors.mutedText, fontSize: 15 },
  error: { color: colors.danger, fontSize: 14 },
});
