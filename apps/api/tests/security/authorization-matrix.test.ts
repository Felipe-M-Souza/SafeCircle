import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createTestApp } from "../helpers/app.js";
import { createCleaner } from "../helpers/test-db.js";
import { authHeaders, registerUser, sessionIdOf, type TestUser } from "../helpers/auth.js";
import { addMember, createGroup, setRole } from "../helpers/groups.js";
import { createAlert, SYNTHETIC_LOCATION } from "../helpers/alerts.js";
import { createCheckin } from "../helpers/checkins.js";
import { createJourney } from "../helpers/journeys.js";
import { registerActiveDevice } from "../helpers/push.js";
import { errorBodyWithoutRequestId } from "../helpers/errors.js";
import { drainOutbox } from "../helpers/outbox.js";

/**
 * Matriz de autorização regressiva (Phase 11), table-driven.
 *
 * Papéis:
 *   owner     — dona do grupo e de todos os recursos
 *   admin     — ADMIN do grupo
 *   member    — MEMBER do grupo
 *   exMember  — foi MEMBER e saiu
 *   outsider  — autenticado, nunca foi membro
 *
 * Regras (docs/security/authorization-matrix.md):
 *   - quem não é membro recebe 404 (anti-IDOR): a existência não é confirmada;
 *   - membro sem papel/autoria recebe 403: a existência já é conhecida;
 *   - ex-membro perde acesso na hora, como se nunca tivesse sido.
 */
const cleaner = createCleaner();
let app: FastifyInstance;

interface Ctx {
  owner: TestUser;
  admin: TestUser;
  member: TestUser;
  exMember: TestUser;
  outsider: TestUser;
  otherAdmin: TestUser;
  groupId: string;
  alertId: string;
  checkinId: string;
  journeyId: string;
  invitationId: string;
  ownerDeviceId: string;
}
let ctx: Ctx;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  const owner = await registerUser(app, { name: "Dona" });
  const admin = await registerUser(app, { name: "Admin" });
  const otherAdmin = await registerUser(app, { name: "Admin Dois" });
  const member = await registerUser(app, { name: "Membro" });
  const exMember = await registerUser(app, { name: "Ex-membro" });
  const outsider = await registerUser(app, { name: "Externo" });
  const groupId = await createGroup(app, owner, "Família");
  for (const user of [admin, otherAdmin, member, exMember]) {
    await addMember(app, owner, groupId, user);
  }
  await setRole(app, owner, groupId, admin, "ADMIN");
  await setRole(app, owner, groupId, otherAdmin, "ADMIN");

  const alert = await createAlert(app, owner, groupId, SYNTHETIC_LOCATION);
  await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/live-location/start`,
    headers: authHeaders(owner),
  });
  const checkin = await createCheckin(app, owner, groupId);
  const journey = await createJourney(app, owner, groupId, { liveLocationEnabled: true });
  await app.inject({
    method: "POST",
    url: `/journeys/${journey.id}/live-location/start`,
    headers: authHeaders(owner),
  });
  const invitation = await app.inject({
    method: "POST",
    url: `/groups/${groupId}/invitations`,
    headers: authHeaders(owner),
    payload: { email: `convidado-${randomUUID()}@example.com` },
  });
  const ownerDevice = await registerActiveDevice(app, owner);

  // O ex-membro sai depois de ter tido acesso a tudo.
  const left = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/members/me`,
    headers: authHeaders(exMember),
  });
  expect(left.statusCode).toBe(204);
  await drainOutbox(app);

  ctx = {
    owner,
    admin,
    otherAdmin,
    member,
    exMember,
    outsider,
    groupId,
    alertId: alert.id as string,
    checkinId: checkin.id as string,
    journeyId: journey.id as string,
    invitationId: invitation.json().id as string,
    ownerDeviceId: ownerDevice.deviceId,
  };
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface Endpoint {
  name: string;
  method: Method;
  url: (c: Ctx) => string;
  body?: (c: Ctx) => unknown;
  headers?: () => Record<string, string>;
  /** Código esperado quando o ator não é membro (anti-IDOR). */
  notFoundCode: string;
  /** Código e status quando um MEMBER sem autoria/papel tenta (BFLA). */
  memberDenied?: { status: number; code: string };
  /** Quando MEMBER pode executar (leitura legítima). */
  memberAllowed?: number;
}

