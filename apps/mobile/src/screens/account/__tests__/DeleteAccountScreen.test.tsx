import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ApiError, type AccountDeletionPreview } from "../../../lib/api";
import { createAuthValue, createMockApi, createMockNav } from "../../../test-utils/renderWithAuth";
import { render } from "@testing-library/react-native";
import { AuthContext } from "../../../auth/AuthContext";
import { DeleteAccountScreen } from "../DeleteAccountScreen";

const freePreview: AccountDeletionPreview = {
  canDelete: true,
  blockers: {
    groupsWithOtherMembers: [],
    activeAlerts: [],
    activeCheckins: [],
    activeJourneys: [],
  },
  impact: {
    soleMemberGroups: [{ groupId: "g1", name: "Só eu" }],
    membershipsLeft: 1,
    alerts: 2,
    checkins: 0,
    journeys: 1,
    pushDevices: 1,
    sessions: 2,
  },
};

const blockedPreview: AccountDeletionPreview = {
  ...freePreview,
  canDelete: false,
  blockers: {
    groupsWithOtherMembers: [{ groupId: "g2", name: "Família", memberCount: 3 }],
    activeAlerts: ["a1"],
    activeCheckins: [],
    activeJourneys: ["j1", "j2"],
  },
};

async function renderScreen(api: ReturnType<typeof createMockApi>, signOut = jest.fn()) {
  const nav = createMockNav();
  const value = createAuthValue(api, { signOut });
  await render(
    <AuthContext.Provider value={value}>
      <DeleteAccountScreen nav={nav} />
    </AuthContext.Provider>,
  );
  return { nav, signOut };
}

describe("DeleteAccountScreen", () => {
  it("explica as consequências, mostra o impacto e só então pede a senha e a confirmação final", async () => {
    const api = createMockApi({ getAccountDeletionPreview: jest.fn(async () => freePreview) });
    const { signOut } = await renderScreen(api);

    expect(await screen.findByText("Esta ação é permanente.")).toBeOnTheScreen();
    expect(screen.getByText(/política de retenção aplicável/)).toBeOnTheScreen();
    expect(await screen.findByText("• 1 grupo em que você é a única pessoa")).toBeOnTheScreen();
    expect(screen.getByText("• 2 alertas seus")).toBeOnTheScreen();
    expect(screen.getByText("• 2 sessões ativas")).toBeOnTheScreen();
    // Nenhuma senha pedida antes de a pessoa ler e continuar.
    expect(screen.queryByTestId("delete-account-password")).toBeNull();

    await fireEvent.press(screen.getByTestId("delete-account-continue"));
    expect(await screen.findByText("Digite sua senha para continuar.")).toBeOnTheScreen();
    expect(screen.getByTestId("delete-account-password-continue")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("delete-account-password"), "minha senha longa");
    await fireEvent.press(screen.getByTestId("delete-account-password-continue"));

    // Confirmação final explícita, com cancelar visível.
    expect(await screen.findByText("Confirmar exclusão")).toBeOnTheScreen();
    expect(screen.getByText("CANCELAR")).toBeOnTheScreen();
    expect(api.deleteAccount).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("delete-account-confirm"));
    await waitFor(() => expect(api.deleteAccount).toHaveBeenCalledWith("minha senha longa"));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("com bloqueios, lista o que resolver e não deixa continuar", async () => {
    const api = createMockApi({ getAccountDeletionPreview: jest.fn(async () => blockedPreview) });
    await renderScreen(api);

    expect(await screen.findByText("Antes de excluir, resolva:")).toBeOnTheScreen();
    expect(
      screen.getByText(
        '• Você é proprietário do grupo "Família", que tem 2 outros membros. Transfira a propriedade ou remova os membros.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("• Você tem 1 alerta ativo. Encerre-o antes.")).toBeOnTheScreen();
    expect(
      screen.getByText("• Você tem 2 trajetos em andamento. Confirme a chegada ou cancele antes."),
    ).toBeOnTheScreen();
    expect(screen.getByTestId("delete-account-continue")).toBeDisabled();
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it("senha errada volta para a etapa da senha com a mensagem, sem sair da conta", async () => {
    const api = createMockApi({
      getAccountDeletionPreview: jest.fn(async () => freePreview),
      deleteAccount: jest.fn(async () => {
        throw new ApiError("INVALID_CREDENTIALS", "E-mail ou senha inválidos.", 401);
      }),
    });
    const { signOut } = await renderScreen(api);

    await fireEvent.press(await screen.findByTestId("delete-account-continue"));
    await fireEvent.changeText(await screen.findByTestId("delete-account-password"), "errada");
    await fireEvent.press(screen.getByTestId("delete-account-password-continue"));
    await fireEvent.press(await screen.findByTestId("delete-account-confirm"));

    expect(await screen.findByText("E-mail ou senha inválidos.")).toBeOnTheScreen();
    expect(screen.getByTestId("delete-account-password")).toBeOnTheScreen();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("bloqueio que surgiu depois da verificação volta para a revisão e recarrega", async () => {
    const previewMock = jest
      .fn<Promise<AccountDeletionPreview>, []>()
      .mockResolvedValueOnce(freePreview)
      .mockResolvedValueOnce(blockedPreview);
    const api = createMockApi({
      getAccountDeletionPreview: previewMock,
      deleteAccount: jest.fn(async () => {
        throw new ApiError(
          "ACCOUNT_DELETION_BLOCKED_BY_ACTIVE_RESOURCES",
          "Encerre seus alertas, check-ins e trajetos em andamento antes de excluir a conta.",
          409,
        );
      }),
    });
    const { signOut } = await renderScreen(api);

    await fireEvent.press(await screen.findByTestId("delete-account-continue"));
    await fireEvent.changeText(
      await screen.findByTestId("delete-account-password"),
      "minha senha longa",
    );
    await fireEvent.press(screen.getByTestId("delete-account-password-continue"));
    await fireEvent.press(await screen.findByTestId("delete-account-confirm"));

    expect(
      await screen.findByText(
        "Algo mudou desde a verificação. Revise os itens acima e tente de novo.",
      ),
    ).toBeOnTheScreen();
    expect(await screen.findByText("Antes de excluir, resolva:")).toBeOnTheScreen();
    expect(previewMock).toHaveBeenCalledTimes(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("cancelar em qualquer etapa volta sem chamar a API", async () => {
    const api = createMockApi({ getAccountDeletionPreview: jest.fn(async () => freePreview) });
    const { nav } = await renderScreen(api);
    await fireEvent.press(await screen.findByTestId("delete-account-cancel"));
    expect(nav.goBack).toHaveBeenCalledTimes(1);
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });
});
