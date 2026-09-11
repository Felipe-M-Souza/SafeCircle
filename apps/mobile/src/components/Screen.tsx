import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { strings } from "../i18n/pt-BR";

interface ScreenProps {
  title: string;
  onBack?: () => void;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

export function Screen({ title, onBack, headerRight, children }: ScreenProps): React.JSX.Element {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.back}>‹ {strings.groups.back}</Text>
          </Pressable>
        ) : (
          <View />
        )}
        {headerRight ?? <View />}
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{title}</Text>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 8,
    minHeight: 40,
  },
  back: { color: colors.primary, fontSize: 16, fontWeight: "600" },
  scroll: { padding: 20, gap: 16 },
  title: { color: colors.primaryText, fontSize: 26, fontWeight: "800" },
});
