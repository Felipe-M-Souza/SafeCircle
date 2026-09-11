export type Screen =
  | { name: "home" }
  | { name: "groups" }
  | { name: "createGroup" }
  | { name: "groupDetails"; groupId: string }
  | { name: "invite"; groupId: string; groupName: string }
  | { name: "invitations" }
  // Phase 3 — Alerta de Emergência
  | { name: "activeAlerts" }
  | { name: "alertDetails"; alertId: string; justActivated?: boolean };

export interface Nav {
  navigate: (screen: Screen) => void;
  replace: (screen: Screen) => void;
  goBack: () => void;
  reset: (screen: Screen) => void;
}
