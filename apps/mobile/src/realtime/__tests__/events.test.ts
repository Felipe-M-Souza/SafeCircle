import { isAlertEvent, parseRealtimeEvent } from "../events";

const valid = {
  version: 1,
  type: "ALERT_CREATED",
  eventId: "evt-1",
  occurredAt: "2026-09-11T20:30:00.000Z",
  data: { alertId: "a1", groupId: "g1" },
};

describe("parseRealtimeEvent", () => {
  it("aceita envelope válido (objeto ou JSON) e mantém apenas os campos conhecidos", () => {
    expect(parseRealtimeEvent(valid)).toEqual(valid);
    expect(parseRealtimeEvent(JSON.stringify(valid))).toEqual(valid);
    expect(
      parseRealtimeEvent({ ...valid, data: { alertId: "a1", latitude: -23, email: "x@y" } }),
    ).toEqual({ ...valid, data: { alertId: "a1" } });
  });

  it("ignora JSON malformado, versão desconhecida e tipo desconhecido", () => {
    expect(parseRealtimeEvent("{nao-json")).toBeNull();
    expect(parseRealtimeEvent({ ...valid, version: 2 })).toBeNull();
    expect(parseRealtimeEvent({ ...valid, type: "ALERT_TELEPORTED" })).toBeNull();
    expect(parseRealtimeEvent(null)).toBeNull();
    expect(parseRealtimeEvent(42)).toBeNull();
  });

  it("exige eventId, occurredAt e data", () => {
    expect(parseRealtimeEvent({ ...valid, eventId: "" })).toBeNull();
    expect(parseRealtimeEvent({ ...valid, eventId: undefined })).toBeNull();
    expect(parseRealtimeEvent({ ...valid, occurredAt: 123 })).toBeNull();
    expect(parseRealtimeEvent({ ...valid, data: null })).toBeNull();
  });

  it("classifica eventos de alerta", () => {
    expect(isAlertEvent(parseRealtimeEvent(valid)!)).toBe(true);
    expect(
      isAlertEvent(
        parseRealtimeEvent({
          ...valid,
          type: "GROUP_MEMBERSHIP_CHANGED",
          data: { groupId: "g1", userId: "u1" },
        })!,
      ),
    ).toBe(false);
  });
});
