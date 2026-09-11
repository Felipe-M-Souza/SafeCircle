import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import {
  ApiError,
  type AcknowledgementType,
  type AlertAcknowledgement,
  type EmergencyAlert,
} from "../../lib/api";
import { formatTime } from "../../lib/time";
import type { RealtimeEvent } from "../../realtime/events";
import { useRealtimeEvents } from "../../realtime/RealtimeProvider";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

interface AlertDetailsScreenProps {
  nav: Nav;
  alertId: string;
  /** Verdadeiro logo após o acionamento bem-sucedido (mostra a confirmação). */
  justActivated?: boolean;
}

const MEMBER_ACTIONS: Array<{ type: AcknowledgementType; label: string }> = [
  { type: "SEEN", label: strings.acknowledgements.seen },
  { type: "GOING_TO_HELP", label: strings.acknowledgements.goingToHelp },
  { type: "EMERGENCY_SERVICES_CONTACTED", label: strings.acknowledgements.emergencyContacted },
];

/**
 * Detalhes do alerta / alerta ativo (Phase 3/5).
 *
 * - Não exibe latitude/longitude cruas nem mapa: apenas "Disponível"/"Não disponível".
 * - Criador: "Estou em segurança" / "Cancelar alerta" (Phase 3) e as respostas
 *   do grupo. Membros: respostas (VI O ALERTA / ESTOU INDO AJUDAR / ACIONEI
 *   EMERGÊNCIA) enquanto o alerta está ativo; ao abrir a tela um `SEEN` é
 *   enviado uma única vez (o backend nunca rebaixa um estado mais forte).
 * - Eventos realtime deste alerta e cada (re)conexão recarregam tudo pela API.
 */
