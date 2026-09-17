/**
 * Tipos para imagens importadas como módulo (Metro devolve um id numérico de
 * asset; no Jest, `jest-expo` devolve um objeto). `expo-env.d.ts` é gerado e
 * não versionado, então a declaração vive aqui para typecheck e CI.
 */
declare module "*.png" {
  const asset: number;
  export default asset;
}
