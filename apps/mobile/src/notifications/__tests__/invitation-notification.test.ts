import {
  GROUP_INVITATION_NOTIFICATION_TYPE,
  parseNotificationData,
} from "../notifications.service";
import {
  consumePendingTarget,
  openInvitationsFromNotification,
  subscribeNotificationOpen,
} from "../pending-alert";

/**
 * Notificação de convite (Phase 13): o toque leva a "Convites recebidos".
 * O payload carrega só IDs — nunca e-mail, nome ou qualquer dado pessoal.
 */
describe("Notificação de convite", () => {
  it("interpreta o payload do convite e ignora o que estiver incompleto", () => {
    expect(
      parseNotificationData({
        type: GROUP_INVITATION_NOTIFICATION_TYPE,
        invitationId: "inv-1",
        groupId: "grp-1",
      }),
    ).toEqual({
      type: GROUP_INVITATION_NOTIFICATION_TYPE,
      invitationId: "inv-1",
      groupId: "grp-1",
    });

    expect(parseNotificationData({ type: GROUP_INVITATION_NOTIFICATION_TYPE })).toBeNull();
    expect(
      parseNotificationData({ type: GROUP_INVITATION_NOTIFICATION_TYPE, invitationId: "" }),
    ).toBeNull();
  });

  it("o toque publica a intenção de abrir a lista de convites", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeNotificationOpen((target) => seen.push(target));

    openInvitationsFromNotification("inv-42");

    expect(seen).toEqual([{ kind: "invitations", invitationId: "inv-42" }]);
    expect(consumePendingTarget()).toEqual({ kind: "invitations", invitationId: "inv-42" });
    // Consumida uma vez só: abrir o app de novo não repete a navegação.
    expect(consumePendingTarget()).toBeNull();
    unsubscribe();
  });
});
