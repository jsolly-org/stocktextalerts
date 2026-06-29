import {
	optionalVendorCircuits,
	optionalVendorSkipState,
} from "../../src/lib/vendors/optional-vendor-circuit-store";

export function resetOptionalVendorCircuits(): void {
	optionalVendorCircuits.clear();
	optionalVendorSkipState.count = 0;
}
