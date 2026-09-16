import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { strings, translateApiError } from "../../i18n/pt-BR";
import { ApiError, type AccountDeletionPreview } from "../../lib/api";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

type Step = "review" | "password" | "confirm";

/**
 * Exclusão de conta (Phase 12), em etapas e sem dark patterns:
 *
 * 1. explica as consequências e lista o que bloqueia (com o que fazer);
 * 2. pede a senha atual (o access token sozinho não confirma algo irreversível);
 * 3. pede a confirmação final explícita, com "Cancelar" tão visível quanto "Excluir".
 *
 * Depois do 204 a sessão local é limpa (SecureStore), o realtime cai e o app
 * volta para a tela pública. Não há reconexão: a conta não existe mais.
 */
export function DeleteAccountScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api, signOut } = useAuth();
  const t = strings.accountDeletion;

  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setPreview(await api.getAccountDeletionPreview());
    } catch (error) {
      setLoadError(translateApiError(error, strings.common.genericError));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const blockerLines = (data: AccountDeletionPreview): string[] => {
    const lines: string[] = [];
    for (const group of data.blockers.groupsWithOtherMembers) {
      lines.push(t.blockerOwnership(group.name, group.memberCount - 1));
    }
    if (data.blockers.activeAlerts.length > 0) {
      lines.push(t.blockerAlerts(data.blockers.activeAlerts.length));
    }
    if (data.blockers.activeCheckins.length > 0) {
      lines.push(t.blockerCheckins(data.blockers.activeCheckins.length));
    }
    if (data.blockers.activeJourneys.length > 0) {
      lines.push(t.blockerJourneys(data.blockers.activeJourneys.length));
    }
    return lines;
  };

  const impactLines = (data: AccountDeletionPreview): string[] => {
    const { impact } = data;
    const lines: string[] = [];
    if (impact.soleMemberGroups.length > 0)
      lines.push(t.impactGroups(impact.soleMemberGroups.length));
    if (impact.membershipsLeft > 0) lines.push(t.impactMemberships(impact.membershipsLeft));
    if (impact.alerts > 0) lines.push(t.impactAlerts(impact.alerts));
    if (impact.checkins > 0) lines.push(t.impactCheckins(impact.checkins));
    if (impact.journeys > 0) lines.push(t.impactJourneys(impact.journeys));
    if (impact.pushDevices > 0) lines.push(t.impactDevices(impact.pushDevices));
    if (impact.sessions > 0) lines.push(t.impactSessions(impact.sessions));
    return lines;
  };

  async function handleDelete(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.deleteAccount(password);
      // A conta acabou: limpa a sessão local; o logout remoto falha (401) e é ignorado.
      await signOut();
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
        setPasswordError(strings.errors.INVALID_CREDENTIALS);
        setStep("password");
      } else if (
        error instanceof ApiError &&
        (error.code === "ACCOUNT_DELETION_BLOCKED_BY_GROUP_OWNERSHIP" ||
          error.code === "ACCOUNT_DELETION_BLOCKED_BY_ACTIVE_RESOURCES")
      ) {
        setSubmitError(t.blockedNow);
        setStep("review");
        await load();
      } else {
        setSubmitError(translateApiError(error, strings.common.genericError));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function renderReview(data: AccountDeletionPreview): React.JSX.Element {
    const blockers = blockerLines(data);
    const impact = impactLines(data);
    return (
      <>
        {blockers.length > 0 ? (
          <View style={styles.blockCard} accessibilityRole="alert">
            <Text style={styles.blockTitle}>{t.blockersTitle}</Text>
            {blockers.map((line) => (
              <Text key={line} style={styles.blockLine}>
                • {line}
              </Text>
            ))}
          </View>
        ) : null}

        {impact.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t.impactTitle}</Text>
            {impact.map((line) => (
              <Text key={line} style={styles.cardLine}>
                • {line}
              </Text>
            ))}
          </View>
        ) : null}

        <PrimaryButton
          label={t.continue}
          onPress={() => setStep("password")}
          disabled={!data.canDelete}
          testID="delete-account-continue"
        />
        <Pressable
          onPress={() => nav.goBack()}
          accessibilityRole="button"
          testID="delete-account-cancel"
        >
          <Text style={styles.cancel}>{t.cancel}</Text>
        </Pressable>
      </>
    );
  }

  function renderPassword(): React.JSX.Element {
    return (
      <>
        <Text style={styles.body}>{t.passwordPrompt}</Text>
        <TextField
          label={t.passwordLabel}
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setPasswordError(null);
          }}
          error={passwordError ?? undefined}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          testID="delete-account-password"
        />
        <PrimaryButton
          label={t.continue}
          onPress={() => setStep("confirm")}
          disabled={password.length === 0}
          testID="delete-account-password-continue"
        />
        <Pressable
          onPress={() => nav.goBack()}
          accessibilityRole="button"
          testID="delete-account-cancel"
        >
          <Text style={styles.cancel}>{t.cancel}</Text>
        </Pressable>
      </>
    );
  }

  function renderConfirm(): React.JSX.Element {
    return (
      <>
        <Text style={styles.finalTitle}>{t.finalTitle}</Text>
        <Text style={styles.body}>{t.finalMessage}</Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => nav.goBack()}
            disabled={submitting}
            accessibilityRole="button"
            style={styles.cancelButton}
            testID="delete-account-cancel"
          >
            <Text style={styles.cancelButtonText}>{t.cancel}</Text>
          </Pressable>
          <Pressable
            onPress={() => void handleDelete()}
            disabled={submitting}
            accessibilityRole="button"
            style={[styles.deleteButton, submitting ? styles.disabled : null]}
            testID="delete-account-confirm"
          >
            <Text style={styles.deleteButtonText}>{submitting ? t.deleting : t.confirm}</Text>
          </Pressable>
        </View>
        {submitting ? <ActivityIndicator color={colors.danger} /> : null}
      </>
    );
  }

  return (
    <Screen title={t.title} onBack={() => nav.goBack()}>
      <Text style={styles.title}>{t.title}</Text>
      <Text style={styles.permanent}>{t.permanent}</Text>
      <Text style={styles.body}>{t.consequences}</Text>

      {loadError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {loadError}
        </Text>
      ) : null}
      {submitError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {submitError}
        </Text>
      ) : null}

      {preview === null && !loadError ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>{t.loading}</Text>
        </View>
      ) : null}

      {preview && step === "review" ? renderReview(preview) : null}
      {preview && step === "password" ? renderPassword() : null}
      {preview && step === "confirm" ? renderConfirm() : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.primaryText, fontSize: 24, fontWeight: "800" },
  permanent: { color: colors.danger, fontSize: 16, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.mutedText, fontSize: 13 },
  centered: { alignItems: "center", gap: 8, paddingVertical: 24 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  cardTitle: { color: colors.primaryText, fontSize: 14, fontWeight: "700" },
  cardLine: { color: colors.primaryText, fontSize: 14, lineHeight: 20 },
  blockCard: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  blockTitle: { color: colors.danger, fontSize: 14, fontWeight: "700" },
  blockLine: { color: colors.primaryText, fontSize: 14, lineHeight: 20 },
  cancel: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 10,
  },
  finalTitle: { color: colors.primaryText, fontSize: 18, fontWeight: "800" },
  actions: { flexDirection: "row", gap: 12 },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelButtonText: { color: colors.primaryText, fontSize: 15, fontWeight: "700" },
  deleteButton: {
    flex: 1,
    backgroundColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  deleteButtonText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  disabled: { opacity: 0.6 },
  error: { color: colors.danger, fontSize: 14 },
});
