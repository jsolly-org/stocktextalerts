<template>
	<div ref="rootElement">
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
						class="w-full appearance-none rounded-l-lg py-2 pl-3 pr-8 text-base text-gray-500 focus:outline-none border-r border-slate-300 bg-white bg-no-repeat"
						style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M7%208l3%203%203-3%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E'); background-position: right 0.25rem center; background-size: 1.25em 1.25em;"
					>
						<option value="US">+1</option>
					</select>
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
					:data-phone-is-valid="isValid ? 'true' : 'false'"
					class="w-full rounded-r-lg py-2 px-3 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none"
					:placeholder="computedPlaceholder"
					name="phone"
					:required="isRequired"
					inputmode="tel"
					autocomplete="tel-national"
				/>
					<div v-if="phoneNumber" class="absolute inset-y-0 right-3 flex items-center pointer-events-none">
						<CheckCircleIcon v-if="isValid" class="h-5 w-5 text-green-500" aria-hidden="true" />
						<ExclamationCircleIcon v-else class="h-5 w-5 text-red-500" aria-hidden="true" />
					</div>
				</div>
			</div>
		</div>
		<p v-if="showError" id="phone-error" role="alert" class="mt-1 text-sm text-red-600">Please enter a valid phone number</p>
	</div>
</template>

<script lang="ts" setup>
import { CheckCircleIcon, ExclamationCircleIcon } from "@heroicons/vue/24/solid";
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

const rootElement = ref<HTMLElement>();

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
	[isValid, rootElement],
	([valid]) => {
		if (rootElement.value) {
			const event = new CustomEvent("phone-validity-changed", {
				bubbles: true,
				detail: { isValid: valid },
			});
			rootElement.value.dispatchEvent(event);
		}
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

