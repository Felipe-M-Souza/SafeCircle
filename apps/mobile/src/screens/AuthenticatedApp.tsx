import { useMemo, useState } from "react";
import type { Nav, Screen } from "../navigation/types";
import { AuthenticatedHomeScreen } from "./AuthenticatedHomeScreen";
import { GroupsListScreen } from "./groups/GroupsListScreen";
import { CreateGroupScreen } from "./groups/CreateGroupScreen";
import { GroupDetailsScreen } from "./groups/GroupDetailsScreen";
import { InviteScreen } from "./groups/InviteScreen";
import { ReceivedInvitationsScreen } from "./groups/ReceivedInvitationsScreen";

/**
 * Navegação leve baseada em pilha para a área autenticada (Phase 2).
 * Mantém a solução simples, sem adicionar bibliotecas de navegação.
 */
export function AuthenticatedApp(): React.JSX.Element {
  const [stack, setStack] = useState<Screen[]>([{ name: "home" }]);

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
    case "home":
    default:
      return <AuthenticatedHomeScreen nav={nav} />;
  }
}
