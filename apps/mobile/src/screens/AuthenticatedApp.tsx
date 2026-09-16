import { useEffect, useMemo, useState } from "react";
import type { Nav, Screen } from "../navigation/types";
import {
  consumePendingTarget,
  subscribeNotificationOpen,
  type PendingTarget,
} from "../notifications/pending-alert";
import { AuthenticatedHomeScreen } from "./AuthenticatedHomeScreen";
import { GroupsListScreen } from "./groups/GroupsListScreen";
import { CreateGroupScreen } from "./groups/CreateGroupScreen";
import { GroupDetailsScreen } from "./groups/GroupDetailsScreen";
import { InviteScreen } from "./groups/InviteScreen";
import { ReceivedInvitationsScreen } from "./groups/ReceivedInvitationsScreen";
import { ActiveAlertsScreen } from "./alerts/ActiveAlertsScreen";
import { AlertDetailsScreen } from "./alerts/AlertDetailsScreen";
import { NewCheckinScreen } from "./checkins/NewCheckinScreen";
import { CheckinDetailsScreen } from "./checkins/CheckinDetailsScreen";
import { GroupCheckinsScreen } from "./checkins/GroupCheckinsScreen";
import { NewJourneyScreen } from "./journeys/NewJourneyScreen";
import { JourneyDetailsScreen } from "./journeys/JourneyDetailsScreen";
import { GroupJourneysScreen } from "./journeys/GroupJourneysScreen";
import { DeleteAccountScreen } from "./account/DeleteAccountScreen";

function screenFor(target: PendingTarget): Screen {
  if (target.kind === "alert") return { name: "alertDetails", alertId: target.alertId };
  if (target.kind === "journey") return { name: "journeyDetails", journeyId: target.journeyId };
  return { name: "checkinDetails", checkinId: target.checkinId };
}

/**
 * Navegação leve baseada em pilha para a área autenticada (Phases 2–7).
 * Mantém a solução simples, sem adicionar bibliotecas de navegação.
 *
 * Uma notificação tocada (alerta ou check-in vencido) abre a tela do
 * recurso — na montagem (app aberto pela notificação ou login após o toque)
 * ou imediatamente, se a área autenticada já estiver visível. A tela busca o
 * estado atual na API, que revalida a autorização.
 */
export function AuthenticatedApp(): React.JSX.Element {
  const [stack, setStack] = useState<Screen[]>(() => {
    const pending = consumePendingTarget();
    return pending ? [{ name: "home" }, screenFor(pending)] : [{ name: "home" }];
  });

  useEffect(
    () =>
      subscribeNotificationOpen((target) => {
        consumePendingTarget();
        setStack((prev) => [...prev, screenFor(target)]);
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
    case "newCheckin":
      return <NewCheckinScreen nav={nav} />;
    case "checkinDetails":
      return <CheckinDetailsScreen nav={nav} checkinId={current.checkinId} />;
    case "groupCheckins":
      return (
        <GroupCheckinsScreen nav={nav} groupId={current.groupId} groupName={current.groupName} />
      );
    case "newJourney":
      return <NewJourneyScreen nav={nav} />;
    case "journeyDetails":
      return <JourneyDetailsScreen nav={nav} journeyId={current.journeyId} />;
    case "groupJourneys":
      return (
        <GroupJourneysScreen nav={nav} groupId={current.groupId} groupName={current.groupName} />
      );
    case "deleteAccount":
      return <DeleteAccountScreen nav={nav} />;
    case "home":
    default:
      return <AuthenticatedHomeScreen nav={nav} />;
  }
}
