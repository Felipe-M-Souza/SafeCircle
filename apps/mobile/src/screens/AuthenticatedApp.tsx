import { useEffect, useMemo, useState } from "react";
import type { Nav, Screen } from "../navigation/types";
import { consumePendingAlertId, subscribeAlertOpen } from "../notifications/pending-alert";
import { AuthenticatedHomeScreen } from "./AuthenticatedHomeScreen";
import { GroupsListScreen } from "./groups/GroupsListScreen";
import { CreateGroupScreen } from "./groups/CreateGroupScreen";
import { GroupDetailsScreen } from "./groups/GroupDetailsScreen";
import { InviteScreen } from "./groups/InviteScreen";
import { ReceivedInvitationsScreen } from "./groups/ReceivedInvitationsScreen";
import { ActiveAlertsScreen } from "./alerts/ActiveAlertsScreen";
import { AlertDetailsScreen } from "./alerts/AlertDetailsScreen";

/**
 * Navegação leve baseada em pilha para a área autenticada (Phase 2/3/4).
 * Mantém a solução simples, sem adicionar bibliotecas de navegação.
 *
 * Phase 4: uma notificação tocada abre a tela do alerta — na montagem (app
 * aberto pela notificação ou login após o toque) ou imediatamente, se a área
 * autenticada já estiver visível. A tela busca o alerta na API, que revalida
 * a autorização e devolve o estado atual (a notificação pode ser antiga).
 */
export function AuthenticatedApp(): React.JSX.Element {
  const [stack, setStack] = useState<Screen[]>(() => {
    const pendingAlertId = consumePendingAlertId();
    return pendingAlertId
      ? [{ name: "home" }, { name: "alertDetails", alertId: pendingAlertId }]
      : [{ name: "home" }];
  });

  useEffect(
    () =>
      subscribeAlertOpen((alertId) => {
        consumePendingAlertId();
        setStack((prev) => [...prev, { name: "alertDetails", alertId }]);
      }),
    [],
  );

  const nav = useMemo<Nav>(
    () => ({
      navigate: (screen) => setStack((prev) => [...prev, screen]),
      replace: (screen) => setStack((prev) => [...prev.slice(0, -1), screen]),
      goBack: () => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)),
      reset: (screen) => setStack([screen]),
    }),
    [],
  );

  const current = stack[stack.length - 1] ?? { name: "home" };

  switch (current.name) {
    case "groups":
      return <GroupsListScreen nav={nav} />;
    case "createGroup":
      return <CreateGroupScreen nav={nav} />;
    case "groupDetails":
      return <GroupDetailsScreen nav={nav} groupId={current.groupId} />;
    case "invite":
      return <InviteScreen nav={nav} groupId={current.groupId} groupName={current.groupName} />;
    case "invitations":
      return <ReceivedInvitationsScreen nav={nav} />;
    case "activeAlerts":
      return <ActiveAlertsScreen nav={nav} />;
    case "alertDetails":
      return (
        <AlertDetailsScreen
          nav={nav}
          alertId={current.alertId}
          justActivated={current.justActivated ?? false}
        />
      );
    case "home":
    default:
      return <AuthenticatedHomeScreen nav={nav} />;
  }
}