export function AlertDetailsScreen({
  nav,
  alertId,
  justActivated = false,
}: AlertDetailsScreenProps): React.JSX.Element {
  const { api, user } = useAuth();
  const t = strings.alertDetails;
  const ta = strings.acknowledgements;

  const [alert, setAlert] = useState<EmergencyAlert | null>(null);
  const [acknowledgements, setAcknowledgements] = useState<AlertAcknowledgement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState<AcknowledgementType | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const autoSeenSentRef = useRef(false);

  const loadAcknowledgements = useCallback(async () => {
    try {
      setAcknowledgements(await api.listAcknowledgements(alertId));
    } catch {
      // A lista de respostas é complementar: falha não esconde o alerta.
    }
  }, [api, alertId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [alertResult] = await Promise.all([api.getAlert(alertId), loadAcknowledgements()]);
      setAlert(alertResult);
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : t.loadError);
    }
  }, [api, alertId, loadAcknowledgements, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: eventos deste alerta e ressincronização recarregam pela API.
  const onRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.data.alertId === alertId) {
        void load();
      }
    },
    [alertId, load],
  );
  useRealtimeEvents(onRealtimeEvent, load);

  const isCreator = alert ? alert.createdBy.id === user?.id : false;
  const isActive = alert?.status === "ACTIVE";

  // Auto-SEEN: uma única chamada explícita ao abrir como membro (não criador).
  useEffect(() => {
    if (!alert || isCreator || !isActive || autoSeenSentRef.current) return;
    autoSeenSentRef.current = true;
    api
      .setAcknowledgement(alertId, "SEEN")
      .then(() => loadAcknowledgements())
      .catch(() => {
        // Silencioso: o usuário pode responder explicitamente pelos botões.
      });
  }, [alert, isCreator, isActive, api, alertId, loadAcknowledgements]);

  async function transition(action: () => Promise<EmergencyAlert>, message: string) {
    setBusy(true);
    setError(null);
    try {
      // O estado devolvido pelo backend é a fonte de verdade.
      setAlert(await action());
      setFeedback(message);
    } catch (e) {
      // Estado pode ter mudado (ex.: já encerrado): ressincroniza e só então
      // exibe o erro, para que a mensagem não seja apagada pela recarga.
      await load();
      setError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  async function respond(type: AcknowledgementType) {
    setAckBusy(type);
    setAckError(null);
    try {
      await api.setAcknowledgement(alertId, type);
      await loadAcknowledgements();
    } catch (e) {
      setAckError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
      await load();
    } finally {
      setAckBusy(null);
    }
  }

  if (!alert) {
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

  const title =
    alert.status === "ACTIVE"
      ? t.titleActive
      : alert.status === "RESOLVED"
        ? t.titleResolved
        : t.titleCancelled;
  const myAcknowledgement = acknowledgements.find((item) => item.user.id === user?.id) ?? null;

  return (
    <Screen title={title} onBack={() => nav.goBack()}>
      {justActivated && isActive && !feedback ? (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerTitle}>{t.activatedTitle}</Text>
          <Text style={styles.bannerText}>{t.activatedMessage(alert.groupName)}</Text>
          <Text style={styles.bannerNote}>{t.activatedNote}</Text>
        </View>
      ) : null}

      {feedback ? (
        <View style={styles.feedback} accessibilityRole="alert">
          <Text style={styles.feedbackText}>{feedback}</Text>
        </View>
      ) : null}

      <View style={styles.rows}>
        <Row label={t.group} value={alert.groupName} />
        <Row label={t.triggeredBy} value={alert.createdBy.name} />
        <Row label={t.time} value={formatTime(alert.activatedAt)} />
        <Row label={t.status} value={strings.alertStatus[alert.status] ?? alert.status} />
        <Row
          label={t.location}
          value={alert.location ? t.locationAvailable : t.locationUnavailable}
          note={
            alert.location && alert.location.accuracy !== null
              ? t.locationAccuracy(alert.location.accuracy)
              : undefined
          }
        />
        {alert.resolvedAt ? (
          <Row label={t.resolvedAt} value={formatTime(alert.resolvedAt)} />
        ) : null}
        {alert.cancelledAt ? (
          <Row label={t.cancelledAt} value={formatTime(alert.cancelledAt)} />
        ) : null}
      </View>

      {isCreator && isActive ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.safeButton, busy ? styles.disabled : null]}
            onPress={() => void transition(() => api.resolveAlert(alert.id), t.resolvedMessage)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.safeButtonText}>{t.imSafe}</Text>
          </Pressable>

          {confirmingCancel ? (
            <View style={styles.confirmBar}>
              <Text style={styles.confirmText}>{t.confirmCancelMessage}</Text>
              <View style={styles.inlineActions}>
                <Pressable
                  style={[styles.confirmButton, styles.confirmDanger]}
                  onPress={() =>
                    void transition(() => api.cancelAlert(alert.id), t.cancelledMessage)
                  }
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.confirmDangerText}>{t.confirmCancel}</Text>
                </Pressable>
                <Pressable
                  style={styles.confirmButton}
                  onPress={() => setConfirmingCancel(false)}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryText}>{t.keepAlert}</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={[styles.cancelButton, busy ? styles.disabled : null]}
              onPress={() => setConfirmingCancel(true)}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.cancelButtonText}>{t.cancelAlert}</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {!isCreator ? (
        <View style={styles.actions}>
          <Text style={styles.sectionTitle}>{ta.yourResponse}</Text>
          {MEMBER_ACTIONS.map((action) => {
            const selected = myAcknowledgement?.type === action.type;
            const disabled = !isActive || ackBusy !== null;
            return (
              <Pressable
                key={action.type}
                style={[
                  styles.responseButton,
                  selected ? styles.responseButtonSelected : null,
                  disabled ? styles.disabled : null,
                ]}
                onPress={() => void respond(action.type)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled, selected }}
              >
                <Text style={[styles.responseText, selected ? styles.responseTextSelected : null]}>
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
          {!isActive ? <Text style={styles.muted}>{ta.closedNote}</Text> : null}
          <Text style={styles.safetyNote}>{ta.safetyNote}</Text>
          {ackError ? <Text style={styles.error}>{ackError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.rows}>
        <Text style={styles.sectionTitle}>{ta.sectionTitle}</Text>
        {acknowledgements.length === 0 ? (
          <Text style={styles.muted}>{ta.empty}</Text>
        ) : (
          acknowledgements.map((item) => (
            <View key={item.user.id} style={styles.row}>
              <Text style={styles.rowValue}>{item.user.name}</Text>
              <Text style={styles.rowLabel}>{ta.types[item.type] ?? item.type}</Text>
            </View>
          ))
        )}
      </View>

      {busy ? <ActivityIndicator color={colors.primary} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!isActive ? (
        <PrimaryButton label={strings.groups.back} onPress={() => nav.goBack()} />
      ) : null}
    </Screen>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
      {note ? <Text style={styles.rowNote}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  bannerTitle: { color: colors.primaryText, fontSize: 18, fontWeight: "800" },
  bannerText: { color: colors.primaryText, fontSize: 15 },
  bannerNote: { color: colors.mutedText, fontSize: 13, lineHeight: 18 },
  feedback: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  feedbackText: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  rows: { gap: 12 },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 2,
  },
  rowLabel: { color: colors.mutedText, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.primaryText, fontSize: 17, fontWeight: "700" },
  rowNote: { color: colors.mutedText, fontSize: 12 },
  sectionTitle: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  actions: { gap: 12, marginTop: 8 },
  safeButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  safeButtonText: { color: "#052e16", fontSize: 16, fontWeight: "800" },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelButtonText: { color: colors.danger, fontSize: 15, fontWeight: "800" },
  responseButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  responseButtonSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  responseText: { color: colors.primaryText, fontSize: 15, fontWeight: "800" },
  responseTextSelected: { color: colors.primaryText },
  muted: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  safetyNote: { color: colors.mutedText, fontSize: 12, lineHeight: 18, fontStyle: "italic" },
  disabled: { opacity: 0.6 },
  confirmBar: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 16,
    gap: 12,
  },
  confirmText: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  confirmButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  confirmDangerText: { color: "#450a0a", fontWeight: "800" },
  secondaryText: { color: colors.primaryText, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 14 },
});
