import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { PrimaryButton } from "../components/PrimaryButton";
import { strings } from "../i18n/pt-BR";
import { colors } from "../theme/colors";

export function AuthenticatedHomeScreen(): React.JSX.Element {
  const { user, signOut, sessionPersistent } = useAuth();
  const t = strings.authenticatedHome;
  const [signingOut, setSigningOut] = useState(false);

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

        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{t.connected}</Text>
        </View>

        <Text style={styles.comingSoon}>{t.comingSoon}</Text>

        {!sessionPersistent ? (
          <Text style={styles.webNote}>
            Ambiente web de demonstração: a sessão não persiste após recarregar a página.
          </Text>
        ) : null}

        <PrimaryButton label={t.logout} onPress={handleSignOut} loading={signingOut} />

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
  brand: { color: colors.primaryText, fontSize: 28, fontWeight: "800" },
  greeting: { color: colors.primaryText, fontSize: 22, fontWeight: "700" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  statusText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  comingSoon: { color: colors.mutedText, fontSize: 15, lineHeight: 22 },
  webNote: { color: colors.mutedText, fontSize: 12, fontStyle: "italic" },
  disclaimer: { color: colors.mutedText, fontSize: 12, lineHeight: 18, marginTop: 8 },
});
