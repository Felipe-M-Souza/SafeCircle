import { createHash, randomBytes } from "node:crypto";

/**
 * Geração e hashing do refresh token (README §4 / ADR 0002).
 *
 * O refresh token é OPACO e criptograficamente aleatório (alta entropia).
 * No banco armazenamos somente seu hash SHA-256 (determinístico, adequado para
 * comparação por lookup). O token em texto puro nunca é persistido.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Claims do access token JWT (README §4): sem dados pessoais. */
export interface AccessTokenClaims {
  sub: string; // ID do usuário
  sid: string; // ID da sessão
}
