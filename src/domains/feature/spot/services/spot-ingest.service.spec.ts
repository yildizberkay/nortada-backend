import type { OverpassClient, OverpassElement } from "@/packages/overpass";

import type { SpotRepository } from "../repositories/spot.repository";
import {
  normalizeOverpassElement,
  SpotIngestService,
} from "./spot-ingest.service";

describe("normalizeOverpassElement", () => {
  it("maps a windsurfing node to a pending OSM spot", () => {
    const el: OverpassElement = {
      type: "node",
      id: 1,
      lat: 38.27,
      lon: 26.37,
      tags: { name: "Alaçatı", sport: "windsurfing" },
    };

    const spot = normalizeOverpassElement(el, "TR");

    expect(spot).toMatchObject({
      name: "Alaçatı",
      latitude: 38.27,
      longitude: 26.37,
      country: "TR",
      supportedSports: ["windsurf"],
      source: "osm",
      osmId: "node/1",
      status: "pending",
    });
  });

  it("takes coordinates from `center` for ways and marks marinas", () => {
    const el: OverpassElement = {
      type: "way",
      id: 2,
      center: { lat: 37, lon: 27 },
      tags: { name: "Marina", leisure: "marina" },
    };

    const spot = normalizeOverpassElement(el, "TR");

    expect(spot?.osmId).toBe("way/2");
    expect(spot?.waterType).toBe("marina");
    expect(spot?.supportedSports).toEqual(["sailing"]);
  });

  it("splits multi-valued sport tags", () => {
    const spot = normalizeOverpassElement(
      {
        type: "node",
        id: 3,
        lat: 1,
        lon: 1,
        tags: { name: "X", sport: "kitesurfing;sailing" },
      },
      "TR",
    );
    expect(spot?.supportedSports).toEqual(["kitesurf", "sailing"]);
  });

  it("defaults to [other] when no sport is derivable", () => {
    const spot = normalizeOverpassElement(
      { type: "node", id: 4, lat: 1, lon: 1, tags: { name: "Beach" } },
      "TR",
    );
    expect(spot?.supportedSports).toEqual(["other"]);
  });

  it("skips unnamed elements", () => {
    expect(
      normalizeOverpassElement(
        { type: "node", id: 5, lat: 1, lon: 1, tags: { sport: "sailing" } },
        "TR",
      ),
    ).toBeNull();
  });

  it("skips elements with no coordinate", () => {
    expect(
      normalizeOverpassElement(
        { type: "relation", id: 6, tags: { name: "No coords" } },
        "TR",
      ),
    ).toBeNull();
  });
});

describe("SpotIngestService", () => {
  const mockOverpass = {
    fetchByCountry: jest.fn(),
  } as unknown as jest.Mocked<OverpassClient>;

  const mockRepo = {
    bulkInsertOsmPending: jest.fn(),
  } as unknown as jest.Mocked<SpotRepository>;

  let service: SpotIngestService;

  beforeEach(() => {
    service = new SpotIngestService(mockOverpass, mockRepo);
  });

  it("fetches, normalizes (dropping invalid), and bulk-inserts", async () => {
    mockOverpass.fetchByCountry.mockResolvedValue([
      {
        type: "node",
        id: 1,
        lat: 1,
        lon: 1,
        tags: { name: "A", sport: "sailing" },
      },
      { type: "node", id: 2, lat: 1, lon: 1, tags: { sport: "sailing" } }, // unnamed → dropped
      { type: "node", id: 3, tags: { name: "No coord" } }, // no coord → dropped
    ]);
    mockRepo.bulkInsertOsmPending.mockResolvedValue(1);

    const result = await service.ingestByCountry("TR");

    expect(result).toEqual({ fetched: 3, normalized: 1, inserted: 1 });
    expect(mockRepo.bulkInsertOsmPending).toHaveBeenCalledWith([
      expect.objectContaining({ name: "A", osmId: "node/1" }),
    ]);
  });
});
