import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import { colors } from "../theme/colors";

export function SplashScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.brand}>{strings.common.appName}</Text>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.text}>{strings.splash.restoringSession}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: 16,
    padding: 24,
  },
  brand: { color: colors.primaryText, fontSize: 32, fontWeight: "800" },
  text: { color: colors.mutedText, fontSize: 15 },
});
