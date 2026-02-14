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

	</fieldset>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import ToggleSwitch from "../../../ToggleSwitch.vue";

interface Props {
	showSparklines: boolean;
	disabled?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<(event: "update:showSparklines", value: boolean) => void>();

const showSparklinesValue = computed({
	get: () => props.showSparklines,
	set: (value: boolean) => emit("update:showSparklines", value),
});

</script>
