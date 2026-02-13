<template>
	<div data-autosave-ignore>
		<label for="phone" class="block text-sm font-medium text-label mb-1">
			Phone Number
		</label>
		<div class="flex">
			<div
				class="group relative flex w-full rounded-lg border border-edge-strong focus-within:ring-2 focus-within:ring-primary focus-within:border-primary"
				:class="{
					'border-error-strong ring-2 ring-error-strong': showError,
					'border-success-strong ring-2 ring-success-strong': isValid && phoneNumber,
				}"
			>
			<div class="relative w-20 sm:w-24">
				<select
					id="country"
					name="country"
					v-model="country"
					autocomplete="country"
					aria-label="Country"
					class="w-full appearance-none rounded-l-lg py-2.5 pl-3 pr-8 text-base text-muted focus:outline-none border-r border-edge-strong bg-surface"
				>
					<option value="US">+1</option>
				</select>
				<div class="absolute inset-y-0 right-1 flex items-center pointer-events-none">
					<ChevronDownIcon
						class="h-5 w-5 text-muted"
						aria-hidden="true"
					/>
				</div>
					<input type="hidden" name="phone_country_code" :value="`+${getCountryCallingCode(country)}`" />
					<input type="hidden" name="phone_number" :value="lastDigits" />
				</div>
				<div class="flex-1 relative min-w-0">
				<input
					ref="phoneInputRef"
					type="tel"
					id="phone"
					v-model="phoneNumber"
					@input="handlePhoneInput"
					@focus="touched = true"
					@blur="validate"
					:aria-describedby="showError ? 'phone-error' : undefined"
					:aria-invalid="showError ? 'true' : undefined"
					class="w-full min-w-0 rounded-r-lg py-2.5 px-3 text-base text-heading placeholder:text-faint focus:outline-none"
					:placeholder="computedPlaceholder"
					name="phone"
					:required="isRequired"
					inputmode="tel"
					autocomplete="tel-national"
				/>
					<div v-if="phoneNumber" class="absolute inset-y-0 right-3 flex items-center pointer-events-none">
						<CheckCircleIcon
							v-if="isValid"
							class="h-5 w-5 text-success-text"
							aria-hidden="true"
						/>
						<ExclamationCircleIcon
							v-else
							class="h-5 w-5 text-error-text"
							aria-hidden="true"
						/>
					</div>
				</div>
			</div>
		</div>
		<p v-if="showError" id="phone-error" role="alert" class="mt-1 text-sm text-error-text">Please enter a valid phone number</p>
	</div>
</template>

<script lang="ts" setup>
import {
	AsYouType,
	getCountryCallingCode,
	getExampleNumber,
	isValidPhoneNumber,
} from "libphonenumber-js";
import examples from "libphonenumber-js/examples.mobile.json";
import { computed, ref, watch } from "vue";
import CheckCircleIcon from "../../../icons/check-circle-24.svg?component";
import ChevronDownIcon from "../../../icons/chevron-down.svg?component";
import ExclamationCircleIcon from "../../../icons/exclamation-circle-24.svg?component";

const phoneInputRef = ref<HTMLInputElement | null>(null);

defineExpose({
	focus: () => {
		phoneInputRef.value?.focus();
	},
});

type Country = "US";

const props = defineProps<{
	formSubmitted?: boolean;
	required?: boolean;
	/**
	 * Server-provided national number digits (no country code),
	 * e.g. "5555550123". Used to rehydrate the phone field after
	 * redirects so users don't have to re-enter their number.
	 */
	initialNationalNumber?: string | null;
}>();

const emit = defineEmits<(event: "validity-changed", value: boolean) => void>();

const country = ref<Country>("US");
const showError = ref(false);
const touched = ref(false);

const isRequired = computed(() => props.required ?? false);

function formatPhone(digits: string): string {
	return new AsYouType(country.value).input(digits);
}

const initialDigits =
	typeof props.initialNationalNumber === "string"
		? props.initialNationalNumber.replace(/\D/g, "")
		: "";

const lastDigits = ref(initialDigits);
const phoneNumber = ref(initialDigits ? formatPhone(initialDigits) : "");

watch(country, () => {
	if (phoneNumber.value) {
		const digits = phoneNumber.value.replace(/\D/g, "");
		phoneNumber.value = formatPhone(digits);
		lastDigits.value = digits;
	}
});

const computedPlaceholder = computed(() => {
	const exampleNumber = getExampleNumber(country.value, examples);
	return exampleNumber ? exampleNumber.formatNational() : "(555) 555-5555";
});

function handlePhoneInput(e: Event) {
	touched.value = true;
	if (!(e.target instanceof HTMLInputElement)) {
		return;
	}

	const input = e.target;
	const previousDigits = lastDigits.value;

	let newDigits = input.value.replace(/\D/g, "");

	const inputType = (e as InputEvent).inputType;
	if (
		inputType === "deleteContentBackward" &&
		newDigits.length === previousDigits.length
	) {
		const selectionStart = input.selectionStart ?? input.value.length;
		const selectionEnd = input.selectionEnd ?? input.value.length;
		const isCaretSelectionCollapsed = selectionStart === selectionEnd;

		const isCaretAtEnd = selectionStart === input.value.length;
		if (!isCaretSelectionCollapsed || isCaretAtEnd) {
			newDigits = previousDigits.slice(0, -1);
		} else {
			const digitsBeforeCaret = input.value
				.slice(0, selectionStart)
				.replace(/\D/g, "").length;

			if (digitsBeforeCaret > 0) {
				newDigits =
					previousDigits.slice(0, digitsBeforeCaret - 1) +
					previousDigits.slice(digitsBeforeCaret);

				const formatted = formatPhone(newDigits);
				const targetDigitsBeforeCaret = digitsBeforeCaret - 1;

				// We format the value ourselves and set it on the input synchronously so
				// Vue sees the same value and doesn't need to patch the DOM input value.
				// That avoids timing workarounds (setTimeout/nextTick/requestAnimationFrame)
				// for caret management.
				input.value = formatted;

				if (targetDigitsBeforeCaret <= 0) {
					input.setSelectionRange(0, 0);
				} else {
					let seenDigits = 0;
					const foundIndex = Array.from(formatted).findIndex((char) => {
						if (/\d/.test(char)) {
							seenDigits++;
						}
						return seenDigits === targetDigitsBeforeCaret;
					});
					const caretPos = foundIndex >= 0 ? foundIndex + 1 : formatted.length;
					input.setSelectionRange(caretPos, caretPos);
				}

				phoneNumber.value = formatted;
				lastDigits.value = newDigits;
				return; // early return to skip duplicate formatting below
			}
		}
	}

	const formatted = formatPhone(newDigits);
	phoneNumber.value = formatted;
	lastDigits.value = newDigits;
}

const isValid = computed(() => {
	if (!phoneNumber.value) {
		return !isRequired.value;
	}
	return isValidPhoneNumber(phoneNumber.value, country.value);
});

watch(
	isValid,
	(valid) => {
		emit("validity-changed", valid);
	},
	{ immediate: true },
);

function validate() {
	if (phoneNumber.value) {
		showError.value = !isValidPhoneNumber(phoneNumber.value, country.value);
	} else {
		showError.value = isRequired.value;
	}
}

watch(
	() => props.formSubmitted,
	(submitted) => {
		if (submitted) {
			validate();
		}
	},
);
</script>

