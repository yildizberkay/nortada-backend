import { OverpassClient } from "./index";

describe("OverpassClient", () => {
  const client = new OverpassClient();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the elements array on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ type: "node", id: 1 }] }),
    }) as unknown as typeof fetch;

    const elements = await client.fetchByCountry("TR");

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ type: "node", id: 1 });
  });

  it("returns [] when the response has no elements", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    expect(await client.fetchByCountry("TR")).toEqual([]);
  });

  it("throws EXTERNAL_SERVICE_ERROR when the request throws", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(client.fetchByCountry("TR")).rejects.toMatchObject({
      errorCode: "EXTERNAL_SERVICE_ERROR",
    });
  });

  it("throws EXTERNAL_SERVICE_ERROR on a non-OK response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }) as unknown as typeof fetch;

    await expect(client.fetchByCountry("TR")).rejects.toMatchObject({
      errorCode: "EXTERNAL_SERVICE_ERROR",
    });
  });
});
