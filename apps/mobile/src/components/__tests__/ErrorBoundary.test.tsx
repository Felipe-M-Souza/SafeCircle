import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { ErrorBoundary } from "../ErrorBoundary";
import { ApiError } from "../../lib/api";
import { translateApiError } from "../../i18n/pt-BR";

/**
 * Phase 9: uma falha de render não pode virar tela branca, e a interface nunca
 * mostra stack. O código de suporte (errorId/requestId) é o elo com o log.
 */
function Boom({ error }: { error: unknown }): React.JSX.Element {
  throw error;
}

describe("ErrorBoundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    // React registra o erro capturado; silenciamos só para não poluir a saída.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it("mostra mensagem segura em vez de quebrar a árvore", async () => {
    await render(
      <ErrorBoundary>
        <Boom error={new Error("detalhe interno com stack")} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("error-boundary")).toBeOnTheScreen();
    expect(screen.getByText("Algo deu errado")).toBeOnTheScreen();
    expect(screen.getByText("Não foi possível exibir esta tela.")).toBeOnTheScreen();
    expect(screen.getByText("TENTAR NOVAMENTE")).toBeOnTheScreen();
    // Nada do erro cru aparece na interface.
    expect(screen.queryByText(/detalhe interno/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/stack/i)).not.toBeOnTheScreen();
  });

  it("exibe o código de suporte quando o erro veio da API com errorId", async () => {
    const error = new ApiError("INTERNAL_ERROR", "Erro interno.", 500, {
      requestId: "11111111-1111-4111-8111-111111111111",
      errorId: "22222222-2222-4222-8222-222222222222",
    });
    await render(
      <ErrorBoundary>
        <Boom error={error} />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("Código de suporte: 22222222-2222-4222-8222-222222222222"),
    ).toBeOnTheScreen();
  });

  it("sem errorId usa o requestId como código de suporte", async () => {
    const error = new ApiError("INTERNAL_ERROR", "Erro interno.", 500, {
      requestId: "33333333-3333-4333-8333-333333333333",
    });
    await render(
      <ErrorBoundary>
        <Boom error={error} />
      </ErrorBoundary>,
    );
    expect(
      screen.getByText("Código de suporte: 33333333-3333-4333-8333-333333333333"),
    ).toBeOnTheScreen();
  });

  it("erro comum não inventa código de suporte", async () => {
    await render(
      <ErrorBoundary>
        <Boom error={new Error("falha")} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(/Código de suporte/)).not.toBeOnTheScreen();
  });

  it("TENTAR NOVAMENTE limpa o estado e chama onReset", async () => {
    const onReset = jest.fn();
    let shouldFail = true;
    function Maybe(): React.JSX.Element {
      if (shouldFail) throw new Error("falha");
      return <Text>conteúdo recuperado</Text>;
    }

    const view = await render(
      <ErrorBoundary onReset={onReset}>
        <Maybe />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).toBeOnTheScreen();

    shouldFail = false;
    await fireEvent.press(screen.getByText("TENTAR NOVAMENTE"));
    expect(onReset).toHaveBeenCalledTimes(1);

    await view.rerender(
      <ErrorBoundary onReset={onReset}>
        <Maybe />
      </ErrorBoundary>,
    );
    expect(screen.getByText("conteúdo recuperado")).toBeOnTheScreen();
  });
});

describe("translateApiError", () => {
  it("falha inesperada mostra mensagem em pt-BR e o código de suporte", () => {
    const error = new ApiError("INTERNAL_ERROR", "Erro interno.", 500, {
      requestId: "44444444-4444-4444-8444-444444444444",
      errorId: "55555555-5555-4555-8555-555555555555",
    });
    const message = translateApiError(error);
    expect(message).toContain("Erro interno. Tente novamente mais tarde.");
    expect(message).toContain("Código de suporte: 55555555-5555-4555-8555-555555555555");
  });

  it("erro esperado não recebe código de suporte", () => {
    const error = new ApiError("CHECKIN_NOT_FOUND", "x", 404, {
      requestId: "66666666-6666-4666-8666-666666666666",
    });
    expect(translateApiError(error)).toBe("Check-in não encontrado.");
  });

  it("erro que não é da API usa o fallback informado", () => {
    expect(translateApiError(new Error("x"), "Não foi possível carregar.")).toBe(
      "Não foi possível carregar.",
    );
    expect(translateApiError(undefined)).toBe("Algo deu errado. Tente novamente.");
  });
});
