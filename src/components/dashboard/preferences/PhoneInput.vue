<template>
	<div>
		<label for="phone" class="block text-sm font-medium text-slate-700 mb-1">
			Phone Number
		</label>
		<div class="flex">
			<div
				class="group relative flex w-full rounded-lg border border-slate-300 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500"
				:class="{
					'border-red-500 ring-2 ring-red-500': showError,
					'border-green-500 ring-2 ring-green-500': isValid && phoneNumber,
				}"
			>
			<div class="relative w-24">
				<select
					id="country"
					name="country"
					v-model="country"
					autocomplete="country"
					aria-label="Country"
					class="w-full appearance-none rounded-l-lg py-2 pl-3 pr-8 text-base text-gray-500 focus:outline-none border-r border-slate-300 bg-white"
				>
					<option value="US">+1</option>
				</select>
				<div class="absolute inset-y-0 right-1 flex items-center pointer-events-none">
					<Icon name="chevron-down" class="h-5 w-5 text-gray-500" />
				</div>
					<input type="hidden" name="phone_country_code" :value="`+${getCountryCallingCode(country)}`" />
					<input type="hidden" name="phone_national_number" :value="lastDigits" />
				</div>
				<div class="flex-1 relative">
				<input
					type="tel"
					id="phone"
					v-model="phoneNumber"
					@input="handlePhoneInput"
					@focus="touched = true"
					@blur="validate"
					:aria-describedby="showError ? 'phone-error' : undefined"
					:aria-invalid="showError ? 'true' : undefined"
					class="w-full rounded-r-lg py-2 px-3 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none"
					:placeholder="computedPlaceholder"
					name="phone"
					:required="isRequired"
					inputmode="tel"
					autocomplete="tel-national"
				/>
					<div v-if="phoneNumber" class="absolute inset-y-0 right-3 flex items-center pointer-events-none">
						<svg
							v-if="isValid"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="currentColor"
							class="h-5 w-5 text-green-500"
							aria-hidden="true"
						>
							<path
								fill-rule="evenodd"
								d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
								clip-rule="evenodd"
							/>
						</svg>
						<svg
							v-else
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="currentColor"
							class="h-5 w-5 text-red-500"
							aria-hidden="true"
						>
							<path
								fill-rule="evenodd"
								d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
								clip-rule="evenodd"
							/>
						</svg>
					</div>
				</div>
			</div>
		</div>
		<p v-if="showError" id="phone-error" role="alert" class="mt-1 text-sm text-red-600">Please enter a valid phone number</p>
	</div>
</template>

<script lang="ts" setup>
import { AsYouType, getCountryCallingCode, getExampleNumber, isValidPhoneNumber } from "libphonenumber-js";
import examples from "libphonenumber-js/examples.mobile.json";
import { computed, ref, watch } from "vue";

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

const emit = defineEmits<{
	(event: "validity-changed", value: boolean): void;
}>();

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
	if (inputType === "deleteContentBackward" && newDigits.length === previousDigits.length) {
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
					const caretPos =
						foundIndex >= 0 ? foundIndex + 1 : formatted.length;
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
	return phoneNumber.value ? isValidPhoneNumber(phoneNumber.value, country.value) : false;
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
		showError.value = touched.value || props.formSubmitted === true;
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

