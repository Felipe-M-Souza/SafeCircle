import { useState } from "react";
import { Text } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { strings, translateErrorCode } from "../../i18n/pt-BR";
import { ApiError } from "../../lib/api";
import { validateEmail } from "../../lib/validation";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

export function InviteScreen({
  nav,
  groupId,
  groupName,
}: {
  nav: Nav;
  groupId: string;
  groupName: string;
}): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.invite;
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setMessage(null);
    const emailError = validateEmail(email);
    setFieldError(emailError);
    if (emailError) return;

    setSubmitting(true);
    try {
      await api.createInvitation(groupId, email.trim());
      setMessage(t.success);
      setEmail("");
    } catch (e) {
      setError(e instanceof ApiError ? translateErrorCode(e.code) : strings.common.genericError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen title={t.title(groupName)} onBack={() => nav.goBack()}>
      <TextField
        label={t.emailLabel}
        value={email}
        onChangeText={setEmail}
        error={fieldError ?? undefined}
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!submitting}
      />
      {message ? <Text style={{ color: colors.accent }}>{message}</Text> : null}
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      <PrimaryButton
        label={submitting ? t.submitting : t.submit}
        onPress={handleSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
