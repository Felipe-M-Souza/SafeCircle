import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { strings, translateApiError } from "../../i18n/pt-BR";
import { type GroupInvitation, type GroupMember, type GroupSummary } from "../../lib/api";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

interface Confirm {
  message: string;
  run: () => Promise<void>;
}

export function GroupDetailsScreen({
  nav,
  groupId,
}: {
  nav: Nav;
  groupId: string;
}): React.JSX.Element {
  const { api, user } = useAuth();
  const t = strings.groupDetails;

  const [group, setGroup] = useState<GroupSummary | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [pending, setPending] = useState<GroupInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  const canManage = group?.role === "OWNER" || group?.role === "ADMIN";
  const isOwner = group?.role === "OWNER";

  const load = useCallback(async () => {
    setError(null);
    try {
      const [g, m] = await Promise.all([api.getGroup(groupId), api.listMembers(groupId)]);
      setGroup(g);
      setMembers(m);
      setNewName(g.name);
      if (g.role === "OWNER" || g.role === "ADMIN") {
        setPending(await api.listGroupInvitations(groupId));
      } else {
        setPending([]);
      }
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
    }
  }, [api, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function handleRename() {
    if (!newName.trim()) return;
    await runAction(async () => {
      await api.updateGroup(groupId, newName.trim());
      setRenaming(false);
    });
  }

  if (!group) {
    return (
      <Screen title="" onBack={() => nav.goBack()}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </Screen>
    );
  }

  return (
    <Screen title={group.name} onBack={() => nav.goBack()}>
      <Text style={styles.subtitle}>
        {t.membersTitle(group.memberCount)} · {strings.roles[group.role]}
      </Text>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => nav.navigate({ name: "groupCheckins", groupId, groupName: group.name })}
        accessibilityRole="button"
      >
        <Text style={styles.secondaryText}>{strings.checkins.viewGroupCheckins}</Text>
      </Pressable>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => nav.navigate({ name: "groupJourneys", groupId, groupName: group.name })}
        accessibilityRole="button"
      >
        <Text style={styles.secondaryText}>{strings.journeys.viewGroupJourneys}</Text>
      </Pressable>

      {canManage ? (
        renaming ? (
          <View style={styles.renameRow}>
            <TextField
              label={t.rename}
              value={newName}
              onChangeText={setNewName}
              editable={!busy}
            />
            <View style={styles.inlineActions}>
              <PrimaryButton label={t.confirm} onPress={handleRename} loading={busy} />
              <Pressable onPress={() => setRenaming(false)}>
                <Text style={styles.link}>{t.cancel}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => nav.navigate({ name: "invite", groupId, groupName: group.name })}
            >
              <Text style={styles.secondaryText}>{t.invite}</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => setRenaming(true)}>
              <Text style={styles.secondaryText}>{t.rename}</Text>
            </Pressable>
          </View>
        )
      ) : null}

      <Text style={styles.sectionTitle}>{t.membersTitle(group.memberCount)}</Text>
      {members.map((member) => {
        const isSelf = member.id === user?.id;
        const showManage = canManage && !isSelf && member.role !== "OWNER";
        const canManageThis = isOwner || (group.role === "ADMIN" && member.role === "MEMBER");
        return (
          <View key={member.id} style={styles.memberItem}>
            <View style={styles.memberInfo}>
              <Text style={styles.memberName}>{member.name}</Text>
              <Text style={styles.memberRole}>{strings.roles[member.role]}</Text>
            </View>
            {showManage && canManageThis ? (
              <View style={styles.memberActions}>
                {isOwner && member.role === "MEMBER" ? (
                  <Pressable
                    onPress={() =>
                      runAction(async () => {
                        await api.changeMemberRole(groupId, member.id, "ADMIN");
                      })
                    }
                    disabled={busy}
                  >
                    <Text style={styles.linkSmall}>{t.promote}</Text>
                  </Pressable>
                ) : null}
                {isOwner && member.role === "ADMIN" ? (
                  <Pressable
                    onPress={() =>
                      runAction(async () => {
                        await api.changeMemberRole(groupId, member.id, "MEMBER");
                      })
                    }
                    disabled={busy}
                  >
                    <Text style={styles.linkSmall}>{t.demote}</Text>
                  </Pressable>
                ) : null}
                {isOwner ? (
                  <Pressable
                    onPress={() =>
                      setConfirm({
                        message: t.confirmTransferMessage(member.name),
                        run: () => api.transferOwnership(groupId, member.id),
                      })
                    }
                    disabled={busy}
                    testID={`group-transfer-${member.id}`}
                  >
                    <Text style={styles.linkSmall}>{t.transferOwnership}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() =>
                    setConfirm({
                      message: t.confirmRemoveMessage(member.name),
                      run: () => api.removeMember(groupId, member.id),
                    })
                  }
                  disabled={busy}
                >
                  <Text style={styles.dangerSmall}>{t.remove}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}

      {canManage && pending.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>{t.viewInvitations}</Text>
          {pending.map((invitation) => (
            <View key={invitation.id} style={styles.memberItem}>
              <Text style={styles.memberName}>{invitation.invitedEmail}</Text>
              <Pressable
                onPress={() =>
                  setConfirm({
                    message: `Revogar convite de ${invitation.invitedEmail}?`,
                    run: () => api.revokeInvitation(groupId, invitation.id),
                  })
                }
                disabled={busy}
              >
                <Text style={styles.dangerSmall}>{t.remove}</Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : null}

      {group.role !== "OWNER" ? (
        <Pressable
          onPress={() =>
            setConfirm({
              message: t.confirmLeaveMessage,
              run: async () => {
                await api.leaveGroup(groupId);
                nav.goBack();
              },
            })
          }
          disabled={busy}
        >
          <Text style={styles.leave}>{t.leave}</Text>
        </Pressable>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {confirm ? (
        <View style={styles.confirmBar}>
          <Text style={styles.confirmText}>{confirm.message}</Text>
          <View style={styles.inlineActions}>
            <Pressable
              style={[styles.confirmButton, styles.confirmDanger]}
              onPress={() => runAction(confirm.run)}
              disabled={busy}
            >
              <Text style={styles.confirmDangerText}>{t.confirm}</Text>
            </Pressable>
            <Pressable
              style={styles.confirmButton}
              onPress={() => setConfirm(null)}
              disabled={busy}
            >
              <Text style={styles.secondaryText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.mutedText, fontSize: 15 },
  sectionTitle: { color: colors.primaryText, fontSize: 16, fontWeight: "700", marginTop: 8 },
  actionsRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryText: { color: colors.primaryText, fontWeight: "600" },
  renameRow: { gap: 10 },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  link: { color: colors.primary, fontWeight: "700" },
  linkSmall: { color: colors.primary, fontWeight: "600", fontSize: 13 },
  dangerSmall: { color: colors.danger, fontWeight: "600", fontSize: 13 },
  memberItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  memberInfo: { gap: 2 },
  memberName: { color: colors.primaryText, fontSize: 16, fontWeight: "600" },
  memberRole: { color: colors.mutedText, fontSize: 13 },
  memberActions: { flexDirection: "row", gap: 14, alignItems: "center" },
  leave: { color: colors.danger, fontWeight: "700", textAlign: "center", paddingVertical: 12 },
  error: { color: colors.danger, fontSize: 14 },
  confirmBar: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 16,
    gap: 12,
  },
  confirmText: { color: colors.primaryText, fontSize: 15 },
  confirmButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  confirmDangerText: { color: "#450a0a", fontWeight: "800" },
});
