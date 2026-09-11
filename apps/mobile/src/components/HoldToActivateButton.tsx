import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

/** Duração padrão do "pressionar e segurar" (≈ 2 segundos). */
export const DEFAULT_HOLD_DURATION_MS = 2000;
const PROGRESS_TICK_MS = 50;

interface HoldToActivateButtonProps {
  label: string;
  hint: string;
  /** Chamado UMA única vez quando o toque é mantido pela duração completa. */
  onActivate: () => void;
  /** Enquanto ocupado o botão não aceita novo acionamento e exibe `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  holdDurationMs?: number;
  accessibilityLabel: string;
  accessibilityHint: string;
  testID?: string;
}

/**
 * Botão SOS com acionamento intencional por pressionar-e-segurar (Phase 3).
 *
 * - Soltar antes do tempo cancela sem efeito.
 * - Nenhuma requisição acontece antes da confirmação da intenção.
 * - A mesma interação nunca dispara `onActivate` mais de uma vez.
 * - Feedback visual de progresso enquanto pressionado.
 */
export function HoldToActivateButton({
  label,
  hint,
  onActivate,
  busy = false,
  busyLabel,
  disabled = false,
  holdDurationMs = DEFAULT_HOLD_DURATION_MS,
  accessibilityLabel,
  accessibilityHint,
  testID = "sos-button",
}: HoldToActivateButtonProps): React.JSX.Element {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);

  const inactive = disabled || busy;

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const cancelHold = useCallback(() => {
    clearTimers();
    setHolding(false);
    setProgress(0);
  }, [clearTimers]);

  const startHold = useCallback(() => {
    if (inactive || timeoutRef.current) {
      return;
    }
    firedRef.current = false;
    const startedAt = Date.now();
    setHolding(true);
    setProgress(0);

    intervalRef.current = setInterval(() => {
      setProgress(Math.min(1, (Date.now() - startedAt) / holdDurationMs));
    }, PROGRESS_TICK_MS);

    timeoutRef.current = setTimeout(() => {
      clearTimers();
      setHolding(false);
      setProgress(1);
      if (!firedRef.current) {
        firedRef.current = true;
        onActivate();
      }
    }, holdDurationMs);
  }, [clearTimers, holdDurationMs, inactive, onActivate]);

  // Limpa timers ao desmontar (ex.: navegação após o acionamento).
  useEffect(() => clearTimers, [clearTimers]);

  // Se o botão ficar ocupado/desabilitado no meio do toque, cancela o hold.
  useEffect(() => {
    if (inactive) {
      cancelHold();
    }
  }, [inactive, cancelHold]);

  return (
    <View style={styles.wrapper}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: inactive, busy }}
        disabled={inactive}
        onPressIn={startHold}
        onPressOut={cancelHold}
        style={[
          styles.button,
          holding ? styles.buttonHolding : null,
          inactive ? styles.buttonInactive : null,
        ]}
      >
        <Text style={styles.icon} accessible={false}>
          🚨
        </Text>
        <Text style={styles.label}>{busy && busyLabel ? busyLabel : label}</Text>
      </Pressable>

      <View style={styles.progressTrack} accessible={false}>
        <View
          testID={`${testID}-progress`}
          style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
        />
      </View>

      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: "center", gap: 12 },
  button: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 6,
    borderColor: "#7f1d1d",
    paddingHorizontal: 16,
  },
  buttonHolding: { transform: [{ scale: 0.96 }], borderColor: colors.primaryText },
  buttonInactive: { opacity: 0.6 },
  icon: { fontSize: 44 },
  label: {
    color: colors.primaryText,
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  progressTrack: {
    width: 200,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.primaryText },
  hint: { color: colors.mutedText, fontSize: 13, textAlign: "center" },
});
