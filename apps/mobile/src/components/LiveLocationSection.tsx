import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import type { EmergencyAlert } from "../lib/api";
import {
  isStale,
  secondsSince,
  useLiveLocationSharing,
  useLiveLocationView,
  useNow,
} from "../live-location/useLiveLocation";
import { colors } from "../theme/colors";
import { LiveLocationMap } from "./LiveLocationMap";
import { PrimaryButton } from "./PrimaryButton";

interface LiveLocationSectionProps {
  alert: EmergencyAlert;
  isCreator: boolean;
}

/**
 * Seção "Localização ao vivo" da tela do alerta (Phase 6).
 *
 * - Criador com alerta ACTIVE: opt-in explícito (CTA → consentimento →
 *   permissão), estado do compartilhamento, aviso de visibilidade e parada
 *   manual com confirmação. Permissão negada nunca afeta o alerta.
 * - Todos os membros: estado atual via REST (nunca via evento), mapa com a
 *   posição mais recente, precisão honesta e indicação de desatualização.
 */
export function LiveLocationSection({
  alert,
  isCreator,
}: LiveLocationSectionProps): React.JSX.Element {
  const t = strings.liveLocation;
  const isActiveAlert = alert.status === "ACTIVE";
  const view = useLiveLocationView(alert.id, true);
  const sharing = useLiveLocationSharing(alert.id, isCreator);
  const now = useNow();
  const [consenting, setConsenting] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [busy, setBusy] = useState(false);

  const snapshot = sharing.snapshot;
  const sharingState = snapshot?.state ?? "INACTIVE";
  const isSharing = sharingState === "ACTIVE" || sharingState === "DEGRADED";

  async function handleStart() {
    setBusy(true);
    setConsenting(false);
    try {
      await sharing.start();
      await view.reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setConfirmingStop(false);
    try {
      await sharing.stop({ notifyBackend: true });
      await view.reload();
    } finally {
      setBusy(false);
    }
  }

  const latest = view.state?.latest ?? null;
  const stale = latest ? isStale(latest.receivedAt, now) : false;
  const serverStatus = view.state?.status ?? "INACTIVE";

  function statusLabel(): string {
    if (serverStatus === "ACTIVE") return stale ? t.statusStale : t.statusActive;
    if (serverStatus === "STOPPED") return t.statusStopped;
    return t.statusInactive;
  }

  return (
    <View style={styles.card} testID="live-location-section">
      <Text style={styles.title}>{t.title}</Text>

      {/* Criador: controle do compartilhamento */}
      {isCreator && isActiveAlert ? (
        isSharing || sharingState === "STARTING" ? (
          <View style={styles.block}>
            <Text style={styles.statusOn}>
              {sharingState === "STARTING" ? t.starting : t.statusActive}
            </Text>
            {sharingState === "DEGRADED" ? <Text style={styles.muted}>{t.degraded}</Text> : null}
            <Text style={styles.body}>{t.creatorNote}</Text>
            {snapshot?.lastSentAt ? (
              <Text style={styles.muted}>
                {t.lastUpdate(Math.max(0, Math.round((now - snapshot.lastSentAt) / 1000)))}
              </Text>
            ) : null}
            <Text style={styles.note}>{t.sharingScopeNote}</Text>
            {confirmingStop ? (
              <View style={styles.confirmBar}>
                <Text style={styles.body}>{t.confirmStopMessage}</Text>
                <View style={styles.inlineActions}>
                  <Pressable
                    style={[styles.confirmButton, styles.confirmDanger]}
                    onPress={() => void handleStop()}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.confirmDangerText}>{t.confirmStop}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.confirmButton}
                    onPress={() => setConfirmingStop(false)}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.secondaryText}>{t.keepSharing}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={[styles.stopButton, busy ? styles.disabled : null]}
                onPress={() => setConfirmingStop(true)}
                disabled={busy || sharingState === "STARTING"}
                accessibilityRole="button"
              >
                <Text style={styles.stopText}>{t.stop}</Text>
              </Pressable>
            )}
          </View>
        ) : consenting ? (
          <View style={styles.block}>
            <Text style={styles.subtitle}>{t.consentTitle}</Text>
            <Text style={styles.body}>{t.consentBody}</Text>
            <PrimaryButton
              label={t.consentConfirm}
              onPress={() => void handleStart()}
              loading={busy}
            />
            <Pressable
              onPress={() => setConsenting(false)}
              accessibilityRole="button"
              disabled={busy}
            >
              <Text style={styles.link}>{t.consentCancel}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.block}>
            {sharingState === "STOPPED" ? (
              <Text style={styles.muted}>{t.statusStopped}</Text>
            ) : null}
            <Text style={styles.body}>{t.description}</Text>
            <PrimaryButton label={t.enable} onPress={() => setConsenting(true)} loading={busy} />
            {snapshot?.error ? (
              <>
                <Text style={styles.error}>{snapshot.error}</Text>
                {snapshot.permission === "blocked" ||
                snapshot.permission === "services-disabled" ? (
                  <Pressable onPress={() => void Linking.openSettings()} accessibilityRole="button">
                    <Text style={styles.link}>{t.openSettings}</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>
        )
      ) : null}

      {/* Todos: visualização (mapa + estado) */}
      {serverStatus === "INACTIVE" ? (
        isCreator ? null : (
          <Text style={styles.muted}>{t.notSharing}</Text>
        )
      ) : (
        <View style={styles.block}>
          {!(isCreator && isActiveAlert) ? (
            <Text style={serverStatus === "ACTIVE" && !stale ? styles.statusOn : styles.muted}>
              {statusLabel()}
            </Text>
          ) : null}
          <LiveLocationMap latest={latest} trail={view.history?.points ?? []} stale={stale} />
          {latest ? (
            <>
              <Text style={stale ? styles.staleText : styles.muted}>
                {t.lastUpdate(secondsSince(latest.receivedAt, now))}
              </Text>
              {latest.accuracy !== null ? (
                <Text style={styles.muted}>{t.accuracy(latest.accuracy)}</Text>
              ) : null}
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 12,
  },
  block: { gap: 10 },
  title: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  subtitle: { color: colors.primaryText, fontSize: 15, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  note: { color: colors.mutedText, fontSize: 12, lineHeight: 18, fontStyle: "italic" },
  statusOn: { color: colors.accent, fontSize: 15, fontWeight: "800" },
  staleText: { color: colors.danger, fontSize: 14, fontWeight: "700" },
  link: { color: colors.primary, fontWeight: "700", textAlign: "center" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  stopButton: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  stopText: { color: colors.danger, fontSize: 15, fontWeight: "800" },
  disabled: { opacity: 0.6 },
  confirmBar: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 12,
    gap: 10,
  },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  confirmButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  confirmDangerText: { color: "#450a0a", fontWeight: "800" },
  secondaryText: { color: colors.primaryText, fontWeight: "600" },
});
