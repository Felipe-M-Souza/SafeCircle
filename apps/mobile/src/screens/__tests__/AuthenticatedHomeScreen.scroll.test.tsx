import { screen } from "@testing-library/react-native";
import { AuthenticatedHomeScreen } from "../AuthenticatedHomeScreen";
import { createMockApi, createMockNav, renderWithAuth } from "../../test-utils/renderWithAuth";

jest.mock("../../lib/location", () => ({
  captureInitialLocation: jest.fn(async () => null),
}));

/**
 * Achado em aparelho (2026-09-16): a home não rolava e cortava o conteúdo
 * abaixo da dobra (grupos, convites, sair, excluir conta, rodapé). A raiz
 * precisa ser um ScrollView cujo conteúdo cresce (flexGrow) em vez de um View
 * com flex fixo centralizado.
 */
describe("AuthenticatedHomeScreen — rolagem", () => {
  it("a raiz da home é um ScrollView com conteúdo que cresce, e o rodapé está na árvore", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => []) });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    const root = await screen.findByTestId("home-scroll");
    expect(root).toBeOnTheScreen();
    const scroll = root;
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");

    const content = Array.isArray(scroll.props.contentContainerStyle)
      ? Object.assign({}, ...scroll.props.contentContainerStyle)
      : scroll.props.contentContainerStyle;
    expect(content.flexGrow).toBe(1);
    expect(content.flex).toBeUndefined();

    // O conteúdo abaixo da dobra continua na árvore (o corte era visual, não lógico).
    expect(screen.getByTestId("home-logout")).toBeOnTheScreen();
    expect(screen.getByTestId("home-delete-account")).toBeOnTheScreen();
    expect(screen.getByLabelText("Versão do aplicativo")).toBeOnTheScreen();
  });
});
