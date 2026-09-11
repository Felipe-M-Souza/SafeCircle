import { act, screen } from "@testing-library/react-native";
import { ApiError } from "../../lib/api";
import {
  consumePendingAlertId,
  openAlertFromNotification,
  resetPendingAlert,
} from "../../notifications/pending-alert";
import { createMockApi, makeAlert, renderWithAuth } from "../../test-utils/renderWithAuth";
import { AuthenticatedApp } from "../AuthenticatedApp";

describe("AuthenticatedApp — abrir alerta a partir de notificação", () => {
  beforeEach(() => {
    resetPendingAlert();
  });

  it("intenção pendente antes de montar (cold start/login) abre a tela do alerta", async () => {
    openAlertFromNotification("alert-1");
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert({ id: "alert-1" })) });
    await renderWithAuth(<AuthenticatedApp />, { api });

    expect(await screen.findByText("🚨 Alerta ativo")).toBeOnTheScreen();
    expect(api.getAlert).toHaveBeenCalledWith("alert-1");
    expect(consumePendingAlertId()).toBeNull();
  });

  it("toque com a área autenticada aberta navega imediatamente", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert({ id: "alert-2" })) });
    await renderWithAuth(<AuthenticatedApp />, { api });
    expect(await screen.findByText("Olá, Felipe.")).toBeOnTheScreen();

    await act(async () => {
      openAlertFromNotification("alert-2");
    });

    expect(await screen.findByText("🚨 Alerta ativo")).toBeOnTheScreen();
    expect(api.getAlert).toHaveBeenCalledWith("alert-2");
  });

  it("notificação antiga mostra o estado atual do alerta (não assume ACTIVE)", async () => {
    openAlertFromNotification("alert-old");
    const api = createMockApi({
      getAlert: jest.fn(async () =>
        makeAlert({ id: "alert-old", status: "RESOLVED", resolvedAt: "2026-09-11T21:00:00.000Z" }),
      ),
    });
    await renderWithAuth(<AuthenticatedApp />, { api });

    expect(await screen.findByText("Alerta resolvido")).toBeOnTheScreen();
    expect(screen.getByText("RESOLVIDO")).toBeOnTheScreen();
  });

  it("alerta inacessível (ALERT_NOT_FOUND) é tratado em pt-BR — o backend decide a autorização", async () => {
    openAlertFromNotification("alert-forbidden");
    const api = createMockApi({
      getAlert: jest.fn(async () => {
        throw new ApiError("ALERT_NOT_FOUND", "not found", 404);
      }),
    });
    await renderWithAuth(<AuthenticatedApp />, { api });

    expect(await screen.findByText("Alerta não encontrado.")).toBeOnTheScreen();
  });
});
