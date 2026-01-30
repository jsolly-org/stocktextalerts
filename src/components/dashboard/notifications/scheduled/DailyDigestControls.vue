<template>
	<fieldset
		data-autosave-ignore
		:class="[
			'mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4',
			{ 'opacity-60': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="sr-only">Daily digest settings</legend>
		<div>
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start">
				<label
					:class="[
						'inline-flex items-center select-none mt-0.5 -m-2 p-2',
						needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer',
					]"
					for="daily_digest_enabled"
				>
					<input
						type="hidden"
						name="daily_digest_enabled"
						:value="enabledValue ? 'on' : 'off'"
					/>
					<input
						type="checkbox"
						value="on"
						id="daily_digest_enabled"
						class="h-6 w-6 cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
						v-model="enabledValue"
						:disabled="needsChannelSelection"
						aria-labelledby="daily_digest_label"
						aria-describedby="daily_digest_description"
					/>
				</label>
				<div>
					<div class="flex items-center gap-3">
						<h3 id="daily_digest_label" class="text-base font-semibold text-gray-900">Daily Digest</h3>
					</div>
					<p id="daily_digest_description" class="text-sm text-gray-600 mt-1">
						A summary of your tracked stocks, delivered using your selected
						notification channels.
					</p>
				</div>
			</div>
		</div>

		<slot name="setup" />

		<fieldset class="mt-4 grid gap-3">
			<legend class="block text-sm font-medium text-gray-700 mb-1">
				Delivery times
			</legend>
			<input
				type="hidden"
				name="daily_digest_notification_times"
				:value="serializedTimes"
			/>
			<div class="space-y-3">
				<div
					v-for="(time, index) in dailyDigestTimes"
					:key="`${index}-${time}`"
					class="flex flex-col gap-2 sm:flex-row sm:items-center"
				>
					<TimePicker
						:inputId="`daily_digest_notification_time_${index}`"
						:inputName="`daily_digest_notification_time_${index}`"
						:initialTime="time"
						:inputAriaLabel="`Delivery time ${index + 1}`"
						:disabled="timePickerDisabled"
						@time-change="emit('time-change', index, $event)"
					/>
					<button
						v-if="dailyDigestTimes.length > 1"
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
					class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
					:disabled="!canAddTime"
					aria-label="Add an additional delivery time"
					@click="emit('add-time')"
				>
					<PlusIcon class="size-4 shrink-0" aria-hidden="true" />
					Add an additional delivery time
				</button>
			</div>
		</fieldset>
		<div class="mt-4 flex flex-wrap items-center gap-3">
			<button
				type="submit"
				class="btn btn-sm btn-primary"
				:disabled="saveDisabled"
				:aria-busy="isSaving"
			>
				<ArrowPathIcon
					v-if="isSaving"
					class="animate-spin size-4 shrink-0"
					aria-hidden="true"
				/>
				{{ isSaving ? "Saving…" : "Update Delivery Times" }}
			</button>
		</div>
		<div v-if="!needsChannelSelection" class="mt-4 border-t border-gray-200 pt-4">
			<p v-if="isHydrated && countdownText" class="text-sm text-gray-600">
				Next delivery {{ countdownText }}.
			</p>
		</div>
	</fieldset>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../../icons/arrow-path.svg?component";
import PlusIcon from "../../../../icons/plus.svg?component";
import TimePicker from "./TimePicker.vue";

interface Props {
	enabled: boolean;
	dailyDigestTimes: string[];
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	canAddTime: boolean;
	saveDisabled: boolean;
	isSaving: boolean;
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

const serializedTimes = computed(() => JSON.stringify(props.dailyDigestTimes));
</script>
