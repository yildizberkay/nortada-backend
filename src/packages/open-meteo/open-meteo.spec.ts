import { OpenMeteoClient } from "./index";

describe("OpenMeteoClient", () => {
  const client = new OpenMeteoClient();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses a forecast response into normalized SI fields", async () => {
    // timeformat=unixtime → epochs. 1783512000 = 2026-07-08T12:00:00Z.
    const noonUtc = 1783512000;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        utc_offset_seconds: 10800, // UTC+3
        current: {
          time: noonUtc,
          wind_speed_10m: 9.4,
          wind_gusts_10m: 12.1,
          wind_direction_10m: 270,
          weather_code: 3,
          temperature_2m: 24.5,
        },
        daily: {
          // Local-midnight epoch: 2026-07-07T21:00:00Z = 2026-07-08 00:00 UTC+3.
          time: [noonUtc - 15 * 3600],
          sunrise: [noonUtc - 9 * 3600],
          sunset: [noonUtc + 6 * 3600],
        },
        hourly: {
          time: [noonUtc, noonUtc + 3600],
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
    expect(result.utcOffsetSeconds).toBe(10800);
    // Epochs come back out as canonical UTC ISO strings.
    expect(result.current.time).toBe("2026-07-08T12:00:00Z");
    expect(result.hourly.time).toEqual([
      "2026-07-08T12:00:00Z",
      "2026-07-08T13:00:00Z",
    ]);
    // Daily rows are labeled with the spot-LOCAL calendar date.
    expect(result.daily.date).toEqual(["2026-07-08"]);
    expect(result.daily.sunrise).toEqual(["2026-07-08T03:00:00Z"]);
    expect(result.daily.sunset).toEqual(["2026-07-08T18:00:00Z"]);
    expect(result.hourly.windSpeedMs).toEqual([9.4, 10.1]);
    // request pins SI + sea cell selection + absolute times with local offset
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("wind_speed_unit=ms");
    expect(url).toContain("cell_selection=sea");
    expect(url).toContain("forecast_days=11");
    expect(url).toContain("timeformat=unixtime");
    expect(url).toContain("timezone=auto");
    expect(url).toContain("daily=sunrise%2Csunset");
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
