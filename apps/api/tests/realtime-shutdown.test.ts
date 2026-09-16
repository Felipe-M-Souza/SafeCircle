import { afterAll, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { registerUser } from "./helpers/auth.js";
import { connectRealtime, startRealtimeServer } from "./helpers/realtime.js";
import { REALTIME_CLOSE_CODES } from "../src/infrastructure/realtime/realtime-hub.js";

/**
 * Shutdown da API (Phase 12): as conexões realtime abertas são fechadas com
 * 1001/SERVER_SHUTDOWN, e não sem status (1005), para o cliente distinguir
 * deploy de queda e reconectar com backoff.
 */
const cleaner = createCleaner();

afterAll(async () => {
  await cleaner.close();
});

describe("Shutdown — conexões realtime", () => {
  it("app.close() fecha os sockets abertos com 1001/SERVER_SHUTDOWN", async () => {
    const app = await createTestApp();
    const wsUrl = await startRealtimeServer(app);
    const user = await registerUser(app);
    const first = await connectRealtime(wsUrl, user.accessToken);
    const second = await connectRealtime(wsUrl, user.accessToken);
    expect(app.realtimeHub.connectionCount(user.userId)).toBe(2);

    const closing = Promise.all([first.waitForClose(5_000), second.waitForClose(5_000)]);
    await app.close();
    const closed = await closing;

    for (const result of closed) {
      expect(result.code).toBe(REALTIME_CLOSE_CODES.SERVER_SHUTDOWN);
      expect(result.code).toBe(1001);
      expect(result.reason).toBe("SERVER_SHUTDOWN");
    }
    expect(app.realtimeHub.connectionCount(user.userId)).toBe(0);
  });
});
