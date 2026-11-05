import { describe, expect, it } from "vitest";
import { COUNTRIES, countryByName, joinPhone, splitPhone } from "@/lib/countries";

describe("países y teléfonos", () => {
  it("la lista trae los países en español con su prefijo", () => {
    expect(countryByName("Perú")).toMatchObject({ code: "PE", dial: "51" });
    expect(COUNTRIES.find((c) => c.code === "US")?.dial).toBe("1");
    expect(COUNTRIES.length).toBeGreaterThan(190);
  });

  it("separa el prefijo más largo que calza y vuelve a unirlo", () => {
    expect(splitPhone("+51 987 654 321")).toEqual({ dial: "51", number: "987 654 321" });
    expect(splitPhone("+591 7123 4567")).toEqual({ dial: "591", number: "7123 4567" });
    expect(splitPhone("+1 415 555 0101")).toEqual({ dial: "1", number: "415 555 0101" });
    expect(splitPhone("987654321")).toEqual({ dial: null, number: "987654321" });
    expect(splitPhone(null)).toEqual({ dial: null, number: "" });
    expect(joinPhone("51", "987 654 321")).toBe("+51 987 654 321");
    expect(joinPhone("51", "  ")).toBeNull();
  });
});
