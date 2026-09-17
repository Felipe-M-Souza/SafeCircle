/**
 * Setup global dos testes mobile (Jest + jest-expo).
 *
 * Módulos nativos do Expo são substituídos por mocks: os testes nunca usam
 * GPS real, armazenamento seguro real nem push real (regras 02/06).
 */
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
  getCurrentPositionAsync: jest.fn(async () => {
    throw new Error("GPS indisponível no ambiente de testes.");
  }),
  // Phase 6 — localização ao vivo (foreground): sem GPS real nos testes.
  hasServicesEnabledAsync: jest.fn(async () => true),
  watchPositionAsync: jest.fn(async () => ({ remove: jest.fn() })),
  // Phase 13 — atualizações do SO (serviço em primeiro plano no Android).
  startLocationUpdatesAsync: jest.fn(async () => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
}));

// Phase 13 — TaskManager: a task é registrada em memória, nunca no SO.
jest.mock("expo-task-manager", () => {
  const tasks = new Map<string, unknown>();
  return {
    __esModule: true,
    defineTask: jest.fn((name: string, handler: unknown) => tasks.set(name, handler)),
    isTaskDefined: jest.fn((name: string) => tasks.has(name)),
    unregisterTaskAsync: jest.fn(async () => undefined),
    /** Só para os testes: dispara a task registrada. */
    __getTask: (name: string) => tasks.get(name),
  };
});

// Phase 6 — mapa: componente nativo substituído por Views simples.
jest.mock("react-native-maps", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  interface MockProps {
    children?: React.ReactNode;
    testID?: string;
  }
  interface MockMapHandle {
    animateToRegion: () => void;
  }
  const MapView = React.forwardRef<MockMapHandle, MockProps>(function MockMapView(props, ref) {
    React.useImperativeHandle(ref, () => ({ animateToRegion: jest.fn() }));
    return React.createElement(View, { testID: props.testID ?? "map-view" }, props.children);
  });
  const stub = (name: string) => {
    const Component = (props: MockProps) =>
      React.createElement(View, { testID: props.testID ?? name }, props.children);
    Component.displayName = name;
    return Component;
  };
  return {
    __esModule: true,
    default: MapView,
    Marker: stub("map-marker"),
    Circle: stub("map-circle"),
    Polyline: stub("map-polyline"),
  };
});

// Área segura: sem insets nos testes; SafeAreaView vira um View.
jest.mock("react-native-safe-area-context", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    SafeAreaView: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: import("react-native").StyleProp<import("react-native").ViewStyle>;
    }) => React.createElement(View, { style, testID: "safe-area-view" }, children),
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { frame: { x: 0, y: 0, width: 0, height: 0 }, insets },
  };
});

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} }, easConfig: null },
}));

// Phase 4 — push: token SINTÉTICO, nenhuma chamada real à Expo.
jest.mock("expo-notifications", () => ({
  AndroidImportance: { MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  getPermissionsAsync: jest.fn(async () => ({
    status: "undetermined",
    granted: false,
    canAskAgain: true,
  })),
  requestPermissionsAsync: jest.fn(async () => ({
    status: "denied",
    granted: false,
    canAskAgain: true,
  })),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  getExpoPushTokenAsync: jest.fn(async () => ({
    type: "expo",
    data: "ExponentPushToken[teste-sintetico-0001]",
  })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
}));
