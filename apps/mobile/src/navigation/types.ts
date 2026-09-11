export type Screen =
  | { name: "home" }
  | { name: "groups" }
  | { name: "createGroup" }
  | { name: "groupDetails"; groupId: string }
  | { name: "invite"; groupId: string; groupName: string }
  | { name: "invitations" };

export interface Nav {
  navigate: (screen: Screen) => void;
  replace: (screen: Screen) => void;
  goBack: () => void;
  reset: (screen: Screen) => void;
}
