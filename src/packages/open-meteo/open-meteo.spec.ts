import { OpenMeteoClient } from "./index";

describe("OpenMeteoClient", () => {
  const client = new OpenMeteoClient();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses a forecast response into normalized SI fields", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          time: "2026-07-11T12:00",
          wind_speed_10m: 9.4,
          wind_gusts_10m: 12.1,
          wind_direction_10m: 270,
          weather_code: 3,
          temperature_2m: 24.5,
        },
        hourly: {
          time: ["2026-07-11T12:00", "2026-07-11T13:00"],
          wind_speed_10m: [9.4, 10.1],
          wind_gusts_10m: [12, 13],
          wind_direction_10m: [270, 280],
          weather_code: [3, 3],
          temperature_2m: [24, 25],
          apparent_temperature: [23, 24],
          precipitation: [0, 0],
          precipitation_probability: [10, 20],
          cape: [0, 0],
          cloud_cover: [40, 50],
        },
      }),
    }) as unknown as typeof fetch;

    const result = await client.fetchForecast(38.27, 26.37);

    expect(result.current.windSpeedMs).toBe(9.4);
    expect(result.current.windDirectionDeg).toBe(270);
    expect(result.hourly.time).toHaveLength(2);
    expect(result.hourly.windSpeedMs).toEqual([9.4, 10.1]);
    // request pins SI + sea cell selection
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("wind_speed_unit=ms");
    expect(url).toContain("cell_selection=sea");
    expect(url).toContain("forecast_days=11");
  });

  it("parses model metadata (unix seconds → Date)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        last_run_availability_time: 1_700_000_000,
        update_interval_seconds: 3600,
      }),
    }) as unknown as typeof fetch;

    const meta = await client.fetchModelMeta("icon_seamless");

    expect(meta.updateIntervalSec).toBe(3600);
    expect(meta.lastRunAvailabilityTime).toEqual(new Date(1_700_000_000_000));
  });

  it("throws EXTERNAL_SERVICE_ERROR on a non-OK response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await expect(client.fetchForecast(0, 0)).rejects.toMatchObject({
      errorCode: "EXTERNAL_SERVICE_ERROR",
    });
  });
});
