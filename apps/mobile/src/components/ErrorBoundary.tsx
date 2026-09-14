import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { strings } from "../i18n/pt-BR";
import { ApiError } from "../lib/api";
import { colors } from "../theme/colors";

/**
 * Error Boundary global (Phase 9).
 *
 * Uma falha de renderização não pode deixar o app em tela branca — num produto
 * de segurança, a pessoa precisa conseguir voltar e pedir ajuda. Mostra uma
 * mensagem sóbria, um código de suporte quando existir e um botão para tentar
 * de novo. NUNCA exibe stack trace, nome de arquivo ou mensagem crua: isso é
 * ruído para o usuário e superfície de informação para quem não deveria vê-la.
 *
 * Detalhes técnicos vão para o console apenas em desenvolvimento (`__DEV__`);
 * não há analytics nem envio automático de telemetria.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Chamado ao tocar em "Tentar novamente" (ex.: voltar para a Home). */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  supportCode?: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // Erros vindos da API já carregam correlação com o log do servidor.
    const supportCode = error instanceof ApiError ? error.supportCode : undefined;
    return supportCode ? { hasError: true, supportCode } : { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (__DEV__) {
      // Somente em desenvolvimento: nada é registrado em produção.
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, supportCode: undefined });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const t = strings.errorBoundary;
    return (
      <View style={styles.container} testID="error-boundary">
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            {t.title}
          </Text>
          <Text style={styles.body}>{t.body}</Text>
          {this.state.supportCode ? (
            <Text style={styles.supportCode} selectable>
              {t.supportCode(this.state.supportCode)}
            </Text>
          ) : null}
          <Pressable style={styles.button} onPress={this.handleReset} accessibilityRole="button">
            <Text style={styles.buttonText}>{t.retry}</Text>
          </Pressable>
          <Text style={styles.disclaimer}>{strings.home.disclaimer}</Text>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 28,
    gap: 14,
  },
  title: { color: colors.primaryText, fontSize: 22, fontWeight: "800" },
  body: { color: colors.primaryText, fontSize: 15, lineHeight: 22 },
  supportCode: { color: colors.mutedText, fontSize: 13, fontFamily: undefined },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  buttonText: { color: colors.primaryText, fontSize: 16, fontWeight: "800" },
  disclaimer: { color: colors.mutedText, fontSize: 12, lineHeight: 18 },
});
