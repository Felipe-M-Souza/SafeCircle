import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../auth/AuthContext";
import { PrimaryButton } from "../components/PrimaryButton";
import { TextField } from "../components/TextField";
import { strings, translateErrorCode } from "../i18n/pt-BR";
import { ApiError } from "../lib/api";
import { validateLogin } from "../lib/validation";
import { colors } from "../theme/colors";

export function LoginScreen({
  onNavigateToRegister,
}: {
  onNavigateToRegister: () => void;
}): React.JSX.Element {
  const { signIn } = useAuth();
  const t = strings.login;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setFormError(null);
    const validation = validateLogin(email, password);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? translateErrorCode(error.code) : strings.common.genericError,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.brand}>{strings.common.appName}</Text>
          <Text style={styles.title}>{t.title}</Text>

          <TextField
            label={t.email}
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            editable={!submitting}
          />
          <TextField
            label={t.password}
            value={password}
            onChangeText={setPassword}
            error={errors.password}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            editable={!submitting}
          />

          {formError ? <Text style={styles.formError}>{formError}</Text> : null}

          <PrimaryButton
            label={submitting ? t.submitting : t.submit}
            onPress={handleSubmit}
            loading={submitting}
          />

          <View style={styles.footer}>
            <Text style={styles.footerText}>{t.noAccountQuestion}</Text>
            <Pressable onPress={onNavigateToRegister} disabled={submitting}>
              <Text style={styles.link}>{t.goToRegister}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 28,
    gap: 16,
  },
  brand: { color: colors.primaryText, fontSize: 28, fontWeight: "800", textAlign: "center" },
  title: { color: colors.mutedText, fontSize: 16, textAlign: "center", marginBottom: 4 },
  formError: { color: colors.danger, fontSize: 14, textAlign: "center" },
  footer: { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 4 },
  footerText: { color: colors.mutedText, fontSize: 14 },
  link: { color: colors.primary, fontSize: 14, fontWeight: "700" },
});
