import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupDetectedTimezoneOption } from "../../../src/lib/time/detected-timezone";

type SelectOption = { value: string };

class FakeSelectElement {
	value = "";
	options: SelectOption[] = [];
}

describe("Register timezone selector uses browser-detected timezone when available.", () => {
	const originalDocument = globalThis.document;
	const originalHtmlSelectElement = globalThis.HTMLSelectElement;

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: originalDocument,
		});
		Object.defineProperty(globalThis, "HTMLSelectElement", {
			configurable: true,
			value: originalHtmlSelectElement,
		});
	});

	it("Selects the detected timezone when it exists in the dropdown options.", () => {
		const timezoneSelect = new FakeSelectElement();
		timezoneSelect.options = [
			{ value: "" },
			{ value: "America/New_York" },
			{ value: "America/Chicago" },
		];

		Object.defineProperty(globalThis, "HTMLSelectElement", {
			configurable: true,
			value: FakeSelectElement,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				getElementById: () => timezoneSelect,
			},
		});

		vi.spyOn(DateTime, "local").mockReturnValue({
			zoneName: "America/Chicago",
		} as unknown as DateTime<true>);

		setupDetectedTimezoneOption({ defaultTimezone: "America/New_York" });

		expect(timezoneSelect.value).toBe("America/Chicago");
	});

	it("Falls back to the configured default when detected timezone is unavailable.", () => {
		const timezoneSelect = new FakeSelectElement();
		timezoneSelect.options = [
			{ value: "" },
			{ value: "America/New_York" },
			{ value: "America/Los_Angeles" },
		];

		Object.defineProperty(globalThis, "HTMLSelectElement", {
			configurable: true,
			value: FakeSelectElement,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				getElementById: () => timezoneSelect,
			},
		});

		vi.spyOn(DateTime, "local").mockReturnValue({
			zoneName: "Europe/Berlin",
		} as unknown as DateTime<true>);

		setupDetectedTimezoneOption({ defaultTimezone: "America/New_York" });

		expect(timezoneSelect.value).toBe("America/New_York");
	});

	it("Does not overwrite an explicit user-selected timezone.", () => {
		const timezoneSelect = new FakeSelectElement();
		timezoneSelect.value = "America/Los_Angeles";
		timezoneSelect.options = [
			{ value: "" },
			{ value: "America/New_York" },
			{ value: "America/Los_Angeles" },
		];

		Object.defineProperty(globalThis, "HTMLSelectElement", {
			configurable: true,
			value: FakeSelectElement,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				getElementById: () => timezoneSelect,
			},
		});

		vi.spyOn(DateTime, "local").mockReturnValue({
			zoneName: "America/New_York",
		} as unknown as DateTime<true>);

		setupDetectedTimezoneOption({ defaultTimezone: "America/New_York" });

		expect(timezoneSelect.value).toBe("America/Los_Angeles");
	});
});
