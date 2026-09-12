import { StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import type { LiveLocationPoint } from "../lib/api";
import { colors } from "../theme/colors";

interface LiveLocationMapProps {
  latest: LiveLocationPoint | null;
  trail: LiveLocationPoint[];
  stale: boolean;
}

/**
 * Web (ambiente de demonstração): sem mapa nativo. Mostra apenas se há
 * posição disponível — sem coordenadas cruas como experiência principal.
 */
export function LiveLocationMap({ latest }: LiveLocationMapProps): React.JSX.Element {
  return (
    <View style={styles.placeholder} testID="live-location-map-web">
      <Text style={styles.text}>
        {latest ? strings.liveLocation.mapUnavailable : strings.liveLocation.waitingFirstPoint}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    height: 120,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  text: { color: colors.mutedText, fontSize: 14, textAlign: "center" },
});
