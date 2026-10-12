import { describe, expect, it } from "vitest";
import { allocateProportionally, computeTax } from "../src/modules/tax/engine";

const line = (unit: number, qty = 1, extra: object = {}) => ({
  key: `k${unit}-${qty}`,
  unitPriceMinor: unit,
  quantity: qty,
  ...extra,
});

describe("allocateProportionally", () => {
  it("sums exactly with remainder handling", () => {
    const parts = allocateProportionally(100, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([33, 33, 34]);
  });
  it("is exact for awkward splits (1 cent over 3 lines)", () => {
    const parts = allocateProportionally(1, [100, 100, 100]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it("caps at the weights and handles zero", () => {
    expect(allocateProportionally(1000, [100, 200])).toEqual([100, 200]);
    expect(allocateProportionally(0, [100, 200])).toEqual([0, 0]);
    expect(allocateProportionally(50, [0, 0])).toEqual([0, 0]);
  });
  it("always conserves the total across random inputs", () => {
    for (let n = 0; n < 200; n++) {
      const w = Array.from({ length: 1 + (n % 6) }, (_, i) => ((n * 7919 + i * 104729) % 9973) + 1);
      const total = (n * 31) % w.reduce((a, b) => a + b, 0);
      const parts = allocateProportionally(total, w);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p, i) => expect(p).toBeLessThanOrEqual(w[i]!));
    }
  });
});

describe("computeTax", () => {
  it("NONE => zero tax", () => {
    const r = computeTax({ mode: "NONE", defaultRate: 18 }, [line(1000, 2)]);
    expect(r.taxMinor).toBe(0);
    expect(r.lines[0]!.totalMinor).toBe(2000);
  });

  it("EXCLUSIVE adds tax on top using the class rate, else default", () => {
    const r = computeTax({ mode: "EXCLUSIVE", defaultRate: 10 }, [
      line(1000, 1, { taxRate: 5 }),
      line(2000, 1),
    ]);
    expect(r.lines.map((l) => l.taxMinor)).toEqual([50, 200]);
    expect(r.taxMinor).toBe(250);
    expect(r.taxAddedMinor).toBe(250);
    expect(r.lines[0]!.totalMinor).toBe(1050);
    expect(r.breakdown).toEqual([
      { name: "Tax", rate: 5, amountMinor: 50 },
      { name: "Tax", rate: 10, amountMinor: 200 },
    ]);
  });

  it("EXCLUSIVE rounds half-up per line (0.5 minor unit)", () => {
    // 5% of 10 minor = 0.5 -> 1 ; 5% of 30 = 1.5 -> 2 ; 5% of 9 = 0.45 -> 0
    const r = computeTax({ mode: "EXCLUSIVE", defaultRate: 5 }, [line(10), line(30), line(9)]);
    expect(r.lines.map((l) => l.taxMinor)).toEqual([1, 2, 0]);
    expect(r.taxMinor).toBe(3);
  });

  it("INCLUSIVE extracts tax and keeps the payable total unchanged", () => {
    const r = computeTax({ mode: "INCLUSIVE", defaultRate: 18 }, [line(11800)]);
    expect(r.inclusive).toBe(true);
    expect(r.taxMinor).toBe(1800);
    expect(r.taxAddedMinor).toBe(0);
    expect(r.lines[0]!.netMinor).toBe(10000);
    expect(r.lines[0]!.totalMinor).toBe(11800);
  });

  it("INCLUSIVE rounding: 999 @ 18% => 152, net 847", () => {
    const r = computeTax({ mode: "INCLUSIVE", defaultRate: 18 }, [line(999)]);
    expect(r.lines[0]!.taxMinor).toBe(152);
    expect(r.lines[0]!.netMinor + r.lines[0]!.taxMinor).toBe(999);
  });

  it("applies tax AFTER discount", () => {
    const r = computeTax({ mode: "EXCLUSIVE", defaultRate: 10 }, [
      line(1000, 1, { discountMinor: 200 }),
    ]);
    expect(r.lines[0]!.taxMinor).toBe(80);
    expect(r.lines[0]!.totalMinor).toBe(880);
  });

  it("never lets a discount exceed the line", () => {
    const r = computeTax({ mode: "EXCLUSIVE", defaultRate: 10 }, [
      line(1000, 1, { discountMinor: 5000 }),
    ]);
    expect(r.lines[0]!.totalMinor).toBe(0);
    expect(r.taxMinor).toBe(0);
  });

  it("INDIA_GST intra-state => CGST+SGST halves that sum exactly (odd paise to SGST)", () => {
    const r = computeTax(
      { mode: "INDIA_GST", homeState: "Karnataka", pricesIncludeTax: false },
      [line(101, 1, { taxRate: 5, hsnCode: "4901" })],
      { state: " karnataka ", country: "IN" },
    );
    expect(r.intraState).toBe(true);
    const l = r.lines[0]!;
    expect(l.taxMinor).toBe(5); // 5.05 -> 5
    expect(l.components).toEqual({ cgst: 2, sgst: 3, igst: 0 });
    expect(l.hsnCode).toBe("4901");
    expect(r.breakdown.map((b) => b.name)).toEqual(["CGST", "SGST"]);
    expect(r.breakdown.map((b) => b.rate)).toEqual([2.5, 2.5]);
    expect(r.breakdown.reduce((a, b) => a + b.amountMinor, 0)).toBe(r.taxMinor);
  });

  it("INDIA_GST inter-state => IGST; inclusive by default", () => {
    const r = computeTax(
      { mode: "INDIA_GST", homeState: "Karnataka" },
      [line(11800, 1, { taxRate: 18 })],
      { state: "Maharashtra" },
    );
    expect(r.intraState).toBe(false);
    expect(r.inclusive).toBe(true);
    expect(r.lines[0]!.components).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
    expect(r.breakdown).toEqual([{ name: "IGST", rate: 18, amountMinor: 1800 }]);
    expect(r.taxAddedMinor).toBe(0);
  });

  it("INDIA_GST without homeState/shipping state is treated as inter-state", () => {
    const r = computeTax({ mode: "INDIA_GST" }, [line(1000, 1, { taxRate: 12 })], {});
    expect(r.intraState).toBe(false);
    expect(r.lines[0]!.components.igst).toBe(r.lines[0]!.taxMinor);
  });

  it("sum of line taxes equals the total with many fractional lines", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      line(99 + i * 7, 1 + (i % 3), { taxRate: 18 }),
    );
    const r = computeTax({ mode: "EXCLUSIVE" }, lines);
    expect(r.taxMinor).toBe(r.lines.reduce((a, l) => a + l.taxMinor, 0));
    expect(r.breakdown.reduce((a, b) => a + b.amountMinor, 0)).toBe(r.taxMinor);
  });

  it("zero-rate and unknown modes yield no tax", () => {
    expect(computeTax({ mode: "EXCLUSIVE", defaultRate: 0 }, [line(500)]).taxMinor).toBe(0);
    expect(computeTax({ mode: "WAT" }, [line(500)]).mode).toBe("NONE");
  });
});
