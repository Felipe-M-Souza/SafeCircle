import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Circle, Marker, Polyline, type Region } from "react-native-maps";
import { strings } from "../i18n/pt-BR";
import type { LiveLocationPoint } from "../lib/api";
import { colors } from "../theme/colors";

interface LiveLocationMapProps {
  latest: LiveLocationPoint | null;
  trail: LiveLocationPoint[];
  stale: boolean;
}

const DEFAULT_DELTA = 0.005;

function regionFor(point: LiveLocationPoint): Region {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    latitudeDelta: DEFAULT_DELTA,
    longitudeDelta: DEFAULT_DELTA,
  };
}

/**
 * Mapa (react-native-maps) com a posição mais recente, círculo de precisão e
 * trilha recente limitada. Centraliza no primeiro ponto; depois só recentra
 * quando o usuário toca em CENTRALIZAR (não força reposicionamento enquanto
 * ele explora). Sem geocoding reverso, POIs ou dados externos.
 */
export function LiveLocationMap({ latest, trail, stale }: LiveLocationMapProps): React.JSX.Element {
  const mapRef = useRef<MapView | null>(null);
  const [following, setFollowing] = useState(true);
  const centeredOnceRef = useRef(false);

  useEffect(() => {
    if (!latest) return;
    if (!centeredOnceRef.current || following) {
      centeredOnceRef.current = true;
      mapRef.current?.animateToRegion(regionFor(latest), 300);
    }
  }, [latest, following]);

  if (!latest) {
    return (
      <View style={styles.placeholder} testID="live-location-map-empty">
        <Text style={styles.placeholderText}>{strings.liveLocation.waitingFirstPoint}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        testID="live-location-map"
        initialRegion={regionFor(latest)}
        onPanDrag={() => setFollowing(false)}
        showsPointsOfInterests={false}
        showsBuildings={false}
        toolbarEnabled={false}
      >
        {trail.length > 1 ? (
          <Polyline
            testID="live-location-trail"
            coordinates={trail.map((point) => ({
              latitude: point.latitude,
              longitude: point.longitude,
            }))}
            strokeColor={colors.primary}
            strokeWidth={3}
          />
        ) : null}
        {latest.accuracy !== null && latest.accuracy > 0 ? (
          <Circle
            center={{ latitude: latest.latitude, longitude: latest.longitude }}
            radius={latest.accuracy}
            strokeColor={stale ? colors.mutedText : colors.primary}
            fillColor={stale ? "rgba(148,163,184,0.15)" : "rgba(59,130,246,0.15)"}
          />
        ) : null}
        <Marker
          testID="live-location-marker"
          coordinate={{ latitude: latest.latitude, longitude: latest.longitude }}
          pinColor={stale ? "gray" : "red"}
        />
      </MapView>
      {!following ? (
        <Pressable
          style={styles.centerButton}
          onPress={() => setFollowing(true)}
          accessibilityRole="button"
        >
          <Text style={styles.centerText}>{strings.liveLocation.center}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { height: 260, borderRadius: 14, overflow: "hidden" },
  map: { flex: 1 },
  placeholder: {
    height: 120,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  placeholderText: { color: colors.mutedText, fontSize: 14, textAlign: "center" },
  centerButton: {
    position: "absolute",
    right: 12,
    bottom: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  centerText: { color: colors.primaryText, fontWeight: "800", fontSize: 12 },
});
