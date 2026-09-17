import Constants from "expo-constants";
import { Platform } from "react-native";
import { externalMapUrl, isNativeMapAvailable } from "../maps";

/**
 * Achado em aparelho (2026-09-16): no Android sem chave do Google Maps o
 * MapView derruba o app. O helper decide, antes de montar o mapa, se a build
 * atual pode exibi-lo. Como o Expo remove `android.config` da configuração
 * pública, a decisão em produção vem do sinalizador `extra.googleMapsApiKeyConfigured`.
 */
type MutableConstants = { expoConfig: Record<string, unknown> | null };
const constants = Constants as unknown as MutableConstants;
const originalConfig = constants.expoConfig;
const originalOS = Platform.OS;

function setPlatform(os: string) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
}

afterEach(() => {
  constants.expoConfig = originalConfig;
  setPlatform(originalOS);
});

describe("isNativeMapAvailable", () => {
  it("Android sem sinalizador nem chave: mapa indisponível (evita o crash)", () => {
    setPlatform("android");
    constants.expoConfig = { extra: {}, android: { config: {} } };
    expect(isNativeMapAvailable()).toBe(false);
    constants.expoConfig = { extra: { googleMapsApiKeyConfigured: false } };
    expect(isNativeMapAvailable()).toBe(false);
    constants.expoConfig = { extra: { googleMapsApiKeyConfigured: "true" } };
    expect(isNativeMapAvailable()).toBe(false);
    constants.expoConfig = { android: { config: { googleMaps: { apiKey: "   " } } } };
    expect(isNativeMapAvailable()).toBe(false);
    constants.expoConfig = null;
    expect(isNativeMapAvailable()).toBe(false);
  });

  it("Android com o sinalizador público (build de produção): mapa disponível", () => {
    setPlatform("android");
    constants.expoConfig = { extra: { googleMapsApiKeyConfigured: true } };
    expect(isNativeMapAvailable()).toBe(true);
  });

  it("Android com a chave visível (desenvolvimento): mapa disponível", () => {
    setPlatform("android");
    constants.expoConfig = {
      android: { config: { googleMaps: { apiKey: "AIza-chave-sintetica" } } },
    };
    expect(isNativeMapAvailable()).toBe(true);
  });

  it("iOS não exige chave; web nunca monta o mapa nativo", () => {
    setPlatform("ios");
    constants.expoConfig = { android: { config: {} } };
    expect(isNativeMapAvailable()).toBe(true);
    setPlatform("web");
    constants.expoConfig = { extra: { googleMapsApiKeyConfigured: true } };
    expect(isNativeMapAvailable()).toBe(false);
  });
});

describe("externalMapUrl", () => {
  it("gera URL do app de mapas do sistema com 6 casas decimais (coordenadas sintéticas)", () => {
    setPlatform("android");
    expect(externalMapUrl(-23.123456789, -46.987654321)).toBe(
      "geo:-23.123457,-46.987654?q=-23.123457,-46.987654(SafeCircle)",
    );
    setPlatform("ios");
    expect(externalMapUrl(-23.1, -46.2)).toBe("maps:0,0?q=-23.100000,-46.200000");
  });
});
