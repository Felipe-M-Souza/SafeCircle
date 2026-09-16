import appJson from "../../app.json";

/**
 * Coerência do `app.json` (achado em aparelho, 2026-09-16): o app decide se
 * pode montar o mapa nativo pelo sinalizador público
 * `extra.googleMapsApiKeyConfigured`, porque o Expo remove `android.config` da
 * configuração pública. Este teste impede que os dois saiam de sincronia: chave
 * presente ⇔ sinalizador `true`. Sem isso, ou o app fecha (mapa sem chave) ou
 * esconde um mapa que funcionaria.
 */
type AppJson = {
  expo: {
    android?: { config?: { googleMaps?: { apiKey?: string } } };
    extra?: { googleMapsApiKeyConfigured?: unknown };
  };
};

const expo = (appJson as AppJson).expo;

describe("app.json — Google Maps", () => {
  it("extra.googleMapsApiKeyConfigured espelha a presença de android.config.googleMaps.apiKey", () => {
    const key = expo.android?.config?.googleMaps?.apiKey ?? "";
    const configured = key.trim().length > 0;
    expect(expo.extra?.googleMapsApiKeyConfigured).toBe(configured);
  });

  it("a chave, quando existe, tem o formato de uma chave de API do Google (pública, restrita ao pacote)", () => {
    const key = expo.android?.config?.googleMaps?.apiKey ?? "";
    if (key.length === 0) return;
    expect(key).toMatch(/^AIza[0-9A-Za-z_-]{35}$/);
  });
});
