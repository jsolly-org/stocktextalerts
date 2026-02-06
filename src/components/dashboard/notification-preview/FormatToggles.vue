<template>
	<fieldset class="divide-y divide-gray-100" :disabled="disabled">
		<legend class="sr-only">Format preferences</legend>

		<div class="flex items-center justify-between gap-3 py-3">
			<input
				type="hidden"
				name="show_change_percent"
				:value="showChangePercentValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<span
					id="show_change_percent_label"
					class="text-base font-semibold text-gray-900"
				>
					Show Change %
				</span>
				<p id="show_change_percent_description" class="text-sm text-gray-600 mt-0.5">
					Display the percentage change alongside the price.
				</p>
			</div>
			<ToggleSwitch
				v-model="showChangePercentValue"
				sr-label="Show change percent"
				aria-labelledby="show_change_percent_label"
				aria-describedby="show_change_percent_description"
			/>
		</div>

		<div class="flex items-center justify-between gap-3 py-3">
			<input
				type="hidden"
				name="show_company_name"
				:value="showCompanyNameValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<span
					id="show_company_name_label"
					class="text-base font-semibold text-gray-900"
				>
					Show Company Name
				</span>
				<p id="show_company_name_description" class="text-sm text-gray-600 mt-0.5">
					Include the full company name next to the ticker symbol.
				</p>
			</div>
			<ToggleSwitch
				v-model="showCompanyNameValue"
				sr-label="Show company name"
				aria-labelledby="show_company_name_label"
				aria-describedby="show_company_name_description"
			/>
		</div>

		<div class="flex items-center justify-between gap-3 py-3">
			<input
				type="hidden"
				name="detailed_format"
				:value="detailedFormatValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<span
					id="detailed_format_label"
					class="text-base font-semibold text-gray-900"
				>
					Detailed Format
				</span>
				<p id="detailed_format_description" class="text-sm text-gray-600 mt-0.5">
					Add extra spacing between stocks for easier reading.
				</p>
			</div>
			<ToggleSwitch
				v-model="detailedFormatValue"
				sr-label="Detailed format"
				aria-labelledby="detailed_format_label"
				aria-describedby="detailed_format_description"
			/>
		</div>
	</fieldset>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import ToggleSwitch from "../../ToggleSwitch.vue";

interface Props {
	showChangePercent: boolean;
	showCompanyName: boolean;
	detailedFormat: boolean;
	disabled?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	(event: "update:showChangePercent", value: boolean): void;
	(event: "update:showCompanyName", value: boolean): void;
	(event: "update:detailedFormat", value: boolean): void;
}>();

const showChangePercentValue = computed({
	get: () => props.showChangePercent,
	set: (value: boolean) => emit("update:showChangePercent", value),
});

const showCompanyNameValue = computed({
	get: () => props.showCompanyName,
	set: (value: boolean) => emit("update:showCompanyName", value),
});

const detailedFormatValue = computed({
	get: () => props.detailedFormat,
	set: (value: boolean) => emit("update:detailedFormat", value),
});
</script>
