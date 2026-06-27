import { describe, expect, it } from "vitest";
import { SECTOR_ETF_MAP, sicCodeToSector } from "../../../src/lib/vendors/sector-mapping";

describe("SIC codes map to realistic market sectors for onboarding examples.", () => {
	it("Classifies common SIC ranges into expected sectors.", () => {
		expect(sicCodeToSector("3571")).toBe("Technology"); // computer hardware
		expect(sicCodeToSector("2834")).toBe("Healthcare"); // pharmaceuticals
		expect(sicCodeToSector("1311")).toBe("Energy"); // crude petroleum
		expect(sicCodeToSector("6021")).toBe("Financials"); // national commercial banks
	});

	it("Falls back to Other for invalid or unknown SIC input.", () => {
		expect(sicCodeToSector("not-a-code")).toBe("Other");
		expect(sicCodeToSector("-10")).toBe("Other");
		expect(sicCodeToSector("99999")).toBe("Other");
	});

	it("Includes ETF proxies for major sectors.", () => {
		expect(SECTOR_ETF_MAP.Technology).toBe("XLK");
		expect(SECTOR_ETF_MAP.Healthcare).toBe("XLV");
		expect(SECTOR_ETF_MAP.Energy).toBe("XLE");
		expect(SECTOR_ETF_MAP.Financials).toBe("XLF");
	});
});