const point = () => ({
  clientUpdateId: randomUUID(),
  latitude: -23.5,
  longitude: -46.6,
  accuracy: 8,
  capturedAt: new Date().toISOString(),
});
const idem = () => ({ "idempotency-key": randomUUID() });

const ENDPOINTS: Endpoint[] = [
  // --- Grupos e memberships ---
  {
    name: "ler grupo",
    method: "GET",
    url: (c) => `/groups/${c.groupId}`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "listar membros",
    method: "GET",
    url: (c) => `/groups/${c.groupId}/members`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "renomear grupo",
    method: "PATCH",
    url: (c) => `/groups/${c.groupId}`,
    body: () => ({ name: "Invadido" }),
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  {
    name: "remover membro",
    method: "DELETE",
    url: (c) => `/groups/${c.groupId}/members/${c.admin.userId}`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  {
    name: "alterar papel",
    method: "PATCH",
    url: (c) => `/groups/${c.groupId}/members/${c.admin.userId}/role`,
    body: () => ({ role: "MEMBER" }),
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  // --- Convites ---
  {
    name: "criar convite",
    method: "POST",
    url: (c) => `/groups/${c.groupId}/invitations`,
    body: () => ({ email: `x-${randomUUID()}@example.com` }),
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  {
    name: "listar convites",
    method: "GET",
    url: (c) => `/groups/${c.groupId}/invitations`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  {
    name: "revogar convite",
    method: "DELETE",
    url: (c) => `/groups/${c.groupId}/invitations/${c.invitationId}`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberDenied: { status: 403, code: "INSUFFICIENT_GROUP_ROLE" },
  },
  // --- Alertas ---
  {
    name: "ler alerta",
    method: "GET",
    url: (c) => `/alerts/${c.alertId}`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "resolver alerta",
    method: "POST",
    url: (c) => `/alerts/${c.alertId}/resolve`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "cancelar alerta",
    method: "POST",
    url: (c) => `/alerts/${c.alertId}/cancel`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "listar confirmações",
    method: "GET",
    url: (c) => `/alerts/${c.alertId}/acknowledgements`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "confirmar alerta",
    method: "PUT",
    url: (c) => `/alerts/${c.alertId}/acknowledgement`,
    body: () => ({ type: "SEEN" }),
    notFoundCode: "ALERT_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "iniciar localização do alerta",
    method: "POST",
    url: (c) => `/alerts/${c.alertId}/live-location/start`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "enviar ponto do alerta",
    method: "POST",
    url: (c) => `/alerts/${c.alertId}/live-location`,
    body: point,
    notFoundCode: "ALERT_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "encerrar localização do alerta",
    method: "POST",
    url: (c) => `/alerts/${c.alertId}/live-location/stop`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "ler localização do alerta",
    method: "GET",
    url: (c) => `/alerts/${c.alertId}/live-location`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "histórico de localização do alerta",
    method: "GET",
    url: (c) => `/alerts/${c.alertId}/live-location/history`,
    notFoundCode: "ALERT_NOT_FOUND",
    memberAllowed: 200,
  },
  // --- Check-ins ---
  {
    name: "ler check-in",
    method: "GET",
    url: (c) => `/checkins/${c.checkinId}`,
    notFoundCode: "CHECKIN_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "confirmar check-in alheio",
    method: "POST",
    url: (c) => `/checkins/${c.checkinId}/safe`,
    notFoundCode: "CHECKIN_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "cancelar check-in alheio",
    method: "POST",
    url: (c) => `/checkins/${c.checkinId}/cancel`,
    notFoundCode: "CHECKIN_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "check-ins do grupo",
    method: "GET",
    url: (c) => `/groups/${c.groupId}/checkins`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberAllowed: 200,
  },
  // --- Trajetos ---
  {
    name: "ler trajeto",
    method: "GET",
    url: (c) => `/journeys/${c.journeyId}`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "confirmar chegada alheia",
    method: "POST",
    url: (c) => `/journeys/${c.journeyId}/arrive`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "cancelar trajeto alheio",
    method: "POST",
    url: (c) => `/journeys/${c.journeyId}/cancel`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "iniciar localização do trajeto",
    method: "POST",
    url: (c) => `/journeys/${c.journeyId}/live-location/start`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "enviar ponto do trajeto",
    method: "POST",
    url: (c) => `/journeys/${c.journeyId}/live-location`,
    body: point,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "encerrar localização do trajeto",
    method: "POST",
    url: (c) => `/journeys/${c.journeyId}/live-location/stop`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberDenied: { status: 403, code: "FORBIDDEN" },
  },
  {
    name: "ler localização do trajeto",
    method: "GET",
    url: (c) => `/journeys/${c.journeyId}/live-location`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "histórico do trajeto",
    method: "GET",
    url: (c) => `/journeys/${c.journeyId}/live-location/history`,
    notFoundCode: "JOURNEY_NOT_FOUND",
    memberAllowed: 200,
  },
  {
    name: "trajetos do grupo",
    method: "GET",
    url: (c) => `/groups/${c.groupId}/journeys`,
    notFoundCode: "GROUP_NOT_FOUND",
    memberAllowed: 200,
  },
];

async function call(actor: TestUser, endpoint: Endpoint) {
  const headers: Record<string, string> = {
    ...authHeaders(actor),
    ...(endpoint.method === "POST" ? idem() : {}),
  };
  const options: InjectOptions = { method: endpoint.method, url: endpoint.url(ctx), headers };
  if (endpoint.body) {
    options.payload = endpoint.body(ctx) as InjectOptions["payload"];
  }
  return app.inject(options);
}

describe("Anti-IDOR: quem não é membro recebe 404 indistinguível de inexistente", () => {
  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name}: externo e ex-membro → 404 ${endpoint.notFoundCode}`, async () => {
      for (const actor of [ctx.outsider, ctx.exMember]) {
        const res = await call(actor, endpoint);
        expect(res.statusCode, `${actor.name} em ${endpoint.name}`).toBe(404);
        expect(res.json().code, `${actor.name} em ${endpoint.name}`).toBe(endpoint.notFoundCode);
      }
    });
  }

  it("a resposta para recurso alheio é idêntica à de recurso inexistente", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: `/alerts/${ctx.alertId}`,
      headers: authHeaders(ctx.outsider),
    });
    const missing = await app.inject({
      method: "GET",
      url: `/alerts/${randomUUID()}`,
      headers: authHeaders(ctx.outsider),
    });
    expect(errorBodyWithoutRequestId(forbidden)).toEqual(errorBodyWithoutRequestId(missing));
  });

  it("nada mudou depois das tentativas: alerta ACTIVE, check-in ACTIVE, trajeto ACTIVE, grupo intacto", async () => {
    for (const endpoint of ENDPOINTS.filter((e) => e.method !== "GET")) {
      await call(ctx.outsider, endpoint);
      await call(ctx.exMember, endpoint);
    }
    const alert = await app.inject({
      method: "GET",
      url: `/alerts/${ctx.alertId}`,
      headers: authHeaders(ctx.owner),
    });
    const checkin = await app.inject({
      method: "GET",
      url: `/checkins/${ctx.checkinId}`,
      headers: authHeaders(ctx.owner),
    });
    const journey = await app.inject({
      method: "GET",
      url: `/journeys/${ctx.journeyId}`,
      headers: authHeaders(ctx.owner),
    });
    const group = await app.inject({
      method: "GET",
      url: `/groups/${ctx.groupId}`,
      headers: authHeaders(ctx.owner),
    });
    expect(alert.json().status).toBe("ACTIVE");
    expect(checkin.json().status).toBe("ACTIVE");
    expect(journey.json().status).toBe("ACTIVE");
    expect(group.json().name).toBe("Família");
    const [points] = await cleaner.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM alert_location_updates`;
    expect(points?.count).toBe(0);
  });

  it("listagens do externo não incluem nada do grupo", async () => {
    for (const url of ["/alerts", "/checkins", "/journeys", "/groups"]) {
      const res = await app.inject({ method: "GET", url, headers: authHeaders(ctx.outsider) });
      expect(res.statusCode, url).toBe(200);
      expect(JSON.stringify(res.json()), url).not.toContain(ctx.groupId);
    }
  });
});

describe("Broken Function Level Authorization: membro não executa ação de dono/admin", () => {
  for (const endpoint of ENDPOINTS.filter((e) => e.memberDenied)) {
    it(`${endpoint.name}: MEMBER → ${endpoint.memberDenied!.status} ${endpoint.memberDenied!.code}`, async () => {
      const res = await call(ctx.member, endpoint);
      expect(res.statusCode).toBe(endpoint.memberDenied!.status);
      expect(res.json().code).toBe(endpoint.memberDenied!.code);
    });
  }

  for (const endpoint of ENDPOINTS.filter((e) => e.memberAllowed)) {
    it(`${endpoint.name}: MEMBER pode (${endpoint.memberAllowed})`, async () => {
      const res = await call(ctx.member, endpoint);
      expect(res.statusCode).toBe(endpoint.memberAllowed);
    });
  }

  it("ADMIN não altera papéis nem remove OWNER ou outro ADMIN", async () => {
    const role = await app.inject({
      method: "PATCH",
      url: `/groups/${ctx.groupId}/members/${ctx.member.userId}/role`,
      headers: authHeaders(ctx.admin),
      payload: { role: "ADMIN" },
    });
    expect(role.statusCode).toBe(403);

    const removeOwner = await app.inject({
      method: "DELETE",
      url: `/groups/${ctx.groupId}/members/${ctx.owner.userId}`,
      headers: authHeaders(ctx.admin),
    });
    expect(removeOwner.statusCode).toBe(403);
    expect(removeOwner.json().code).toBe("CANNOT_REMOVE_OWNER");

    const removeAdmin = await app.inject({
      method: "DELETE",
      url: `/groups/${ctx.groupId}/members/${ctx.otherAdmin.userId}`,
      headers: authHeaders(ctx.admin),
    });
    expect(removeAdmin.statusCode).toBe(403);
  });

  it("ninguém desativa o push device de outro usuário nem revoga sessão alheia", async () => {
    for (const actor of [ctx.member, ctx.admin, ctx.outsider]) {
      const device = await app.inject({
        method: "DELETE",
        url: `/me/push-devices/${ctx.ownerDeviceId}`,
        headers: authHeaders(actor),
      });
      expect(device.statusCode).toBe(404);
      expect(device.json().code).toBe("PUSH_DEVICE_NOT_FOUND");

      const session = await app.inject({
        method: "DELETE",
        url: `/me/sessions/${sessionIdOf(ctx.owner)}`,
        headers: authHeaders(actor),
      });
      expect(session.statusCode).toBe(404);
      expect(session.json().code).toBe("SESSION_NOT_FOUND");
    }
    const ownerStillIn = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeaders(ctx.owner),
    });
    expect(ownerStillIn.statusCode).toBe(200);
    const [device] = await cleaner.sql<{ is_active: boolean }[]>`
      SELECT is_active FROM push_devices WHERE device_id = ${ctx.ownerDeviceId}
    `;
    expect(device?.is_active).toBe(true);
  });

  it("convite alheio não é aceito nem recusado por quem não é o convidado", async () => {
    for (const actor of [ctx.member, ctx.outsider]) {
      const accept = await app.inject({
        method: "POST",
        url: `/me/group-invitations/${ctx.invitationId}/accept`,
        headers: authHeaders(actor),
      });
      expect([403, 404]).toContain(accept.statusCode);
      const reject = await app.inject({
        method: "POST",
        url: `/me/group-invitations/${ctx.invitationId}/reject`,
        headers: authHeaders(actor),
      });
      expect([403, 404]).toContain(reject.statusCode);
    }
    const [row] = await cleaner.sql<{ status: string }[]>`
      SELECT status FROM group_invitations WHERE id = ${ctx.invitationId}
    `;
    expect(row?.status).toBe("PENDING");
  });
});

describe("Ex-membro perde acesso imediatamente", () => {
  it("quem acaba de sair não lê mais nem recebe nada, sem esperar o token expirar", async () => {
    // Um membro ativo sai agora, com o access token ainda válido.
    const fresh = await registerUser(app);
    await addMember(app, ctx.owner, ctx.groupId, fresh);
    const before = await app.inject({
      method: "GET",
      url: `/alerts/${ctx.alertId}`,
      headers: authHeaders(fresh),
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "DELETE",
      url: `/groups/${ctx.groupId}/members/me`,
      headers: authHeaders(fresh),
    });

    const after = await app.inject({
      method: "GET",
      url: `/alerts/${ctx.alertId}`,
      headers: authHeaders(fresh),
    });
    expect(after.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/alerts", headers: authHeaders(fresh) });
    expect(JSON.stringify(list.json())).not.toContain(ctx.alertId);
  });
});
