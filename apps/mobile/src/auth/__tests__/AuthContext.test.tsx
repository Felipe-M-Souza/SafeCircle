import { Pressable, Text } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ApiClient } from "../../lib/api";
import { AuthProvider, useAuth } from "../AuthContext";

function Consumer(): React.JSX.Element {
  const { status, signOut } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Pressable testID="sign-out" onPress={() => void signOut()}>
        <Text>Sair</Text>
      </Pressable>
    </>
  );
}

describe("AuthProvider — logout e push device", () => {
  it("executa beforeSignOut com o cliente da API antes de encerrar a sessão", async () => {
    const beforeSignOut = jest.fn<Promise<void>, [ApiClient]>(async () => undefined);
    await render(
      <AuthProvider beforeSignOut={beforeSignOut}>
        <Consumer />
      </AuthProvider>,
    );
    expect(await screen.findByText("unauthenticated")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("sign-out"));

    await waitFor(() => expect(beforeSignOut).toHaveBeenCalledTimes(1));
    const api = beforeSignOut.mock.calls[0]?.[0];
    expect(typeof api?.unregisterPushDevice).toBe("function");
    expect(screen.getByText("unauthenticated")).toBeOnTheScreen();
  });

  it("falha ao desregistrar o push device não impede o logout", async () => {
    const beforeSignOut = jest.fn(async () => {
      throw new Error("push offline");
    });
    await render(
      <AuthProvider beforeSignOut={beforeSignOut}>
        <Consumer />
      </AuthProvider>,
    );
    expect(await screen.findByText("unauthenticated")).toBeOnTheScreen();

    await expect(fireEvent.press(screen.getByTestId("sign-out"))).resolves.not.toThrow();
    await waitFor(() => expect(beforeSignOut).toHaveBeenCalledTimes(1));
    expect(screen.getByText("unauthenticated")).toBeOnTheScreen();
  });
});
