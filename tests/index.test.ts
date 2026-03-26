import { describe, it, expect } from "vitest";
import { getBank } from "../src/index.js";

describe("getBank", () => {
  it("finds a bank by lowercase id", () => {
    const bank = getBank("falabella");
    expect(bank?.id).toBe("falabella");
  });

  it("normalizes uppercase and surrounding spaces", () => {
    const bank = getBank("  FALABELLA  ");
    expect(bank?.id).toBe("falabella");
  });

  it("returns undefined for unknown id", () => {
    expect(getBank("unknown-bank")).toBeUndefined();
  });
});
