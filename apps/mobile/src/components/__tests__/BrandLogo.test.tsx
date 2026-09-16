import { render, screen } from "@testing-library/react-native";
import { BRAND_LOGO_ASPECT, BrandLogo } from "../BrandLogo";

describe("BrandLogo", () => {
  it("renderiza a imagem do logo com rótulo acessível 'SafeCircle' e proporção do recorte", async () => {
    await render(<BrandLogo width={200} />);
    const logo = await screen.findByTestId("brand-logo");
    expect(logo).toBeOnTheScreen();
    expect(screen.getByLabelText("SafeCircle")).toBe(logo);
    expect(logo.props.accessibilityRole).toBe("image");
    expect(logo.props.resizeMode).toBe("contain");

    const flat = Object.assign({}, ...[logo.props.style].flat(Infinity).filter(Boolean));
    expect(flat.width).toBe(200);
    expect(flat.height).toBe(Math.round(200 / BRAND_LOGO_ASPECT));
  });
});
