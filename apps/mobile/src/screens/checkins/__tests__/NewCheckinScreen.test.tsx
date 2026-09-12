import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ApiError, type GroupSummary } from "../../../lib/api";
import { createMockApi, createMockNav, renderWithAuth } from "../../../test-utils/renderWithAuth";
import { NewCheckinScreen } from "../NewCheckinScreen";

const NOW = new Date("2026-09-12T21:00:00.000Z");
const familia: GroupSummary = {
  id: "group-1",
  name: "Família",
  role: "OWNER",
  memberCount: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const amigos: GroupSummary = { ...familia, id: "group-2", name: "Amigos", role: "MEMBER" };

describe("NewCheckinScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("seleciona grupo e duração, mostra a confirmação honesta e cria com dueAt e Idempotency-Key", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia, amigos]),
      createCheckin: jest.fn(async () => ({
        id: "checkin-9",
        groupId: "group-2",
        groupName: "Amigos",
        user: { id: "user-1", name: "Felipe" },
        status: "ACTIVE" as const,
        dueAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
        confirmedAt: null,
        cancelledAt: null,
        overdueAt: null,
        createdAt: NOW.toISOString(),
      })),
    });
    const nav = createMockNav();
    await renderWithAuth(<NewCheckinScreen nav={nav} />, { api });

    expect(await screen.findByText("Novo check-in")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Família" })).toBeSelected();
    await fireEvent.press(screen.getByRole("radio", { name: "Amigos" }));
    expect(screen.getByRole("radio", { name: "Amigos" })).toBeSelected();

    // Duração padrão 30 min; escolhe 15 min.
    await fireEvent.press(screen.getByText("15 minutos"));
    expect(
      screen.getByText(
        /^Se você não confirmar até \d{2}:\d{2}, os membros do grupo Amigos serão avisados\.$/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/emergência/i)).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByText("INICIAR CHECK-IN"));

    await waitFor(() => expect(api.createCheckin).toHaveBeenCalledTimes(1));
    const [input, key] = api.createCheckin.mock.calls[0]!;
    expect(input.groupId).toBe("group-2");
    expect(new Date(input.dueAt).getTime() - NOW.getTime()).toBe(15 * 60_000);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(nav.replace).toHaveBeenCalledWith({ name: "checkinDetails", checkinId: "checkin-9" });
  });

  it("duração personalizada valida entre 5 e 1440 minutos", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => [familia]) });
    await renderWithAuth(<NewCheckinScreen nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("Personalizado"));

    const field = screen.getByLabelText("Minutos (entre 5 e 1440)");
    await fireEvent.changeText(field, "3");
    expect(screen.getByText("Informe um prazo entre 5 minutos e 24 horas.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("INICIAR CHECK-IN"));
    expect(api.createCheckin).not.toHaveBeenCalled();

    await fireEvent.changeText(field, "90");
    expect(
      screen.queryByText("Informe um prazo entre 5 minutos e 24 horas."),
    ).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByText("INICIAR CHECK-IN"));
    await waitFor(() => expect(api.createCheckin).toHaveBeenCalledTimes(1));
    const [input] = api.createCheckin.mock.calls[0]!;
    expect(new Date(input.dueAt).getTime() - NOW.getTime()).toBe(90 * 60_000);
  });

  it("erro da API é exibido em pt-BR", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createCheckin: jest.fn(async () => {
        throw new ApiError("CHECKIN_ALREADY_ACTIVE", "conflict", 409);
      }),
    });
    await renderWithAuth(<NewCheckinScreen nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("INICIAR CHECK-IN"));
    expect(
      await screen.findByText("Você já possui um check-in ativo neste grupo."),
    ).toBeOnTheScreen();
  });

  it("sem grupos: orienta a participar de um grupo", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => []) });
    await renderWithAuth(<NewCheckinScreen nav={createMockNav()} />, { api });
    expect(
      await screen.findByText(
        "Você precisa participar de um grupo de confiança antes de iniciar um check-in.",
      ),
    ).toBeOnTheScreen();
  });
});
