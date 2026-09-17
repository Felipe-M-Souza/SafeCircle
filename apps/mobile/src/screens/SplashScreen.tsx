import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { BrandLogo } from "../components/BrandLogo";
import { strings } from "../i18n/pt-BR";
import { colors } from "../theme/colors";

export function SplashScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <BrandLogo />
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
  text: { color: colors.mutedText, fontSize: 15 },
});
