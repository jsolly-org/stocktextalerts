<template>
	<fieldset class="divide-y divide-divider" :disabled="disabled">
		<legend class="sr-only">Format preferences</legend>

		<div class="flex items-center justify-between gap-3 py-3">
			<input
				type="hidden"
				name="show_sparklines"
				:value="showSparklinesValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<span
					id="show_sparklines_label"
					class="text-base font-semibold text-heading"
				>
					Show Sparklines
				</span>
				<p id="show_sparklines_description" class="text-sm text-body-secondary mt-0.5">
					Display a weekly price trend sparkline next to each asset.
				</p>
			</div>
			<ToggleSwitch
				v-model="showSparklinesValue"
				sr-label="Show sparklines"
				aria-labelledby="show_sparklines_label"
				aria-describedby="show_sparklines_description"
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
					class="text-base font-semibold text-heading"
				>
					Asset Name
				</span>
				<p id="show_company_name_description" class="text-sm text-body-secondary mt-0.5">
					Include the full asset name next to the ticker symbol.
				</p>
			</div>
			<ToggleSwitch
				v-model="showCompanyNameValue"
				sr-label="Show asset name"
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
					class="text-base font-semibold text-heading"
				>
					More Space
				</span>
				<p id="detailed_format_description" class="text-sm text-body-secondary mt-0.5">
					Add blank lines between each asset for easier reading.
				</p>
			</div>
			<ToggleSwitch
				v-model="detailedFormatValue"
				sr-label="More space"
				aria-labelledby="detailed_format_label"
				aria-describedby="detailed_format_description"
			/>
		</div>
	</fieldset>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import ToggleSwitch from "../../../ToggleSwitch.vue";

interface Props {
	showSparklines: boolean;
	showCompanyName: boolean;
	detailedFormat: boolean;
	disabled?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	(event: "update:showSparklines", value: boolean): void;
	(event: "update:showCompanyName", value: boolean): void;
	(event: "update:detailedFormat", value: boolean): void;
}>();

const showSparklinesValue = computed({
	get: () => props.showSparklines,
	set: (value: boolean) => emit("update:showSparklines", value),
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
