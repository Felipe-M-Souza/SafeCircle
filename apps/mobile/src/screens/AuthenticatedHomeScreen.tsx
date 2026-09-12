import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { CheckinsHomeSection } from "../components/CheckinsHomeSection";
import { HoldToActivateButton } from "../components/HoldToActivateButton";
import { NotificationsCard } from "../components/NotificationsCard";
import { PrimaryButton } from "../components/PrimaryButton";
import { strings, translateErrorCode } from "../i18n/pt-BR";
import { ApiError, type EmergencyAlert, type GroupSummary } from "../lib/api";
import { generateIdempotencyKey } from "../lib/idempotency";
import { captureInitialLocation } from "../lib/location";
import { isAlertEvent, type RealtimeEvent } from "../realtime/events";
import { useRealtimeEvents } from "../realtime/RealtimeProvider";
import { colors } from "../theme/colors";
import type { Nav } from "../navigation/types";

type ActivationPhase = "idle" | "locating" | "sending";

/**
 * Home autenticada (Phase 3): seleção do grupo de confiança e botão SOS com
 * pressionar-e-segurar. O backend é a fonte de verdade: após qualquer ação a
 * tela refaz a consulta.
 */
export function AuthenticatedHomeScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { user, signOut, sessionPersistent, api } = useAuth();
  const t = strings.authenticatedHome;
  const sos = strings.sos;

  const [signingOut, setSigningOut] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [myActiveAlerts, setMyActiveAlerts] = useState<EmergencyAlert[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phase, setPhase] = useState<ActivationPhase>("idle");
  const [activationError, setActivationError] = useState<string | null>(null);
  // Bloqueia acionamentos concorrentes da mesma interação/tela.
  const activatingRef = useRef(false);
  // Chave da intenção em andamento: reutilizada se a tentativa anterior falhou
  // por rede (o backend pode já ter registrado o alerta).
  const pendingIntentRef = useRef<{ groupId: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const [groupsResult, alertsResult, invitationsResult] = await Promise.allSettled([
      api.listGroups(),
      api.listAlerts("ACTIVE"),
      api.listMyInvitations(),
    ]);

    if (groupsResult.status === "fulfilled") {
      const list = groupsResult.value;
      setGroups(list);
      setSelectedGroupId((previous) =>
        previous && list.some((group) => group.id === previous) ? previous : (list[0]?.id ?? null),
      );
    } else {
      setGroups([]);
      const error = groupsResult.reason;
      setLoadError(
        error instanceof ApiError ? translateErrorCode(error.code) : strings.groups.loadError,
      );
    }

    if (alertsResult.status === "fulfilled") {
      setMyActiveAlerts(alertsResult.value.filter((alert) => alert.createdBy.id === user?.id));
    }

    setPendingCount(
      invitationsResult.status === "fulfilled" ? invitationsResult.value.length : null,
    );
  }, [api, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Phase 5: eventos de alerta/grupo e cada (re)conexão recarregam pela API.
  const onRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      if (isAlertEvent(event) || event.type === "GROUP_MEMBERSHIP_CHANGED") {
        void load();
      }
    },
    [load],
  );
  useRealtimeEvents(onRealtimeEvent, load);

  const selectedGroup = groups?.find((group) => group.id === selectedGroupId) ?? null;
  const ownActiveAlert = selectedGroup
    ? (myActiveAlerts.find((alert) => alert.groupId === selectedGroup.id) ?? null)
    : null;

  const handleActivate = useCallback(async () => {
    if (!selectedGroup || activatingRef.current) {
      return;
    }
    activatingRef.current = true;
    setActivationError(null);
    setPhase("locating");

    const groupId = selectedGroup.id;
    const pending = pendingIntentRef.current;
    const idempotencyKey =
      pending && pending.groupId === groupId ? pending.key : generateIdempotencyKey();
    pendingIntentRef.current = { groupId, key: idempotencyKey };

    try {
      // Nunca bloqueia o pedido de ajuda: sem GPS, `location` é null.
      const location = await captureInitialLocation();
      setPhase("sending");
      const alert = await api.createAlert({ groupId, location }, idempotencyKey);
      pendingIntentRef.current = null;
      nav.navigate({ name: "alertDetails", alertId: alert.id, justActivated: true });
    } catch (error) {
      if (error instanceof ApiError) {
        // Resposta definitiva do servidor: a próxima ativação é uma nova intenção.
        if (error.code !== "NETWORK") {
          pendingIntentRef.current = null;
        }
        setActivationError(translateErrorCode(error.code));
        if (error.code === "ALERT_ALREADY_ACTIVE") {
          await load();
        }
      } else {
        setActivationError(strings.common.genericError);
      }
    } finally {
      activatingRef.current = false;
      setPhase("idle");
    }
  }, [api, load, nav, selectedGroup]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  const busy = phase !== "idle";

  function renderSosArea(): React.JSX.Element {
    if (groups === null) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>{t.loadingGroups}</Text>
        </View>
      );
    }

    if (groups.length === 0) {
      return (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>{t.noGroups}</Text>
          <PrimaryButton label={t.goToGroups} onPress={() => nav.navigate({ name: "groups" })} />
        </View>
      );
    }

    return (
      <>
        <Text style={styles.sectionLabel}>{t.selectedGroup}</Text>
        <View style={styles.groupRow} accessibilityRole="radiogroup">
          {groups.map((group) => {
            const selected = group.id === selectedGroupId;
            return (
              <Pressable
                key={group.id}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected }}
                accessibilityLabel={group.name}
                onPress={() => setSelectedGroupId(group.id)}
                disabled={busy}
                style={[styles.groupChip, selected ? styles.groupChipSelected : null]}
              >
                <Text
                  style={[styles.groupChipText, selected ? styles.groupChipTextSelected : null]}
                >
                  {group.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {groups.length > 1 ? <Text style={styles.muted}>{t.chooseGroupHint}</Text> : null}

        {ownActiveAlert ? (
          <View style={styles.activeCard}>
            <Text style={styles.activeText}>{t.ownActiveAlert}</Text>
            <PrimaryButton
              label={t.viewAlert}
              onPress={() => nav.navigate({ name: "alertDetails", alertId: ownActiveAlert.id })}
            />
          </View>
        ) : (
          <View style={styles.sosArea}>
            <HoldToActivateButton
              label={sos.holdLabel}
              hint={sos.holdHint}
              onActivate={() => void handleActivate()}
              busy={busy}
              busyLabel={phase === "locating" ? sos.locating : sos.activating}
              disabled={!selectedGroup}
              accessibilityLabel={sos.accessibilityLabel}
              accessibilityHint={sos.accessibilityHint}
            />
            {busy ? <ActivityIndicator color={colors.primaryText} /> : null}
          </View>
        )}

        {activationError ? (
          <Text style={styles.error} accessibilityRole="alert">
            {activationError}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.brand}>{strings.common.appName}</Text>
        <Text style={styles.greeting}>{t.greeting(user?.name ?? "")}</Text>

        {renderSosArea()}
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}

        <CheckinsHomeSection nav={nav} />

        <NotificationsCard />

        <PrimaryButton
          label={t.activeAlerts}
          onPress={() => nav.navigate({ name: "activeAlerts" })}
          disabled={busy}
        />

        <Pressable
          style={styles.row}
          onPress={() => nav.navigate({ name: "groups" })}
          accessibilityRole="button"
          disabled={busy}
        >
          <Text style={styles.rowText}>{t.myGroups}</Text>
        </Pressable>

        <Pressable
          style={styles.row}
          onPress={() => nav.navigate({ name: "invitations" })}
          accessibilityRole="button"
          disabled={busy}
        >
          <Text style={styles.rowText}>{t.receivedInvitations}</Text>
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

        <Pressable onPress={handleSignOut} disabled={signingOut || busy} accessibilityRole="button">
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
  sectionLabel: { color: colors.mutedText, fontSize: 13, fontWeight: "700", marginTop: 4 },
  groupRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  groupChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  groupChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  groupChipText: { color: colors.primaryText, fontSize: 15, fontWeight: "600" },
  groupChipTextSelected: { color: colors.primaryText },
  muted: { color: colors.mutedText, fontSize: 13 },
  centered: { alignItems: "center", gap: 8, paddingVertical: 24 },
  noticeCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  noticeText: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  sosArea: { alignItems: "center", paddingVertical: 12, gap: 12 },
  activeCard: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  activeText: { color: colors.primaryText, fontSize: 15, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowText: { color: colors.primaryText, fontSize: 16, fontWeight: "600" },
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
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  disclaimer: { color: colors.mutedText, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
