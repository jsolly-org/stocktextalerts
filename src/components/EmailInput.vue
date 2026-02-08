<template>
	<input
		v-bind="inputAttrs"
		@keydown="handleKeydown"
		@paste="handlePaste"
		@input="handleInput"
		@change="handleChange"
	/>
</template>

<script lang="ts" setup>
import { computed, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
	modelValue?: string;
	value?: string;
	id?: string;
	name?: string;
	type?: string;
	autocomplete?: string;
	required?: boolean;
	placeholder?: string;
	class?: string;
}>();

const emit = defineEmits<{
	(event: "update:modelValue", value: string): void;
	(event: "input", payload: Event): void;
	(event: "change", payload: Event): void;
}>();

const attrs = useAttrs();

const inputAttrs = computed(() => {
	return {
		type: props.type ?? "email",
		autocomplete: props.autocomplete ?? "email",
		id: props.id,
		name: props.name,
		required: props.required,
		placeholder: props.placeholder,
		class: props.class,
		value: props.modelValue ?? props.value,
		...attrs,
	};
});

function handleKeydown(event: KeyboardEvent) {
	if (event.key === " ") {
		event.preventDefault();
	}
}

function handlePaste(event: ClipboardEvent) {
	if (!event.clipboardData || !(event.target instanceof HTMLInputElement)) {
		return;
	}

	event.preventDefault();
	const paste = event.clipboardData.getData("text").replace(/\s/g, "");

	const input = event.target;
	const currentValue = input.value;
	const selectionStart = input.selectionStart ?? currentValue.length;
	const selectionEnd = input.selectionEnd ?? currentValue.length;

	input.value =
		currentValue.slice(0, selectionStart) +
		paste +
		currentValue.slice(selectionEnd);

	const caretPosition = selectionStart + paste.length;
	input.setSelectionRange(caretPosition, caretPosition);

	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function handleInput(event: Event) {
	if (!(event.target instanceof HTMLInputElement)) {
		return;
	}

	emit("update:modelValue", event.target.value);
	emit("input", event);
}

function handleChange(event: Event) {
	emit("change", event);
}
</script>
