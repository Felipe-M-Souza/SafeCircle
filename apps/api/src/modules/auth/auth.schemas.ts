import { z } from "zod";

/**
 * Schemas de validação da autenticação (README §7).
 * O e-mail é normalizado (trim + lowercase) e o nome tem trim aplicado.
 * O backend é a validação autoritativa.
 */

/**
 * Política de senha (Phase 11, ADR 0012): mínimo 12, máximo 128, sem regras
 * de composição. Comprimento é o que resiste a força bruta; exigir símbolo e
 * dígito só produz `Senha@123`. Passphrases são bem-vindas — o máximo existe
 * para limitar o custo do Argon2 e é **explícito**: nada é truncado em
 * silêncio, senha acima do limite é rejeitada.
 *
 * A política vale para senhas novas. Contas criadas com a política anterior
 * (mínimo 8) continuam entrando: o login não revalida comprimento mínimo.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Informe seu nome.").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  // Sem mínimo além de "não vazio": usuários antigos precisam continuar entrando.
  password: z.string().min(1, "Informe a senha.").max(PASSWORD_MAX_LENGTH),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token ausente."),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token ausente."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
