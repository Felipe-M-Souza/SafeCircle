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

const DURATION_OPTIONS = [15, 30, 60, 120] as const;
const CUSTOM = "custom";
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;

/**
 * Novo check-in (Phase 7): escolha do grupo e do prazo. Antes de criar, o
 * app explica exatamente o que acontece se não houver confirmação — os
 * membros serão avisados; nenhuma emergência é acionada. O `dueAt` enviado é
 * absoluto (UTC); o servidor valida com o próprio relógio.
 */
export function NewCheckinScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.checkins;
  const now = useNow(30_000);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | typeof CUSTOM>(30);
  const [customMinutes, setCustomMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Uma chave por intenção de criação; reutilizada se a rede falhar.
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
  const selectedGroup = groups?.find((group) => group.id === groupId) ?? null;

  async function handleSubmit() {
    if (!selectedGroup || !dueAt) return;
    setSubmitting(true);
    setError(null);
    try {
      const checkin = await api.createCheckin(
        { groupId: selectedGroup.id, dueAt: dueAt.toISOString() },
        idempotencyKey,
      );
      nav.replace({ name: "checkinDetails", checkinId: checkin.id });
    } catch (e) {
      if (e instanceof ApiError && e.code !== "NETWORK") {
        // Resposta definitiva: a próxima tentativa é uma nova intenção.
        setIdempotencyKey(generateIdempotencyKey());
      }
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
                  disabled={submitting}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={styles.chipText}>{group.name}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>{t.durationLabel}</Text>
          <View style={styles.options} accessibilityRole="radiogroup">
            {DURATION_OPTIONS.map((option) => {
              const selected = duration === option;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  onPress={() => setDuration(option)}
                  disabled={submitting}
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
              disabled={submitting}
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
              editable={!submitting}
              error={customMinutes && !minutesValid ? t.customMinutesInvalid : undefined}
            />
          ) : null}

          {selectedGroup && dueAt ? (
            <Text style={styles.warning}>
              {t.warning(formatTime(dueAt.toISOString()), selectedGroup.name)}
            </Text>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PrimaryButton
            label={submitting ? t.creating : t.start}
            onPress={() => void handleSubmit()}
            loading={submitting}
            disabled={!selectedGroup || !dueAt}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.mutedText, fontSize: 13, fontWeight: "700" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
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
  warning: { color: colors.primaryText, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14 },
});
