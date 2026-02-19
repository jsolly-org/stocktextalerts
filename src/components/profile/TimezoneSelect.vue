<template>
	<div>
		<label :for="id" class="block text-sm font-medium text-label mb-1">
			Timezone <span class="text-error-text">*</span>
		</label>
		<select
			:id="id"
			v-model="selectedValue"
			name="timezone"
			required
			class="input cursor-pointer"
			:disabled="disabled"
			@change="handleChange"
		>
			<option value="" disabled hidden>
				Select your timezone
			</option>
			<option v-for="tz in timezones" :key="tz.value" :value="tz.value">
				{{ tz.label }}
			</option>
		</select>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";

import type { TimezoneOption } from "../../lib/time/types";

interface Props {
	id: string;
	modelValue: string;
	timezones: TimezoneOption[];
	disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	disabled: false,
});

const emit = defineEmits<{
	(event: "update:modelValue", value: string): void;
	(event: "change"): void;
}>();

const selectedValue = computed({
	get: () => props.modelValue,
	set: (value: string) => emit("update:modelValue", value),
});

function handleChange() {
	emit("change");
}
</script>
