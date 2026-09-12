import { act, screen } from "@testing-library/react-native";
import type { SafetyCheckin } from "../../lib/api";
import { parseNotificationData } from "../../notifications/notifications.service";
import {
  consumePendingTarget,
  openCheckinFromNotification,
  resetPendingAlert,
} from "../../notifications/pending-alert";
import { createMockApi, renderWithAuth } from "../../test-utils/renderWithAuth";
import { AuthenticatedApp } from "../AuthenticatedApp";

const overdue: SafetyCheckin = {
  id: "checkin-7",
  groupId: "group-1",
  groupName: "Família",
  user: { id: "user-2", name: "Maria" },
  status: "OVERDUE",
  dueAt: "2026-09-12T20:00:00.000Z",
  confirmedAt: null,
  cancelledAt: null,
  overdueAt: "2026-09-12T20:00:05.000Z",
  createdAt: "2026-09-12T19:30:00.000Z",
};

describe("Navegação por push SAFETY_CHECKIN_OVERDUE", () => {
  beforeEach(() => {
    resetPendingAlert();
  });

  it("parse do payload do push de check-in vencido (só IDs)", () => {
    expect(
      parseNotificationData({
        type: "SAFETY_CHECKIN_OVERDUE",
        checkinId: "checkin-7",
        groupId: "g",
      }),
    ).toEqual({ type: "SAFETY_CHECKIN_OVERDUE", checkinId: "checkin-7", groupId: "g" });
    expect(parseNotificationData({ type: "SAFETY_CHECKIN_OVERDUE" })).toBeNull();
    expect(parseNotificationData({ type: "EMERGENCY_ALERT", alertId: "a1" })).toEqual({
      type: "EMERGENCY_ALERT",
      alertId: "a1",
    });
  });

  it("toque antes de montar (cold start) abre o detalhe do check-in com o estado atual da API", async () => {
    openCheckinFromNotification("checkin-7");
    const api = createMockApi({
      getCheckin: jest.fn(async () => ({
        ...overdue,
        status: "SAFE" as const,
        confirmedAt: "2026-09-12T20:10:00.000Z",
      })),
    });
    await renderWithAuth(<AuthenticatedApp />, { api });

    // Já virou SAFE: mostra SAFE, não assume OVERDUE.
    expect(await screen.findByText("Confirmou que está bem")).toBeOnTheScreen();
    expect(api.getCheckin).toHaveBeenCalledWith("checkin-7");
    expect(consumePendingTarget()).toBeNull();
  });

  it("toque com o app aberto navega para o check-in", async () => {
    const api = createMockApi({ getCheckin: jest.fn(async () => overdue) });
    await renderWithAuth(<AuthenticatedApp />, { api });
    expect(await screen.findByText("Olá, Felipe.")).toBeOnTheScreen();

    await act(async () => {
      openCheckinFromNotification("checkin-7");
    });
    expect(await screen.findByText("Check-in não confirmado")).toBeOnTheScreen();
    expect(screen.getByText("O prazo de Maria venceu sem confirmação.")).toBeOnTheScreen();
  });
});
