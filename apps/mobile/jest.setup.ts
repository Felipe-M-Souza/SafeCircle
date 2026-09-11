/**
 * Setup global dos testes mobile (Jest + jest-expo).
 *
 * Módulos nativos do Expo são substituídos por mocks: os testes nunca usam
 * GPS real nem armazenamento seguro real (regras 02/06).
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
