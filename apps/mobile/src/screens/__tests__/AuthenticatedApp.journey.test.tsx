import { act, screen } from "@testing-library/react-native";
import type { SafeJourney } from "../../lib/api";
import { parseNotificationData } from "../../notifications/notifications.service";
import {
  consumePendingTarget,
  openJourneyFromNotification,
  resetPendingAlert,
} from "../../notifications/pending-alert";
import { createMockApi, renderWithAuth } from "../../test-utils/renderWithAuth";
import { AuthenticatedApp } from "../AuthenticatedApp";

const overdue: SafeJourney = {
  id: "journey-7",
  groupId: "group-1",
  groupName: "Família",
  user: { id: "user-2", name: "Maria" },
  status: "OVERDUE",
  destinationLabel: "Casa",
  expectedArrivalAt: "2026-09-12T20:00:00.000Z",
  liveLocationEnabled: false,
  startedAt: "2026-09-12T19:30:00.000Z",
  arrivedAt: null,
  cancelledAt: null,
  overdueAt: "2026-09-12T20:00:05.000Z",
  createdAt: "2026-09-12T19:30:00.000Z",
};

describe("Navegação por push SAFE_JOURNEY_OVERDUE", () => {
  beforeEach(() => {
    resetPendingAlert();
  });

  it("parse do payload do push de trajeto atrasado (só IDs)", () => {
    expect(
      parseNotificationData({ type: "SAFE_JOURNEY_OVERDUE", journeyId: "journey-7", groupId: "g" }),
    ).toEqual({ type: "SAFE_JOURNEY_OVERDUE", journeyId: "journey-7", groupId: "g" });
    expect(parseNotificationData({ type: "SAFE_JOURNEY_OVERDUE" })).toBeNull();
    expect(parseNotificationData({ type: "SAFETY_CHECKIN_OVERDUE", checkinId: "c1" })).toEqual({
      type: "SAFETY_CHECKIN_OVERDUE",
      checkinId: "c1",
    });
  });

  it("toque antes de montar (cold start) abre o detalhe do trajeto com o estado atual da API", async () => {
    openJourneyFromNotification("journey-7");
    const api = createMockApi({
      getJourney: jest.fn(async () => ({
        ...overdue,
        status: "ARRIVED" as const,
        arrivedAt: "2026-09-12T20:10:00.000Z",
      })),
    });
    await renderWithAuth(<AuthenticatedApp />, { api });

    // Já chegou: mostra ARRIVED, não assume OVERDUE.
    expect(await screen.findByText("Chegada confirmada com segurança.")).toBeOnTheScreen();
    expect(api.getJourney).toHaveBeenCalledWith("journey-7");
    expect(consumePendingTarget()).toBeNull();
  });

  it("toque com o app aberto navega para o trajeto", async () => {
    const api = createMockApi({ getJourney: jest.fn(async () => overdue) });
    await renderWithAuth(<AuthenticatedApp />, { api });
    expect(await screen.findByText("Olá, Felipe.")).toBeOnTheScreen();

    await act(async () => {
      openJourneyFromNotification("journey-7");
    });
    expect(await screen.findByText("Chegada não confirmada")).toBeOnTheScreen();
    expect(
      screen.getByText("O prazo de chegada de Maria passou sem confirmação."),
    ).toBeOnTheScreen();
  });
});
