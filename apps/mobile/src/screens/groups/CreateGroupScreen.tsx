import { useState } from "react";
import { Text } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { strings, translateApiError } from "../../i18n/pt-BR";
import { colors } from "../../theme/colors";
import type { Nav } from "../../navigation/types";

export function CreateGroupScreen({ nav }: { nav: Nav }): React.JSX.Element {
  const { api } = useAuth();
  const t = strings.createGroup;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError(strings.validation.nameRequired);
      return;
    }
    setSubmitting(true);
    try {
      const group = await api.createGroup(name.trim());
      // Substitui esta tela pelos detalhes do grupo recém-criado.
      nav.replace({ name: "groupDetails", groupId: group.id });
    } catch (e) {
      setError(translateApiError(e, strings.common.genericError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen title={t.title} onBack={() => nav.goBack()}>
      <TextField
        label={t.nameLabel}
        value={name}
        onChangeText={setName}
        editable={!submitting}
        autoFocus
      />
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      <PrimaryButton
        label={submitting ? t.submitting : t.submit}
        onPress={handleSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
