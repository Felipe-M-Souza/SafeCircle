/**
 * UUID v4 aleatório. Usa `crypto.randomUUID` quando disponível e, como
 * fallback, `Math.random` (suficiente para um identificador de instalação,
 * que não é um segredo nem um controle de segurança).
 */
export function randomUUID(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return template.replace(/[xy]/g, (char) => {
    if (char === "x") return hex();
    // Variante RFC 4122: 8, 9, a ou b.
    return (8 + Math.floor(Math.random() * 4)).toString(16);
  });
}
