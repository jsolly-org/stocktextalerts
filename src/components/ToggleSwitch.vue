<template>
	<button
		type="button"
		role="switch"
		:aria-checked="modelValue ? 'true' : 'false'"
		:aria-labelledby="ariaLabelledby"
		:aria-describedby="ariaDescribedby"
		:disabled="disabled"
		class="group relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
		:class="modelValue ? 'bg-primary' : 'bg-toggle-off'"
		@click="toggle"
	>
		<span class="sr-only">{{ srLabel }}</span>
		<span
			aria-hidden="true"
			class="pointer-events-none block size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.16)] ring-1 ring-black/5 transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
			:class="modelValue ? 'translate-x-[20px]' : 'translate-x-0'"
		/>
	</button>
</template>

<script lang="ts" setup>
interface Props {
	srLabel?: string;
	ariaLabelledby?: string;
	ariaDescribedby?: string;
	disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	srLabel: "Toggle",
	ariaLabelledby: undefined,
	ariaDescribedby: undefined,
	disabled: false,
});

const modelValue = defineModel<boolean>({ required: true });

function toggle() {
	if (props.disabled) return;
	modelValue.value = !modelValue.value;
}
</script>
