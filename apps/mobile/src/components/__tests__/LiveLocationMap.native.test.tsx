import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { LiveLocationMap } from "../LiveLocationMap.native";
import { isNativeMapAvailable } from "../../lib/maps";
import type { LiveLocationPoint } from "../../lib/api";

jest.mock("../../lib/maps", () => ({
  isNativeMapAvailable: jest.fn(() => true),
  externalMapUrl: (lat: number, lng: number) => `geo:${lat},${lng}?q=${lat},${lng}(SafeCircle)`,
}));

const mockedAvailable = jest.mocked(isNativeMapAvailable);

// Coordenadas SINTÉTICAS (oceano).
const point: LiveLocationPoint = {
  latitude: -30.5,
  longitude: -40.5,
  accuracy: 12,
  capturedAt: "2026-09-16T19:23:00.000Z",
} as LiveLocationPoint;

/**
 * Achado em aparelho (2026-09-16): sem chave do Google Maps o MapView derruba o
 * app Android. Quando o mapa não está disponível, nada do react-native-maps é
 * montado e a pessoa ainda consegue abrir a posição no app de mapas do sistema.
 */
describe("LiveLocationMap (nativo)", () => {
  afterEach(() => {
    mockedAvailable.mockReturnValue(true);
    jest.restoreAllMocks();
  });

  it("sem mapa disponível: mostra o cartão de fallback, não monta o MapView e abre o app de mapas", async () => {
    mockedAvailable.mockReturnValue(false);
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);

    await render(<LiveLocationMap latest={point} trail={[point]} stale={false} />);

    expect(screen.getByTestId("live-location-map-unavailable")).toBeOnTheScreen();
    expect(screen.queryByTestId("live-location-map")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("live-location-marker")).not.toBeOnTheScreen();
    expect(
      screen.getByText(
        "O mapa não está disponível nesta versão do app. A posição continua sendo compartilhada com o grupo.",
      ),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("live-location-open-maps"));
    expect(openUrl).toHaveBeenCalledWith("geo:-30.5,-40.5?q=-30.5,-40.5(SafeCircle)");
  });

  it("com mapa disponível: monta o MapView com marcador", async () => {
    mockedAvailable.mockReturnValue(true);
    await render(<LiveLocationMap latest={point} trail={[point]} stale={false} />);
    expect(screen.getByTestId("live-location-map")).toBeOnTheScreen();
    expect(screen.getByTestId("live-location-marker")).toBeOnTheScreen();
    expect(screen.queryByTestId("live-location-map-unavailable")).not.toBeOnTheScreen();
  });

  it("sem primeiro ponto: placeholder de espera em qualquer caso", async () => {
    mockedAvailable.mockReturnValue(false);
    await render(<LiveLocationMap latest={null} trail={[]} stale={false} />);
    expect(screen.getByTestId("live-location-map-empty")).toBeOnTheScreen();
  });
});
