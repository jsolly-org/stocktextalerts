<template>
	<fieldset
		data-autosave-ignore
		:class="[
			'divide-y divide-gray-100 transition-opacity duration-200',
			{ 'opacity-50': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="sr-only">Scheduled update settings</legend>

		<div class="flex items-center justify-between gap-3 py-3">
			<input
				type="hidden"
				name="only_notify_when_market_open"
				:value="onlyNotifyWhenMarketOpenValue ? 'on' : 'off'"
			/>
			<div class="min-w-0">
				<span
					id="only_notify_when_market_open_label"
					class="text-base font-semibold text-gray-900"
				>
					Only notify when market is open
				</span>
				<p id="only_notify_when_market_open_description" class="text-sm text-gray-600 mt-0.5">
					You won't be notified unless the market is open.
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

		<div class="py-3">
			<StatusMessage v-if="marketClosedSkipNote" class="mb-3" tone="info">
				{{ marketClosedSkipNote }}
			</StatusMessage>

			<fieldset class="grid gap-3">
				<legend class="block text-base font-semibold text-gray-900 mb-1">
					Delivery times
					<span class="block text-sm font-normal text-gray-600 mt-0.5">Choose up to 5 delivery times.</span>
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
		</div>
	</fieldset>

	<div v-if="!needsChannelSelection && isHydrated && countdownText" class="mt-4 border-t border-gray-200 pt-4">
		<p class="inline-flex items-center gap-2 text-sm text-gray-600">
			<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
			<span>Next delivery <span class="font-medium text-gray-900">{{ countdownText }}</span></span>
		</p>
	</div>
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
