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
  Accuracy: { Balanced: 3 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
  getCurrentPositionAsync: jest.fn(async () => {
    throw new Error("GPS indisponível no ambiente de testes.");
  }),
}));

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
