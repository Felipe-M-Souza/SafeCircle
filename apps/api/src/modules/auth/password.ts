import { hash, verify } from "@node-rs/argon2";

/**
 * Hash e verificação de senha usando Argon2id (README §13 / ADR 0002).
 *
 * O algoritmo padrão do @node-rs/argon2 é o Argon2id (garantido pelo teste que
 * verifica o prefixo `$argon2id$`). Parâmetros baseados nas recomendações do
 * OWASP. Não registrar senha nem hash em logs; o hash é auto-contido.
 */
/**
 * Parâmetros do Argon2id, centralizados e exportados (Phase 11): o teste de
 * segurança confere que o hash gravado carrega exatamente estes valores, o que
 * impede que alguém reduza o custo "só em dev" e esqueça. São os parâmetros da
 * recomendação OWASP (19 MiB, 2 iterações, 1 thread) — nenhum benchmark
 * próprio foi executado para ajustá-los.
 */
export const ARGON2_PARAMS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

const argon2Options = ARGON2_PARAMS;

/** Prefixo PHC do Argon2id com os parâmetros deste módulo. */
export const ARGON2ID_HASH_PREFIX = `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`;

/** Verdadeiro quando o hash é Argon2id gerado com os parâmetros atuais. */
export function isArgon2idHash(value: string): boolean {
  return value.startsWith(ARGON2ID_HASH_PREFIX);
}

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
