import appJson from "../../app.json";
import googleServices from "../../google-services.json";

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
    android?: {
      package?: string;
      googleServicesFile?: string;
      config?: { googleMaps?: { apiKey?: string } };
    };
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

/**
 * Coerência do Firebase (achado em aparelho, 2026-09-18): sem
 * `google-services.json` o push no Android falha na obtenção do token, e o
 * sintoma é silêncio — nenhum aparelho se cadastra e nada é enviado.
 *
 * Dois desencontros produzem exatamente esse mesmo silêncio: o arquivo
 * declarado mas ausente, e o arquivo presente mas de outro projeto ou de outro
 * pacote. Um arquivo do projeto errado é o pior dos dois, porque parece certo.
 */
describe("app.json — Firebase", () => {
  it("declara o google-services.json, necessário para o push no Android", () => {
    expect(expo.android?.googleServicesFile).toBe("./google-services.json");
  });

  it("o pacote dentro do google-services.json bate com o do app.json", () => {
    // Importado, e nao lido do disco: sem o arquivo o proprio build falha, e
    // o tsconfig do app nao expoe tipos do Node de proposito.
    const services = googleServices as unknown as {
      project_info: { project_id: string };
      client: { client_info: { android_client_info: { package_name: string } } }[];
    };

    const pacotes = services.client.map((c) => c.client_info.android_client_info.package_name);
    expect(pacotes).toContain(expo.android?.package);
    expect(services.project_info.project_id.length).toBeGreaterThan(0);
  });
});
