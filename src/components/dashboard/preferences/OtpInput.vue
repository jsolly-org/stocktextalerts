<template>
	<div>
		<label
			:for="`${id}-0`"
			class="block text-sm font-medium text-slate-700 mb-2"
		>
			Enter Verification Code
		</label>
		<div class="flex gap-2">
			<input
				v-for="(digit, index) in digits"
				:key="index"
				:ref="(el) => setInputRef(el, index)"
				:id="`${id}-${index}`"
				type="text"
				inputmode="numeric"
				pattern="[0-9]"
				maxlength="1"
				autocomplete="one-time-code"
				:value="digit"
				@input="handleInput(index, $event)"
				@keydown="handleKeydown(index, $event)"
				@paste="handlePaste($event)"
				@focus="handleFocus(index)"
				class="w-12 h-12 text-center text-lg font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
				:class="{
					'border-red-500 ring-2 ring-red-500': showError,
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
import { computed, nextTick, ref, watch } from "vue";

const props = defineProps<{
	id: string;
	name?: string;
	required?: boolean;
	formSubmitted?: boolean;
}>();

const emit = defineEmits<{
	(event: "input"): void;
}>();

const CODE_LENGTH = 6;
const digits = ref<string[]>(Array(CODE_LENGTH).fill(""));
const inputRefs = ref<(HTMLInputElement | null)[]>([]);
const showError = ref(false);
const touched = ref(false);

function setInputRef(el: unknown, index: number) {
	if (el instanceof HTMLInputElement) {
		inputRefs.value[index] = el;
	}
}

const code = computed(() => digits.value.join(""));

function handleInput(index: number, event: Event) {
	if (!(event.target instanceof HTMLInputElement)) {
		return;
	}

	touched.value = true;
	const input = event.target;
	let value = input.value;

	if (!/^\d*$/.test(value)) {
		input.value = digits.value[index];
		return;
	}

	if (value.length > 1) {
		value = value.slice(-1);
	}

	digits.value[index] = value;

	if (value && index < CODE_LENGTH - 1) {
		nextTick(() => {
			const nextInput = inputRefs.value[index + 1];
			if (nextInput) {
				nextInput.focus();
			}
		});
	}

	emit("input");
	validateOtp();
}

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
	nextTick(() => {
		const input = inputRefs.value[focusIndex];
		if (input) {
			input.focus();
		}
		emit("input");
		validateOtp();
	});
}

function handleFocus(index: number) {
	const input = inputRefs.value[index];
	if (input) {
		touched.value = true;
		input.select();
	}
}

function validateOtp() {
	const isComplete = code.value.length === CODE_LENGTH;
	const isEmpty = code.value.length === 0;
	const firstInput = inputRefs.value[0];

	if (!firstInput) {
		return;
	}

	const shouldValidate = props.formSubmitted === true || touched.value;
	const shouldShowError =
		shouldValidate &&
		(props.required === true ? !isComplete : !isEmpty && !isComplete);
	showError.value = shouldShowError;

	if (shouldShowError) {
		firstInput.setCustomValidity("Please enter the complete verification code");
	} else {
		firstInput.setCustomValidity("");
	}
}

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
</script>
