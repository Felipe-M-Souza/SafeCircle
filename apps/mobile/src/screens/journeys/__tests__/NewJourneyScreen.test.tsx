import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ApiError, type GroupSummary, type SafeJourney } from "../../../lib/api";
import { createMockApi, createMockNav, renderWithAuth } from "../../../test-utils/renderWithAuth";
import { NewJourneyScreen } from "../NewJourneyScreen";

const NOW = new Date("2026-09-12T21:00:00.000Z");
const familia: GroupSummary = {
  id: "group-1",
  name: "Família",
  role: "OWNER",
  memberCount: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const amigos: GroupSummary = { ...familia, id: "group-2", name: "Amigos", role: "MEMBER" };

function createdJourney(overrides: Partial<SafeJourney> = {}): SafeJourney {
  return {
    id: "journey-9",
    groupId: "group-2",
    groupName: "Amigos",
    user: { id: "user-1", name: "Felipe" },
    status: "ACTIVE",
    destinationLabel: "Casa",
    expectedArrivalAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    liveLocationEnabled: true,
    startedAt: NOW.toISOString(),
    arrivedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("NewJourneyScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("seleciona grupo, destino, duração e opt-in; confirma e cria com Idempotency-Key", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia, amigos]),
      createJourney: jest.fn(async () => createdJourney()),
    });
    const nav = createMockNav();
    await renderWithAuth(<NewJourneyScreen nav={nav} />, { api });

    expect(await screen.findByText("Novo trajeto seguro")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Família" })).toBeSelected();
    await fireEvent.press(screen.getByRole("radio", { name: "Amigos" }));

    await fireEvent.changeText(screen.getByLabelText("Destino (opcional)"), "  Casa  ");
    await fireEvent.press(screen.getByText("1 hora"));
    await fireEvent.press(screen.getByLabelText("Compartilhar localização durante o trajeto"));

    // Passo 1: abre a confirmação honesta (sem afirmar emergência).
    await fireEvent.press(screen.getByText("INICIAR TRAJETO"));
    expect(await screen.findByText("Iniciar trajeto seguro?")).toBeOnTheScreen();
    expect(
      screen.getByText(
        /^Seu grupo será avisado se você não confirmar a chegada até \d{2}:\d{2}\.$/,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Compartilhamento de localização: Ativado")).toBeOnTheScreen();
    expect(screen.queryByText(/emergência/i)).not.toBeOnTheScreen();
    expect(api.createJourney).not.toHaveBeenCalled();

    // Passo 2: confirma.
    await fireEvent.press(screen.getByText("Iniciar"));
    await waitFor(() => expect(api.createJourney).toHaveBeenCalledTimes(1));
    const [input, key] = api.createJourney.mock.calls[0]!;
    expect(input.groupId).toBe("group-2");
    expect(input.destinationLabel).toBe("Casa");
    expect(input.liveLocationEnabled).toBe(true);
    expect(new Date(input.expectedArrivalAt).getTime() - NOW.getTime()).toBe(60 * 60_000);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(nav.replace).toHaveBeenCalledWith({ name: "journeyDetails", journeyId: "journey-9" });
  });

  it("destino é opcional e duração personalizada valida entre 10 e 1440 minutos", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createJourney: jest.fn(async () => createdJourney({ destinationLabel: null })),
    });
    await renderWithAuth(<NewJourneyScreen nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("Personalizado"));

    const field = screen.getByLabelText("Minutos (entre 10 e 1440)");
    await fireEvent.changeText(field, "5");
    expect(screen.getByText("Informe um prazo entre 10 minutos e 24 horas.")).toBeOnTheScreen();

    await fireEvent.changeText(field, "90");
    await fireEvent.press(screen.getByText("INICIAR TRAJETO"));
    await fireEvent.press(await screen.findByText("Iniciar"));
    await waitFor(() => expect(api.createJourney).toHaveBeenCalledTimes(1));
    const [input] = api.createJourney.mock.calls[0]!;
    expect(input.destinationLabel).toBeUndefined();
    expect(new Date(input.expectedArrivalAt).getTime() - NOW.getTime()).toBe(90 * 60_000);
  });

  it("erro da API é exibido em pt-BR", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createJourney: jest.fn(async () => {
        throw new ApiError("JOURNEY_ALREADY_ACTIVE", "conflict", 409);
      }),
    });
    await renderWithAuth(<NewJourneyScreen nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("INICIAR TRAJETO"));
    await fireEvent.press(await screen.findByText("Iniciar"));
    expect(await screen.findByText("Você já possui um trajeto em andamento.")).toBeOnTheScreen();
  });

  it("sem grupos: orienta a participar de um grupo", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => []) });
    await renderWithAuth(<NewJourneyScreen nav={createMockNav()} />, { api });
    expect(
      await screen.findByText(
        "Você precisa participar de um grupo de confiança antes de iniciar um trajeto.",
      ),
    ).toBeOnTheScreen();
  });
});
