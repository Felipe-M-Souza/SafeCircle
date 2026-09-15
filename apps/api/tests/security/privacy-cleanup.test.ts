import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/app.js";
import { createCleaner } from "../helpers/test-db.js";
import { registerUser, sessionIdOf, type TestUser } from "../helpers/auth.js";
import { addMember, createGroup } from "../helpers/groups.js";
import { createAlert, SYNTHETIC_LOCATION } from "../helpers/alerts.js";
import { checkinAction, createCheckin } from "../helpers/checkins.js";
import { createJourney, journeyAction } from "../helpers/journeys.js";
import { drainOutbox } from "../helpers/outbox.js";
import { CLEANUP_STEPS, runPrivacyCleanup } from "../../src/scripts/privacy-cleanup.js";
import type { Database } from "../../src/infrastructure/database/client.js";

/**
 * Retenção consolidada (Phase 11): `privacy:cleanup` só remove o que já
 * encerrou e passou do prazo; ACTIVE/PENDING nunca é tocado; uma etapa que
 * falha é identificada e não derruba as demais.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let groupId: string;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  owner = await registerUser(app);
  member = await registerUser(app);
  groupId = await createGroup(app, owner);
  await addMember(app, owner, groupId, member);
  await drainOutbox(app);
});

const count = async (table: string, where = "true"): Promise<number> => {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${cleaner.sql(table)} WHERE ${cleaner.sql.unsafe(where)}
  `;
  return row?.count ?? 0;
};

describe("pnpm privacy:cleanup", () => {
  it("remove só o expirado de cada categoria e preserva tudo que está ativo", async () => {
    // --- Alertas: um encerrado há 40 dias (com localização) e um ACTIVE ---
    const oldAlert = await createAlert(app, owner, groupId, SYNTHETIC_LOCATION);
    await app.inject({
      method: "POST",
      url: `/alerts/${oldAlert.id}/resolve`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    await cleaner.sql`UPDATE emergency_alerts SET resolved_at = now() - interval '40 days', updated_at = now() - interval '40 days' WHERE id = ${oldAlert.id}`;
    const activeAlert = await createAlert(app, member, groupId, SYNTHETIC_LOCATION);

    // --- Check-ins: um finalizado há 100 dias e um ACTIVE ---
    const oldCheckin = await createCheckin(app, owner, groupId);
    await checkinAction(app, owner, oldCheckin.id, "safe");
    await cleaner.sql`UPDATE safety_checkins SET confirmed_at = now() - interval '100 days', updated_at = now() - interval '100 days' WHERE id = ${oldCheckin.id}`;
    const activeCheckin = await createCheckin(app, member, groupId);

    // --- Trajetos: um finalizado há 100 dias e um ACTIVE ---
    const oldJourney = await createJourney(app, owner, groupId);
    await journeyAction(app, owner, oldJourney.id, "arrive");
    await cleaner.sql`UPDATE safe_journeys SET arrived_at = now() - interval '100 days', updated_at = now() - interval '100 days' WHERE id = ${oldJourney.id}`;
    const activeJourney = await createJourney(app, member, groupId);

    // --- Autenticação: sessão revogada há 40 dias, histórico expirado, sessão ativa ---
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: owner.email, password: owner.password },
    });
    const oldSessionId = JSON.parse(
      Buffer.from(login.json().accessToken.split(".")[1], "base64url").toString(),
    ).sid as string;
    await cleaner.sql`UPDATE auth_sessions SET revoked_at = now() - interval '40 days', revoked_reason = 'LOGOUT' WHERE id = ${oldSessionId}`;
    await cleaner.sql`
      INSERT INTO auth_refresh_token_history (session_id, token_hash, rotated_at, expires_at)
      VALUES (${sessionIdOf(owner)}, repeat('a', 64), now() - interval '31 days', now() - interval '1 day'),
             (${sessionIdOf(owner)}, repeat('b', 64), now(), now() + interval '29 days')
    `;

    // Entrega tudo que o preparo enfileirou antes de mexer na outbox.
    await drainOutbox(app);

    // --- Auditoria: metade envelhecida além de 180 dias ---
    const auditTotal = await count("audit_events");
    expect(auditTotal).toBeGreaterThan(2);
    await cleaner.sql`
      UPDATE audit_events SET created_at = now() - interval '200 days'
       WHERE id IN (SELECT id FROM audit_events ORDER BY created_at LIMIT 2)
    `;

    // --- Outbox: processado antigo, DEAD antigo e um PENDING antigo (intocável) ---
    await cleaner.sql`
      UPDATE outbox_events SET processed_at = now() - interval '40 days'
       WHERE id IN (SELECT id FROM outbox_events WHERE status = 'PROCESSED' ORDER BY created_at LIMIT 2)
    `;
    const pendingBefore = await count("outbox_events", "status = 'PENDING'");
    await cleaner.sql`
      INSERT INTO outbox_events (event_type, aggregate_type, payload, status, max_attempts, available_at, created_at, updated_at)
      VALUES ('AUDIT_ALERT_CREATED', 'TESTE', '{"version":1}'::jsonb, 'PENDING', 12, now() - interval '400 days', now() - interval '400 days', now() - interval '400 days'),
             ('AUDIT_ALERT_CREATED', 'TESTE', '{"version":1}'::jsonb, 'DEAD', 12, now(), now() - interval '120 days', now())
    `;
    await cleaner.sql`UPDATE outbox_events SET dead_lettered_at = now() - interval '100 days' WHERE status = 'DEAD'`;

    const report = await runPrivacyCleanup(
      app.db,
      new Date(),
      () => {},
      () => {},
    );
    expect(report.failures).toEqual([]);
    expect(report.results.map((r) => r.step)).toEqual(CLEANUP_STEPS.map((s) => s.name));

    // Removidos: só os expirados.
    expect(await count("emergency_alerts", `id = '${oldAlert.id}'`)).toBe(1); // o alerta fica; a localização vai
    expect(await count("alert_locations", `alert_id = '${oldAlert.id}'`)).toBe(0);
    expect(await count("alert_locations", `alert_id = '${activeAlert.id}'`)).toBe(1);
    expect(await count("safety_checkins", `id = '${oldCheckin.id}'`)).toBe(0);
    expect(await count("safety_checkins", `id = '${activeCheckin.id}'`)).toBe(1);
    expect(await count("safe_journeys", `id = '${oldJourney.id}'`)).toBe(0);
    expect(await count("safe_journeys", `id = '${activeJourney.id}'`)).toBe(1);
    expect(await count("audit_events")).toBe(auditTotal - 2);
    expect(await count("outbox_events", "status = 'DEAD'")).toBe(0);
    expect(await count("outbox_events", "status = 'PENDING'")).toBe(pendingBefore + 1);
    expect(await count("auth_sessions", `id = '${oldSessionId}'`)).toBe(0);
    expect(await count("auth_sessions", `id = '${sessionIdOf(owner)}'`)).toBe(1);
    expect(await count("auth_refresh_token_history")).toBe(1);

    // Entidades de domínio fora da política continuam intactas.
    expect(await count("users")).toBe(2);
    expect(await count("trusted_groups")).toBe(1);
    expect(await count("group_memberships")).toBe(2);

    // O resumo é por categoria e quantidade — nenhum id, e-mail ou coordenada.
    const summary = JSON.stringify(report.results);
    expect(summary).not.toContain(oldAlert.id);
    expect(summary).not.toContain(owner.email);
    expect(summary).not.toMatch(new RegExp(`${SYNTHETIC_LOCATION.latitude}\\b`));
    for (const result of report.results) {
      for (const value of Object.values(result.removed)) expect(typeof value).toBe("number");
    }
  });

  it("uma etapa que falha é identificada pelo nome e não impede as demais", async () => {
    const logged: string[] = [];
    const errors: string[] = [];
    // Um "banco" que não implementa nada: todas as etapas falham.
    const broken = {} as unknown as Database;
    const report = await runPrivacyCleanup(
      broken,
      new Date(),
      (m) => logged.push(m),
      (m) => errors.push(m),
    );
    expect(report.results).toEqual([]);
    expect(report.failures.map((f) => f.step)).toEqual(CLEANUP_STEPS.map((s) => s.name));
    expect(errors).toHaveLength(CLEANUP_STEPS.length);
    for (const line of errors) {
      expect(line).toMatch(/^\[falha\] /);
      // Só o tipo do erro, nunca a mensagem (que poderia citar uma linha do banco).
      expect(line).not.toMatch(/at |\.ts:|\.js:/);
    }
    expect(logged).toEqual([]);
  });
});
