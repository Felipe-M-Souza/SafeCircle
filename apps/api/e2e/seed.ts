import "../src/config/load-dotenv.js";
import postgres from "postgres";
import { hashPassword } from "../src/modules/auth/password.js";
import { E2E_PASSWORD, e2eDatabaseUrl, ensureDatabase } from "./harness.js";

/**
 * Seed E2E (Phase 12): `pnpm e2e:seed`.
 *
 * Cria um estado conhecido e **sintético** para os flows Maestro e para
 * inspeção manual: duas pessoas e um grupo. E-mails no domínio reservado
 * `safecircle.test`, senha fixa de teste, nenhum push token, nenhuma
 * coordenada. Idempotente: apaga as contas do seed e recria.
 *
 *   Ana   — ana.e2e@safecircle.test   (OWNER do grupo "Família E2E")
 *   Bruno — bruno.e2e@safecircle.test (MEMBER)
 *   Senha (ambos): senha-e2e-segura-123
 */
export const SEED_USERS = [
  { name: "Ana E2E", email: "ana.e2e@safecircle.test" },
  { name: "Bruno E2E", email: "bruno.e2e@safecircle.test" },
] as const;
export const SEED_GROUP_NAME = "Família E2E";

export async function seed(databaseUrl: string, log: (message: string) => void = console.log) {
  await ensureDatabase(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const passwordHash = await hashPassword(E2E_PASSWORD);
    // Remove o seed anterior (cascade leva sessões, grupos próprios etc.).
    await sql`DELETE FROM users WHERE email IN ${sql(SEED_USERS.map((u) => u.email))}`;

    const ids: Record<string, string> = {};
    for (const user of SEED_USERS) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (name, email, password_hash)
        VALUES (${user.name}, ${user.email}, ${passwordHash})
        RETURNING id
      `;
      ids[user.email] = row!.id;
    }

    const [group] = await sql<{ id: string }[]>`
      INSERT INTO trusted_groups (name) VALUES (${SEED_GROUP_NAME}) RETURNING id
    `;
    await sql`
      INSERT INTO group_memberships (group_id, user_id, role)
      VALUES (${group!.id}, ${ids[SEED_USERS[0].email]!}, 'OWNER'),
             (${group!.id}, ${ids[SEED_USERS[1].email]!}, 'MEMBER')
    `;

    log(`Seed E2E aplicado: ${SEED_USERS.length} usuários, 1 grupo ("${SEED_GROUP_NAME}").`);
    log(`Contas: ${SEED_USERS.map((u) => u.email).join(", ")} — senha de teste fixa.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /seed\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  seed(e2eDatabaseUrl()).catch((error) => {
    console.error("Falha no seed E2E:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
