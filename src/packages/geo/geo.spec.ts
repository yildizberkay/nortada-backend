import { boundingBox, haversineKm, longitudeRanges, windSide } from "./index";

describe("geo", () => {
  describe("haversineKm", () => {
    it("is ~zero for identical points", () => {
      expect(haversineKm(38.3, 26.4, 38.3, 26.4)).toBeCloseTo(0, 5);
    });

    it("matches a known distance (Alaçatı → Bodrum ≈ 120 km)", () => {
      // Alaçatı ~ (38.27, 26.37), Bodrum ~ (37.03, 27.43)
      const d = haversineKm(38.27, 26.37, 37.03, 27.43);
      expect(d).toBeGreaterThan(150);
      expect(d).toBeLessThan(185);
    });
  });

  describe("boundingBox", () => {
    it("brackets the point and widens with radius", () => {
      const bb = boundingBox(38.3, 26.4, 10);
      expect(bb.latMin).toBeLessThan(38.3);
      expect(bb.latMax).toBeGreaterThan(38.3);
      expect(bb.lonMin).toBeLessThan(26.4);
      expect(bb.lonMax).toBeGreaterThan(26.4);
      // ~10 km ≈ 0.09° latitude.
      expect(bb.latMax - bb.latMin).toBeCloseTo(0.18, 1);
    });

    it("a point inside the true radius is inside the bbox", () => {
      const bb = boundingBox(38.3, 26.4, 20);
      // ~5 km north — well inside.
      const nearLat = 38.345;
      expect(nearLat).toBeGreaterThan(bb.latMin);
      expect(nearLat).toBeLessThan(bb.latMax);
    });

    it("clamps latitude near the poles", () => {
      const bb = boundingBox(89.99, 0, 50);
      expect(bb.latMax).toBeLessThanOrEqual(90);
    });
  });

  describe("longitudeRanges", () => {
    it("returns a single range when in bounds", () => {
      expect(longitudeRanges(20, 30)).toEqual([[20, 30]]);
    });

    it("wraps past +180 into two ranges", () => {
      // A query near 179.9 with a bbox reaching 180.5 must also match -179.5.
      expect(longitudeRanges(179, 180.5)).toEqual([
        [179, 180],
        [-180, -179.5],
      ]);
    });

    it("wraps past -180 into two ranges", () => {
      expect(longitudeRanges(-180.5, -179)).toEqual([
        [-180, -179],
        [179.5, 180],
      ]);
    });

    it("collapses to the full span when the radius circles the globe", () => {
      expect(longitudeRanges(-200, 200)).toEqual([[-180, 180]]);
    });
  });

  describe("windSide", () => {
    // West-facing shore: open water to the west, shoreBearing = 270°.
    const shore = 270;

    it("wind FROM the water is onshore", () => {
      expect(windSide(shore, 270)).toBe("onshore");
    });

    it("wind FROM the land is offshore", () => {
      expect(windSide(shore, 90)).toBe("offshore");
    });

    it("wind along the shore is cross-shore", () => {
      expect(windSide(shore, 180)).toBe("cross-shore");
      expect(windSide(shore, 0)).toBe("cross-shore");
    });

    it("classifies the intermediate bands", () => {
      expect(windSide(shore, 300)).toBe("cross-onshore");
      expect(windSide(shore, 120)).toBe("cross-offshore");
    });

    it("normalizes out-of-range bearings", () => {
      expect(windSide(shore - 360, 270 + 360)).toBe("onshore");
    });
  });
});
