import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import { isRegistered } from "../notifications/device-registration";
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

  async function handleRetry() {
    setBusy(true);
    try {
      await notifications!.retryRegistration();
    } finally {
      setBusy(false);
    }
  }

  const { permission, registration } = notifications;

  if (permission === "granted") {
    // Enquanto a primeira tentativa não termina, não afirmamos nada.
    const pending = registration === null;

    if (!pending && !isRegistered(registration)) {
      const isApi = registration.status === "api";
      const detail = registration.status === "token" || isApi ? registration.detail : undefined;
      return (
        <View style={styles.card} accessibilityRole="alert">
          <Text style={styles.title}>{t.failedTitle}</Text>
          <Text style={styles.body}>{isApi ? t.failedApiBody : t.failedTokenBody}</Text>
          {detail ? (
            <Text style={styles.detail} selectable>
              {t.failedDetailLabel}: {detail}
            </Text>
          ) : null}
          <PrimaryButton label={t.tryAgain} onPress={() => void handleRetry()} loading={busy} />
        </View>
      );
    }

    return (
      <View style={styles.card} accessibilityRole="summary">
        <Text style={styles.title}>{t.title}</Text>
        <Text style={styles.body}>{t.description}</Text>
        <Text style={styles.status}>
          {t.statusLabel}:{" "}
          {pending ? (
            <Text style={styles.status}>…</Text>
          ) : (
            <Text style={styles.statusOn}>{t.statusEnabled}</Text>
          )}
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
  detail: { color: colors.mutedText, fontSize: 12, lineHeight: 17, fontStyle: "italic" },
  statusOn: { color: colors.accent, fontWeight: "700" },
  link: { color: colors.mutedText, fontSize: 14, fontWeight: "600", textAlign: "center" },
});
