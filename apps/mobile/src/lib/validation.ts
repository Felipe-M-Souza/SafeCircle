import { strings } from "../i18n/pt-BR";

/**
 * Validação de formulários no cliente (README §18).
 * O backend continua sendo a validação autoritativa; aqui melhoramos a UX.
 */
const v = strings.validation;

// Regex simples e suficiente para feedback de UX (não substitui o backend).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Política de senha espelhada da API (Phase 11): comprimento, sem regras de
 * composição. Vale para senhas novas; o login não valida comprimento mínimo.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return v.emailRequired;
  if (!EMAIL_REGEX.test(value)) return v.emailInvalid;
  return null;
}

export function validateLogin(email: string, password: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;
  if (!password) errors.password = v.passwordRequired;
  return errors;
}

export function validateRegister(
  name: string,
  email: string,
  password: string,
  confirmPassword: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = v.nameRequired;
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;
  if (!password) {
    errors.password = v.passwordRequired;
  } else if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = v.passwordMin;
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.password = v.passwordMax;
  }
  if (confirmPassword !== password) {
    errors.confirmPassword = v.confirmPasswordMismatch;
  }
  return errors;
}
