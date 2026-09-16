/**
 * Sanidade de carga com k6 (Phase 12 §71) — opcional, quando o k6 estiver instalado.
 *
 *   k6 run -e API_URL=http://127.0.0.1:3460 tests/load/k6-api-load.js
 *
 * Mesmo cenário do `api-load.mjs`: 20–50 usuários virtuais, leituras e criação
 * controlada de alertas (idempotentes, resolvidos em seguida), contas
 * sintéticas apagadas ao final. Nunca contra produção; use
 * RATE_LIMIT_PROFILE=relaxed na API alvo.
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.API_URL || "http://127.0.0.1:3460";
const PASSWORD = `k6-${__VU}-${Date.now()}-senha-longa`;

export const options = {
  scenarios: {
    moderate: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "10s", target: 20 },
        { duration: "20s", target: 50 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{route:read}": ["p(95)<500"],
    "http_req_duration{route:write}": ["p(95)<1000"],
  },
};

const json = { headers: { "Content-Type": "application/json" } };
const auth = (token, extra = {}) => ({
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra },
});

export function setup() {
  return {};
}

export default function () {
  const email = `k6.${__VU}.${__ITER}.${Date.now()}@safecircle.test`;
  const reg = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({ name: `k6 ${__VU}`, email, password: PASSWORD }),
    { ...json, tags: { route: "write" } },
  );
  check(reg, { "register 201": (r) => r.status === 201 });
  const token = reg.json("accessToken");
  if (!token) return;

  const group = http.post(`${BASE}/groups`, JSON.stringify({ name: "k6" }), {
    ...auth(token),
    tags: { route: "write" },
  });
  const groupId = group.json("id");

  for (let i = 0; i < 5; i += 1) {
    check(http.get(`${BASE}/groups`, { ...auth(token), tags: { route: "read" } }), {
      "groups 200": (r) => r.status === 200,
    });
    check(http.get(`${BASE}/alerts`, { ...auth(token), tags: { route: "read" } }), {
      "alerts 200": (r) => r.status === 200,
    });
    sleep(0.2);
  }

  if (groupId) {
    const alert = http.post(`${BASE}/alerts`, JSON.stringify({ groupId }), {
      ...auth(token, { "Idempotency-Key": `${__VU}-${__ITER}-${Date.now()}` }),
      tags: { route: "write" },
    });
    check(alert, { "alert 201": (r) => r.status === 201 });
    const alertId = alert.json("id");
    if (alertId) {
      http.post(`${BASE}/alerts/${alertId}/resolve`, null, {
        ...auth(token),
        tags: { route: "write" },
      });
    }
  }

  http.post(`${BASE}/me/delete-account`, JSON.stringify({ password: PASSWORD }), {
    ...auth(token),
    tags: { route: "write" },
  });
}
