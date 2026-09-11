import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import { useNotifications } from "../notifications/NotificationsProvider";
import { colors } from "../theme/colors";
import { PrimaryButton } from "./PrimaryButton";

/**
 * Seção simples de notificações na Home (Phase 4).
 *
 * - Indeterminada: explica o motivo antes de pedir a permissão do SO.
 * - Negada: estado informativo com "Tentar novamente" (se o SO permitir).
 * - Bloqueada: orienta a abrir as configurações do aparelho.
 * - Concedida: mostra o status. Sem preferências granulares nesta fase.
 */
export function NotificationsCard(): React.JSX.Element | null {
  const notifications = useNotifications();
  const t = strings.notifications;
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!notifications || !notifications.supported || notifications.permission === "loading") {
    return null;
  }

  async function handleEnable() {
    setBusy(true);
    try {
      await notifications!.enable();
    } finally {
      setBusy(false);
    }
  }

  const { permission } = notifications;

  if (permission === "granted") {
    return (
      <View style={styles.card} accessibilityRole="summary">
        <Text style={styles.title}>{t.title}</Text>
        <Text style={styles.body}>{t.description}</Text>
        <Text style={styles.status}>
          {t.statusLabel}: <Text style={styles.statusOn}>{t.statusEnabled}</Text>
        </Text>
      </View>
    );
  }

  if (permission === "undetermined") {
    if (dismissed) {
      return null;
    }
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{t.promptTitle}</Text>
        <Text style={styles.body}>{t.promptBody}</Text>
        <PrimaryButton label={t.enable} onPress={() => void handleEnable()} loading={busy} />
        <Pressable onPress={() => setDismissed(true)} accessibilityRole="button" disabled={busy}>
          <Text style={styles.link}>{t.notNow}</Text>
        </Pressable>
      </View>
    );
  }

  if (permission === "blocked") {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{t.deniedTitle}</Text>
        <Text style={styles.body}>{t.blockedBody}</Text>
        <PrimaryButton label={t.openSettings} onPress={() => void Linking.openSettings()} />
      </View>
    );
  }

  if (permission === "denied") {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{t.deniedTitle}</Text>
        <Text style={styles.body}>{t.deniedBody}</Text>
        <PrimaryButton label={t.tryAgain} onPress={() => void handleEnable()} loading={busy} />
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.body}>{t.unavailable}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  body: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  status: { color: colors.mutedText, fontSize: 14 },
  statusOn: { color: colors.accent, fontWeight: "700" },
  link: { color: colors.mutedText, fontSize: 14, fontWeight: "600", textAlign: "center" },
});
