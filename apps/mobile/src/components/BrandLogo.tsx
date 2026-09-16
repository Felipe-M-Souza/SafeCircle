import { Image, StyleSheet, type ImageStyle, type StyleProp } from "react-native";
import logo from "../../assets/logo.png";
import { strings } from "../i18n/pt-BR";

interface BrandLogoProps {
  /** Largura em dp; a altura segue a proporção do logo (≈ 2,96:1). */
  width?: number;
  style?: StyleProp<ImageStyle>;
}

/** Proporção medida do logo recortado (`assets/brand/generated.json`). */
export const BRAND_LOGO_ASPECT = 2.9558;

/**
 * Logo do SafeCircle (imagem gerada por `scripts/brand-assets.mjs`). Substitui
 * o texto da marca nas telas; leitores de tela continuam ouvindo "SafeCircle".
 */
export function BrandLogo({ width = 220, style }: BrandLogoProps): React.JSX.Element {
  return (
    <Image
      source={logo}
      style={[styles.logo, { width, height: Math.round(width / BRAND_LOGO_ASPECT) }, style]}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel={strings.common.appName}
      testID="brand-logo"
    />
  );
}

const styles = StyleSheet.create({
  logo: { alignSelf: "center" },
});
