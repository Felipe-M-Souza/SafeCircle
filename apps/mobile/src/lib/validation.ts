import { strings } from "../i18n/pt-BR";

/**
 * Validação de formulários no cliente (README §18).
 * O backend continua sendo a validação autoritativa; aqui melhoramos a UX.
 */
const v = strings.validation;

// Regex simples e suficiente para feedback de UX (não substitui o backend).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  } else if (password.length < 8) {
    errors.password = v.passwordMin;
  }
  if (confirmPassword !== password) {
    errors.confirmPassword = v.confirmPasswordMismatch;
  }
  return errors;
}
