import { ApiError, type LiveLocationUpdateInput } from "../../lib/api";
import { LiveLocationUploader } from "../LiveLocationUploader";
import type { LocationSample } from "../live-location.service";

// Coordenadas SINTÉTICAS.
function sample(offset = 0): LocationSample {
  return {
    latitude: -23 + offset * 0.001,
    longitude: -46,
    accuracy: 12,
    capturedAt: new Date(Date.now()).toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LiveLocationUploader", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-11T20:00:00.000Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("envia o ponto com clientUpdateId UUID e campos de localização", async () => {
    const send = jest.fn<Promise<unknown>, [LiveLocationUpdateInput]>(async () => ({}));
    const sent: LiveLocationUpdateInput[] = [];
    const uploader = new LiveLocationUploader({ send, onSent: (point) => sent.push(point) });

    uploader.enqueue(sample());
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(1);
    const point = send.mock.calls[0]?.[0] as unknown as LiveLocationUpdateInput;
    expect(point.clientUpdateId).toMatch(UUID);
    expect(point).toMatchObject({ latitude: -23, longitude: -46, accuracy: 12 });
    expect(sent).toHaveLength(1);
    expect(uploader.getStatus()).toBe("idle");
  });

  it("respeita o intervalo mínimo e mantém apenas o ponto mais recente pendente", async () => {
    const send = jest.fn<Promise<unknown>, [LiveLocationUpdateInput]>(async () => ({}));
    const uploader = new LiveLocationUploader({ send, minIntervalMs: 4000 });

    uploader.enqueue(sample(0));
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    // Vários callbacks do GPS em sequência: só o último fica pendente.
    uploader.enqueue(sample(1));
    uploader.enqueue(sample(2));
    uploader.enqueue(sample(3));
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploader.getPending()?.latitude).toBe(-23 + 0.003);

    await jest.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1]?.[0] as unknown as LiveLocationUpdateInput).latitude).toBe(
      -23 + 0.003,
    );
    expect(uploader.getPending()).toBeNull();
  });

  it("falha temporária mantém o ponto e tenta de novo com o MESMO clientUpdateId", async () => {
    const send = jest
      .fn<Promise<unknown>, [LiveLocationUpdateInput]>()
      .mockRejectedValueOnce(new ApiError("NETWORK", "offline", 0))
      .mockRejectedValueOnce(new ApiError("LOCATION_UPDATE_TOO_FREQUENT", "429", 429))
      .mockResolvedValue({});
    const statuses: string[] = [];
    const uploader = new LiveLocationUploader({
      send,
      retryDelayMs: 3000,
      onStatus: (status) => statuses.push(status),
    });

    uploader.enqueue(sample());
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toBe("degraded");
    const firstId = send.mock.calls[0]?.[0]?.clientUpdateId;

    await jest.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]?.clientUpdateId).toBe(firstId);
    expect(uploader.getStatus()).toBe("degraded");

    await jest.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]?.clientUpdateId).toBe(firstId);
    expect(uploader.getStatus()).toBe("idle");
    expect(uploader.getPending()).toBeNull();
    expect(statuses).toEqual(["sending", "degraded", "sending", "degraded", "sending", "idle"]);
  });

  it("offline por muito tempo: não acumula fila; ao reconectar envia só o ponto mais recente", async () => {
    const send = jest
      .fn<Promise<unknown>, [LiveLocationUpdateInput]>()
      .mockRejectedValue(new ApiError("NETWORK", "offline", 0));
    const uploader = new LiveLocationUploader({ send, retryDelayMs: 3000, maxAgeMs: 120_000 });

    for (let i = 0; i < 10; i += 1) {
      uploader.enqueue(sample(i));
      await jest.advanceTimersByTimeAsync(5000);
    }
    expect(uploader.getPending()?.latitude).toBe(-23 + 0.009);

    const callsWhileOffline = send.mock.calls.length;
    send.mockResolvedValue({});
    await jest.advanceTimersByTimeAsync(3000);
    // Ao reconectar: exatamente um envio, com o ponto mais recente.
    expect(send.mock.calls.length).toBe(callsWhileOffline + 1);
    expect(send.mock.calls.at(-1)?.[0]?.latitude).toBe(-23 + 0.009);
    expect(uploader.getPending()).toBeNull();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls.length).toBe(callsWhileOffline + 1);
  });

  it("resposta definitiva (4xx) descarta o ponto e avisa onFatal", async () => {
    const send = jest
      .fn<Promise<unknown>, [LiveLocationUpdateInput]>()
      .mockRejectedValue(new ApiError("LIVE_LOCATION_NOT_ACTIVE", "conflict", 409));
    const onFatal = jest.fn();
    const uploader = new LiveLocationUploader({ send, onFatal });

    uploader.enqueue(sample());
    await flushPromises();

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect((onFatal.mock.calls[0]?.[0] as ApiError).code).toBe("LIVE_LOCATION_NOT_ACTIVE");
    expect(uploader.getPending()).toBeNull();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ponto pendente muito antigo é descartado; stop() impede novos envios", async () => {
    const send = jest
      .fn<Promise<unknown>, [LiveLocationUpdateInput]>()
      .mockRejectedValueOnce(new ApiError("NETWORK", "offline", 0))
      .mockResolvedValue({});
    // Retry só depois que o ponto já ficou velho demais (> maxAgeMs): é descartado.
    const uploader = new LiveLocationUploader({ send, retryDelayMs: 12_000, maxAgeMs: 10_000 });

    uploader.enqueue(sample());
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploader.getPending()).not.toBeNull();
    await jest.advanceTimersByTimeAsync(12_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploader.getPending()).toBeNull();

    uploader.stop();
    uploader.enqueue(sample());
    await jest.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
