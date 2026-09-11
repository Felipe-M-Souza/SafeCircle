import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { strings } from "../i18n/pt-BR";

/**
 * Tela inicial da Phase 0.
 *
 * Escopo intencionalmente mínimo (README §26): apresenta apenas a identidade do
 * produto e a confirmação de que o ambiente está configurado. Sem autenticação,
 * grupos, SOS, push ou mapas — isso pertence às próximas fases.
 */
export function HomeScreen(): React.JSX.Element {
  const t = strings.home;

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{t.phaseLabel}</Text>
        </View>

        <Text style={styles.title}>{t.appName}</Text>
        <Text style={styles.tagline}>{t.tagline}</Text>

        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{t.environmentReady}</Text>
        </View>

        <Text style={styles.disclaimer}>{t.disclaimer}</Text>
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
  badge: {
    alignSelf: "flex-start",
    backgroundColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  badgeText: {
    color: colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  title: {
    color: colors.primaryText,
    fontSize: 40,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  tagline: {
    color: colors.mutedText,
    fontSize: 17,
    lineHeight: 24,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  statusText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  disclaimer: {
    color: colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
});
