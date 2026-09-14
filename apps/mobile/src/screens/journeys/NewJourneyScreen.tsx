import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { strings, translateApiError } from "../../i18n/pt-BR";
import { ApiError, type GroupSummary } from "../../lib/api";
import { generateIdempotencyKey } from "../../lib/idempotency";
import { formatTime } from "../../lib/time";
import { useNow } from "../../live-location/useLiveLocation";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

const DURATION_OPTIONS = [30, 60, 120] as const;
const CUSTOM = "custom";
const MIN_MINUTES = 10;
const MAX_MINUTES = 24 * 60;
const DESTINATION_MAX = 120;

/**
 * Novo trajeto seguro (Phase 8): grupo, destino opcional, prazo e opt-in de
 * localização. Antes de criar, uma confirmação explica exatamente o que
 * acontece se não houver confirmação — o grupo será avisado; nenhuma
 * emergência é acionada. O `expectedArrivalAt` enviado é absoluto (UTC).
 */
export function NewJourneyScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.journeys;
  const now = useNow(30_000);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [duration, setDuration] = useState<number | typeof CUSTOM>(30);
  const [customMinutes, setCustomMinutes] = useState("");
  const [shareLocation, setShareLocation] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateIdempotencyKey());

  const load = useCallback(async () => {
    try {
      const list = await api.listGroups();
      setGroups(list);
      setGroupId((previous) => previous ?? list[0]?.id ?? null);
    } catch (e) {
      setError(translateApiError(e, strings.groups.loadError));
      setGroups([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const minutes = useMemo(() => {
    if (duration !== CUSTOM) return duration;
    const parsed = Number.parseInt(customMinutes, 10);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }, [duration, customMinutes]);
  const minutesValid = Number.isFinite(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
  const dueAt = minutesValid ? new Date(now + minutes * 60_000) : null;
  const trimmedDestination = destination.trim();
  const destinationValid = trimmedDestination.length <= DESTINATION_MAX;
  const selectedGroup = groups?.find((group) => group.id === groupId) ?? null;
  const canSubmit = Boolean(selectedGroup && dueAt && destinationValid);

  async function handleConfirm() {
    if (!selectedGroup || !dueAt) return;
    setSubmitting(true);
    setError(null);
    try {
      const journey = await api.createJourney(
        {
          groupId: selectedGroup.id,
          destinationLabel: trimmedDestination.length > 0 ? trimmedDestination : undefined,
          expectedArrivalAt: dueAt.toISOString(),
          liveLocationEnabled: shareLocation,
        },
        idempotencyKey,
      );
      nav.replace({ name: "journeyDetails", journeyId: journey.id });
    } catch (e) {
      if (e instanceof ApiError && e.code !== "NETWORK") {
        setIdempotencyKey(generateIdempotencyKey());
      }
      setConfirming(false);
      setError(translateApiError(e, strings.common.genericError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen title={t.newTitle} onBack={() => nav.goBack()}>
      {groups === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : groups.length === 0 ? (
        <Text style={styles.body}>{t.noGroups}</Text>
      ) : confirming && selectedGroup && dueAt ? (
        <View style={styles.confirmCard}>
          <Text style={styles.confirmTitle}>{t.confirmTitle}</Text>
          <Text style={styles.body}>{t.confirmBody(formatTime(dueAt.toISOString()))}</Text>
          <Text style={styles.muted}>
            {shareLocation ? t.confirmSharingOn : t.confirmSharingOff}
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            label={submitting ? t.creating : t.confirmStart}
            onPress={() => void handleConfirm()}
            loading={submitting}
          />
          <Pressable
            onPress={() => setConfirming(false)}
            disabled={submitting}
            accessibilityRole="button"
          >
            <Text style={styles.link}>{t.confirmCancelStart}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.label}>{t.groupLabel}</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            {groups.map((group) => {
              const selected = group.id === groupId;
              return (
                <Pressable
                  key={group.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  accessibilityLabel={group.name}
                  onPress={() => setGroupId(group.id)}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={styles.chipText}>{group.name}</Text>
                </Pressable>
              );
            })}
          </View>

          <TextField
            label={t.destinationLabel}
            value={destination}
            onChangeText={setDestination}
            placeholder={t.destinationPlaceholder}
            maxLength={DESTINATION_MAX}
          />

          <Text style={styles.label}>{t.arrivalLabel}</Text>
          <View style={styles.options} accessibilityRole="radiogroup">
            {DURATION_OPTIONS.map((option) => {
              const selected = duration === option;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  onPress={() => setDuration(option)}
                  style={[styles.option, selected ? styles.optionSelected : null]}
                >
                  <Text style={styles.optionText}>{t.durations[option]}</Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: duration === CUSTOM, checked: duration === CUSTOM }}
              onPress={() => setDuration(CUSTOM)}
              style={[styles.option, duration === CUSTOM ? styles.optionSelected : null]}
            >
              <Text style={styles.optionText}>{t.customDuration}</Text>
            </Pressable>
          </View>
          {duration === CUSTOM ? (
            <TextField
              label={t.customMinutesLabel}
              value={customMinutes}
              onChangeText={setCustomMinutes}
              keyboardType="number-pad"
              error={customMinutes && !minutesValid ? t.customMinutesInvalid : undefined}
            />
          ) : null}

          <Pressable
            style={styles.checkboxRow}
            onPress={() => setShareLocation((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: shareLocation }}
            accessibilityLabel={t.shareLocationLabel}
          >
            <View style={[styles.checkbox, shareLocation ? styles.checkboxOn : null]}>
              {shareLocation ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkboxLabel}>{t.shareLocationLabel}</Text>
          </Pressable>
          <Text style={styles.muted}>{t.shareLocationHint}</Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PrimaryButton
            label={t.start}
            onPress={() => setConfirming(true)}
            disabled={!canSubmit}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.mutedText, fontSize: 13, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.primaryText, fontSize: 15, fontWeight: "600" },
  options: { gap: 8 },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.surface },
  optionText: { color: colors.primaryText, fontSize: 15, fontWeight: "600" },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxMark: { color: colors.primaryText, fontWeight: "800" },
  checkboxLabel: { color: colors.primaryText, fontSize: 15, flexShrink: 1 },
  confirmCard: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  confirmTitle: { color: colors.primaryText, fontSize: 18, fontWeight: "800" },
  link: { color: colors.primary, fontWeight: "700", textAlign: "center" },
  error: { color: colors.danger, fontSize: 14 },
});
