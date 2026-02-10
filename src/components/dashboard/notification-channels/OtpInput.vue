<template>
	<div>
		<label
			:for="`${id}-0`"
			class="block text-sm font-medium text-gray-700 mb-2"
		>
			Enter Verification Code
		</label>
		<div class="grid grid-cols-6 gap-1.5 sm:gap-2 max-w-72">
			<input
				v-for="(digit, index) in digits"
				:key="index"
				:ref="(el) => setInputRef(el, index)"
				:id="`${id}-${index}`"
				:aria-label="`Verification code digit ${index + 1}`"
				type="text"
				inputmode="numeric"
				pattern="[0-9]"
				maxlength="1"
				:autocomplete="index === 0 ? 'one-time-code' : 'off'"
				spellcheck="false"
				:required="required && index === 0"
				:value="digit"
				@input="handleInput(index, $event)"
				@keydown="handleKeydown(index, $event)"
				@paste="handlePaste($event)"
				@focus="handleFocus(index)"
				@blur="handleBlur($event)"
				class="w-full aspect-square text-center text-base sm:text-lg font-semibold border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-primary"
				:class="{
					'border-error-strong ring-2 ring-error-strong': showError,
				}"
			/>
		</div>
		<input
			type="hidden"
			:name="name"
			:value="code"
		/>
	</div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{
	id: string;
	name?: string;
	required?: boolean;
	formSubmitted?: boolean;
}>();

const emit = defineEmits<(event: "input", value: string) => void>();

const CODE_LENGTH = 6;
const digits = ref<string[]>(Array(CODE_LENGTH).fill(""));
const inputRefs = ref<(HTMLInputElement | null)[]>([]);
const showError = ref(false);
const touched = ref(false);
const hasBlurred = ref(false);

/** Track each digit input element for focus/validation management. */
function setInputRef(el: unknown, index: number) {
	if (el instanceof HTMLInputElement) {
		inputRefs.value[index] = el;
	}
}

const code = computed(() => digits.value.join(""));

/**
 * Handle typing into a single OTP digit input.
 *
 * Enforces numeric-only input and supports multi-character entry (mobile autofill).
 */
function handleInput(index: number, event: Event) {
	if (!(event.target instanceof HTMLInputElement)) {
		return;
	}

	touched.value = true;
	const input = event.target;
	const value = input.value;

	if (!/^\d*$/.test(value)) {
		input.value = digits.value[index];
		return;
	}

	if (value.length > 1) {
		const chars = value.slice(0, CODE_LENGTH - index).split("");
		for (let i = 0; i < chars.length; i++) {
			const idx = index + i;
			digits.value[idx] = chars[i];
			const el = inputRefs.value[idx];
			if (el) {
				el.value = chars[i];
			}
		}
		if (chars.length < CODE_LENGTH - index) {
			for (let i = index + chars.length; i < CODE_LENGTH; i++) {
				digits.value[i] = "";
				const el = inputRefs.value[i];
				if (el) {
					el.value = "";
				}
			}
		}
		const lastIdx = index + chars.length - 1;
		const lastInput = inputRefs.value[lastIdx];
		if (lastInput) {
			lastInput.focus();
		}
		emit("input", code.value);
		validateOtp();
		return;
	}

	digits.value[index] = value;

	if (value && index < CODE_LENGTH - 1) {
		const nextInput = inputRefs.value[index + 1];
		if (nextInput) {
			nextInput.focus();
		}
	}

	emit("input", code.value);
	validateOtp();
}

/** Keyboard navigation (Backspace/Arrow keys) across OTP digit inputs. */
function handleKeydown(index: number, event: KeyboardEvent) {
	if (event.key === "Backspace" && !digits.value[index] && index > 0) {
		event.preventDefault();
		const prevInput = inputRefs.value[index - 1];
		if (prevInput) {
			prevInput.focus();
			prevInput.select();
		}
	} else if (event.key === "ArrowLeft" && index > 0) {
		event.preventDefault();
		const prevInput = inputRefs.value[index - 1];
		if (prevInput) {
			prevInput.focus();
		}
	} else if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
		event.preventDefault();
		const nextInput = inputRefs.value[index + 1];
		if (nextInput) {
			nextInput.focus();
		}
	}
}

/**
 * Paste handler for OTP codes.
 *
 * Extracts digits, fills inputs left-to-right, then focuses the last populated cell.
 */
function handlePaste(event: ClipboardEvent) {
	event.preventDefault();
	touched.value = true;
	const pastedData = event.clipboardData?.getData("text") || "";
	const digitsOnly = pastedData.replace(/\D/g, "").slice(0, CODE_LENGTH);

	if (digitsOnly.length === 0) {
		return;
	}

	for (let i = 0; i < CODE_LENGTH; i++) {
		digits.value[i] = digitsOnly[i] || "";
	}

	const focusIndex = Math.min(digitsOnly.length, CODE_LENGTH - 1);
	const input = inputRefs.value[focusIndex];
	if (input) {
		input.focus();
	}
	emit("input", code.value);
	validateOtp();
}

/** Select the digit on focus for quick replacement. */
function handleFocus(index: number) {
	const input = inputRefs.value[index];
	if (input) {
		touched.value = true;
		input.select();
	}
}

/**
 * Blur handler used to decide when to show validation feedback.
 *
 * When focus moves between OTP inputs, we do not treat that as a "real" blur.
 */
function handleBlur(event: FocusEvent) {
	const nextTarget = event.relatedTarget;
	if (nextTarget instanceof HTMLElement) {
		const isNextInput = inputRefs.value.some((input) => input === nextTarget);
		if (isNextInput) {
			return;
		}
	}

	hasBlurred.value = true;
	validateOtp();
}

/**
 * Validate completeness of the OTP code and set browser custom validity.
 *
 * This keeps native form validation accurate even when we delay showing errors visually.
 */
function validateOtp() {
	const isComplete = code.value.length === CODE_LENGTH;
	const isEmpty = code.value.length === 0;
	const firstInput = inputRefs.value[0];

	if (!firstInput) {
		return;
	}

	const shouldValidate = props.formSubmitted === true || hasBlurred.value;
	const shouldShowError =
		shouldValidate &&
		(props.required === true ? !isComplete : !isEmpty && !isComplete);
	showError.value = shouldShowError;

	// Custom validity should always reflect actual completeness when required,
	// regardless of whether we show the error visually. This ensures browser
	// validation prevents form submission with incomplete codes.
	const isInvalid =
		props.required === true ? !isComplete : !isEmpty && !isComplete;
	if (isInvalid) {
		firstInput.setCustomValidity("Please enter the complete verification code");
	} else {
		firstInput.setCustomValidity("");
	}
}

/** Public validator invoked by watchers and form-submission signals. */
function validate() {
	const firstInput = inputRefs.value[0];

	if (!firstInput) {
		return;
	}

	validateOtp();
	firstInput.reportValidity();
}

watch(
	() => props.formSubmitted,
	(submitted) => {
		if (submitted) {
			validate();
		}
	},
);

watch(code, () => {
	validateOtp();
});

// Ensure validation runs on mount to set initial custom validity.
// This prevents form submission with empty OTP even if the user never touches the field.
onMounted(() => {
	validateOtp();
});
</script>
