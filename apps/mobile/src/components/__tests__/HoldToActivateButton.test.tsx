import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { DEFAULT_HOLD_DURATION_MS, HoldToActivateButton } from "../HoldToActivateButton";

const props = {
  label: "SEGURE PARA PEDIR AJUDA",
  hint: "Mantenha pressionado para ativar.",
  accessibilityLabel: "Pedir ajuda",
  accessibilityHint: "Mantenha pressionado por dois segundos.",
};

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("HoldToActivateButton (pressionar e segurar)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("não aciona antes do tempo completo", async () => {
    const onActivate = jest.fn();
    await render(<HoldToActivateButton {...props} onActivate={onActivate} />);

    await fireEvent(screen.getByTestId("sos-button"), "pressIn");
    await advance(DEFAULT_HOLD_DURATION_MS - 1);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("soltar antes do tempo cancela o acionamento", async () => {
    const onActivate = jest.fn();
    await render(<HoldToActivateButton {...props} onActivate={onActivate} />);

    const button = screen.getByTestId("sos-button");
    await fireEvent(button, "pressIn");
    await advance(1000);
    await fireEvent(button, "pressOut");
    await advance(5000);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("segurar pelo tempo completo aciona exatamente uma vez", async () => {
    const onActivate = jest.fn();
    await render(<HoldToActivateButton {...props} onActivate={onActivate} />);

    const button = screen.getByTestId("sos-button");
    await fireEvent(button, "pressIn");
    await advance(DEFAULT_HOLD_DURATION_MS);
    expect(onActivate).toHaveBeenCalledTimes(1);

    // Continuar segurando ou soltar depois não dispara de novo.
    await advance(5000);
    await fireEvent(button, "pressOut");
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("um novo pressIn durante o mesmo toque não reinicia nem duplica", async () => {
    const onActivate = jest.fn();
    await render(<HoldToActivateButton {...props} onActivate={onActivate} />);

    const button = screen.getByTestId("sos-button");
    await fireEvent(button, "pressIn");
    await advance(1500);
    await fireEvent(button, "pressIn");
    await advance(500);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("mostra progresso enquanto pressionado e zera ao soltar", async () => {
    await render(<HoldToActivateButton {...props} onActivate={jest.fn()} />);
    const button = screen.getByTestId("sos-button");
    const progress = screen.getByTestId("sos-button-progress");

    expect(progress).toHaveStyle({ width: "0%" });
    await fireEvent(button, "pressIn");
    await advance(1000);
    expect(progress).toHaveStyle({ width: "50%" });

    await fireEvent(button, "pressOut");
    expect(progress).toHaveStyle({ width: "0%" });
  });

  it("ocupado ou desabilitado não aciona e exibe o texto de ocupado", async () => {
    const onActivate = jest.fn();
    await render(
      <HoldToActivateButton
        {...props}
        onActivate={onActivate}
        busy
        busyLabel="Ativando alerta..."
      />,
    );

    expect(screen.getByText("Ativando alerta...")).toBeOnTheScreen();
    expect(screen.getByTestId("sos-button")).toBeBusy();
    expect(screen.getByTestId("sos-button")).toBeDisabled();

    await fireEvent(screen.getByTestId("sos-button"), "pressIn");
    await advance(DEFAULT_HOLD_DURATION_MS + 500);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("textos e acessibilidade em pt-BR", async () => {
    await render(<HoldToActivateButton {...props} onActivate={jest.fn()} />);
    expect(screen.getByText("SEGURE PARA PEDIR AJUDA")).toBeOnTheScreen();
    expect(screen.getByText("Mantenha pressionado para ativar.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Pedir ajuda" })).toBeOnTheScreen();
  });
});
