<template>
	<fieldset
		data-autosave-ignore
		:class="[
			'mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4',
			{ 'opacity-60': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="sr-only">Scheduled update settings</legend>
		<div class="flex gap-3 sm:gap-4">
			<input
				type="hidden"
				name="scheduled_updates_enabled"
				:value="enabledValue ? 'on' : 'off'"
			/>
			<input
				type="checkbox"
				value="on"
				id="scheduled_updates_enabled"
				class="mt-1 h-5 w-5 shrink-0 cursor-pointer rounded border-gray-300 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed"
				:checked="needsChannelSelection || enabledValue"
				:disabled="needsChannelSelection"
				@change="enabledValue = ($event.target as HTMLInputElement).checked"
				aria-labelledby="scheduled_updates_label"
				aria-describedby="scheduled_updates_description"
			/>
			<div class="min-w-0">
				<label
					id="scheduled_updates_label"
					for="scheduled_updates_enabled"
					:class="[
						'text-base font-semibold text-gray-900',
						needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer',
					]"
				>
					Scheduled Updates
				</label>
				<p id="scheduled_updates_description" class="text-sm text-gray-600 mt-0.5">
					A summary of your tracked stocks, delivered using your selected
					notification channels.
				</p>
			</div>
		</div>

		<slot name="setup" />

		<fieldset class="mt-4 grid gap-3">
			<legend class="block text-sm font-medium text-gray-700 mb-1">
				Delivery times
			</legend>
			<input
				type="hidden"
				name="scheduled_update_times"
				:value="serializedTimes"
			/>
			<div class="space-y-3">
				<div
					v-for="(time, index) in scheduledUpdateTimes"
					:key="`${index}-${time}`"
					class="flex flex-col gap-2 sm:flex-row sm:items-center"
				>
					<TimePicker
						:inputId="`scheduled_update_time_${index}`"
						:inputName="`scheduled_update_time_${index}`"
						:initialTime="time"
						:inputAriaLabel="`Delivery time ${index + 1}`"
						:disabled="timePickerDisabled"
						@time-change="emit('time-change', index, $event)"
					/>
					<button
						v-if="scheduledUpdateTimes.length > 1"
						type="button"
						class="btn btn-sm btn-ghost text-error-text hover:bg-error-bg hover:text-error-text shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 self-start sm:self-auto"
						:aria-label="`Remove delivery time ${index + 1}`"
						@click="emit('remove-time', index)"
					>
						Remove
					</button>
				</div>
			</div>
			<div class="flex justify-start">
				<button
					type="button"
					class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
					:disabled="!canAddTime"
					aria-label="Add an additional delivery time"
					@click="emit('add-time')"
				>
					<PlusIcon class="size-4 shrink-0" aria-hidden="true" />
					Add an additional delivery time
				</button>
			</div>
		</fieldset>
		<div v-if="!needsChannelSelection" class="mt-4 border-t border-gray-200 pt-4">
			<p v-if="isHydrated && countdownText" class="inline-flex items-center gap-2 text-sm text-gray-600">
				<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
				<span>Next delivery <span class="font-medium text-gray-900">{{ countdownText }}</span>.</span>
			</p>
		</div>
	</fieldset>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import PlusIcon from "../../../icons/plus.svg?component";
import TimePicker from "./TimePicker.vue";

interface Props {
	enabled: boolean;
	scheduledUpdateTimes: string[];
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	canAddTime: boolean;
	countdownText: string | null;
}

const props = defineProps<Props>();

const isHydrated = ref(false);

const emit = defineEmits<{
	(event: "update:enabled", value: boolean): void;
	(event: "time-change", index: number, value: string): void;
	(event: "add-time"): void;
	(event: "remove-time", index: number): void;
}>();

onMounted(() => {
	isHydrated.value = true;
});

const enabledValue = computed({
	get: () => props.enabled,
	set: (value: boolean) => emit("update:enabled", value),
});

const serializedTimes = computed(() => JSON.stringify(props.scheduledUpdateTimes));
</script>
