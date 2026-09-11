import { hash, verify } from "@node-rs/argon2";

/**
 * Hash e verificação de senha usando Argon2id (README §13 / ADR 0002).
 *
 * O algoritmo padrão do @node-rs/argon2 é o Argon2id (garantido pelo teste que
 * verifica o prefixo `$argon2id$`). Parâmetros baseados nas recomendações do
 * OWASP. Não registrar senha nem hash em logs; o hash é auto-contido.
 */
const argon2Options = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, argon2Options);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
