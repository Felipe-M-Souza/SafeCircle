import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { PrimaryButton } from "../components/PrimaryButton";
import { strings } from "../i18n/pt-BR";
import { colors } from "../theme/colors";
import type { Nav } from "../navigation/types";

export function AuthenticatedHomeScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { user, signOut, sessionPersistent, api } = useAuth();
  const t = strings.authenticatedHome;
  const [signingOut, setSigningOut] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  const loadPending = useCallback(async () => {
    try {
      const invitations = await api.listMyInvitations();
      setPendingCount(invitations.length);
    } catch {
      setPendingCount(null);
    }
  }, [api]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.brand}>{strings.common.appName}</Text>
        <Text style={styles.greeting}>{t.greeting(user?.name ?? "")}</Text>
        <Text style={styles.subtitle}>{t.subtitle}</Text>

        <PrimaryButton label={t.myGroups} onPress={() => nav.navigate({ name: "groups" })} />

        <Pressable
          style={styles.invitesRow}
          onPress={() => nav.navigate({ name: "invitations" })}
          accessibilityRole="button"
        >
          <Text style={styles.invitesText}>{t.receivedInvitations}</Text>
          {pendingCount && pendingCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{pendingCount}</Text>
            </View>
          ) : null}
        </Pressable>

        {!sessionPersistent ? (
          <Text style={styles.webNote}>
            Ambiente web de demonstração: a sessão não persiste após recarregar a página.
          </Text>
        ) : null}

        <Pressable onPress={handleSignOut} disabled={signingOut} accessibilityRole="button">
          <Text style={styles.logout}>{signingOut ? "..." : t.logout}</Text>
        </Pressable>

        <Text style={styles.disclaimer}>{strings.home.disclaimer}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 28,
    gap: 14,
  },
  brand: { color: colors.primaryText, fontSize: 26, fontWeight: "800" },
  greeting: { color: colors.primaryText, fontSize: 22, fontWeight: "700" },
  subtitle: { color: colors.mutedText, fontSize: 16, marginBottom: 4 },
  invitesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  invitesText: { color: colors.primaryText, fontSize: 16, fontWeight: "600" },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    minWidth: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  badgeText: { color: "#052e16", fontSize: 13, fontWeight: "800" },
  webNote: { color: colors.mutedText, fontSize: 12, fontStyle: "italic" },
  logout: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 6,
  },
  disclaimer: { color: colors.mutedText, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
