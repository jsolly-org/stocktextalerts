<template>
	<fieldset
		data-autosave-ignore
		:class="[
			'mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 sm:p-5',
			{ 'opacity-60': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="text-sm font-semibold text-gray-800 mb-1">Scheduled update settings</legend>

		<div class="mt-3 flex items-start justify-between gap-4">
			<input
				type="hidden"
				name="only_notify_when_market_open"
				:value="onlyNotifyWhenMarketOpenValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<label
					id="only_notify_when_market_open_label"
					for="only_notify_when_market_open"
					:class="[
						'text-sm font-medium text-gray-900',
						needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer',
					]"
				>
					Only notify when market is open
				</label>
				<p id="only_notify_when_market_open_description" class="text-sm text-gray-500 mt-0.5">
					Scheduled updates are skipped when the market is closed.
				</p>
			</div>
			<ToggleSwitch
				v-model="onlyNotifyWhenMarketOpenValue"
				:disabled="needsChannelSelection"
				sr-label="Only notify when market is open"
				aria-labelledby="only_notify_when_market_open_label"
				aria-describedby="only_notify_when_market_open_description"
			/>
		</div>

		<StatusMessage v-if="marketClosedSkipNote" class="mt-4" tone="info">
			{{ marketClosedSkipNote }}
		</StatusMessage>

		<fieldset class="mt-5 grid gap-3">
			<legend class="block text-sm font-semibold text-gray-800 mb-1">
				Delivery times
			</legend>
			<input
				type="hidden"
				name="scheduled_update_times"
				:value="serializedTimes"
			/>
			<div class="space-y-2">
				<div
					v-for="(time, index) in scheduledUpdateTimes"
					:key="`${index}-${time}`"
					class="flex items-center gap-2"
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
						class="inline-flex items-center justify-center size-8 shrink-0 rounded-lg text-gray-400 hover:bg-error-bg hover:text-error-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2"
						:aria-label="`Remove delivery time ${index + 1}`"
						@click="emit('remove-time', index)"
					>
						<XMarkIcon class="size-4" aria-hidden="true" />
					</button>
				</div>
			</div>
			<div class="flex flex-col gap-2">
				<button
					type="button"
					class="btn btn-sm btn-secondary self-start"
					:disabled="!canAddTime"
					aria-label="Add delivery time"
					@click="emit('add-time')"
				>
					<PlusIcon class="size-4 shrink-0" aria-hidden="true" />
					Add time
				</button>
				<StatusMessage v-if="maxTimesReached" tone="warning">
					You've reached the maximum of {{ maxTimes }} delivery times.
				</StatusMessage>
			</div>
		</fieldset>
		<div v-if="!needsChannelSelection && isHydrated && countdownText" class="mt-5 rounded-lg border border-success-border bg-success-bg/50 px-4 py-3">
			<p class="flex items-center gap-2 text-sm text-success-text">
				<BellAlertIcon class="size-4 shrink-0" aria-hidden="true" />
				<span>Next delivery <span class="font-semibold">{{ countdownText }}</span></span>
			</p>
		</div>
	</fieldset>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import PlusIcon from "../../../icons/plus.svg?component";
import XMarkIcon from "../../../icons/x-mark.svg?component";
import StatusMessage from "../../StatusMessage.vue";
import ToggleSwitch from "../../ToggleSwitch.vue";
import TimePicker from "./TimePicker.vue";

interface Props {
	scheduledUpdateTimes: string[];
	onlyNotifyWhenMarketOpen: boolean;
	marketClosedSkipNote: string | null;
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	canAddTime: boolean;
	maxTimes: number;
	maxTimesReached: boolean;
	countdownText: string | null;
}

const props = defineProps<Props>();

const isHydrated = ref(false);

const emit = defineEmits<{
	(event: "update:onlyNotifyWhenMarketOpen", value: boolean): void;
	(event: "time-change", index: number, value: string): void;
	(event: "add-time"): void;
	(event: "remove-time", index: number): void;
}>();

onMounted(() => {
	isHydrated.value = true;
});

const onlyNotifyWhenMarketOpenValue = computed({
	get: () => props.onlyNotifyWhenMarketOpen,
	set: (value: boolean) => emit("update:onlyNotifyWhenMarketOpen", value),
});

const serializedTimes = computed(() => JSON.stringify(props.scheduledUpdateTimes));
</script>
