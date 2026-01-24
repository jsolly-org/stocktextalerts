<template>
	<div>
		<label :for="id" class="block text-sm font-medium text-slate-700 mb-1">
			Timezone <span class="text-red-500">*</span>
		</label>
		<select
			:id="id"
			v-model="selectedValue"
			name="timezone"
			required
			class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer disabled:bg-gray-100 disabled:cursor-not-allowed"
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

import type { TimezoneOption } from "../../../lib/time/cache";

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
