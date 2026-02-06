<template>
	<button
		type="button"
		role="switch"
		:aria-checked="modelValue"
		:aria-labelledby="ariaLabelledby"
		:aria-describedby="ariaDescribedby"
		class="group relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
		:class="modelValue ? 'bg-primary' : 'bg-gray-300'"
		@click="toggle"
	>
		<span class="sr-only">{{ srLabel }}</span>
		<span
			aria-hidden="true"
			class="pointer-events-none inline-block size-5 rounded-full bg-white shadow-md ring-0 transition-all duration-200 ease-in-out"
			:class="modelValue ? 'translate-x-6' : 'translate-x-1'"
		/>
	</button>
</template>

<script lang="ts" setup>
interface Props {
	modelValue: boolean;
	srLabel?: string;
	ariaLabelledby?: string;
	ariaDescribedby?: string;
}

const props = withDefaults(defineProps<Props>(), {
	srLabel: "Toggle",
	ariaLabelledby: undefined,
	ariaDescribedby: undefined,
});

const emit = defineEmits<(event: "update:modelValue", value: boolean) => void>();

function toggle() {
	const nextValue = !props.modelValue;
	emit("update:modelValue", nextValue);
}
</script>
