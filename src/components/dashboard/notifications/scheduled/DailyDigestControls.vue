<template>
	<fieldset
		:class="[
			'mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4',
			{ 'opacity-60': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="sr-only">Daily digest settings</legend>
		<div>
			<div class="flex items-start gap-3">
				<label
					:class="[
						'inline-flex items-center select-none mt-0.5',
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
						class="h-5 w-5 cursor-pointer disabled:cursor-not-allowed"
						v-model="enabledValue"
						:disabled="needsChannelSelection"
						aria-labelledby="daily_digest_label"
					/>
				</label>
				<div>
					<div class="flex items-center gap-3">
						<h3 id="daily_digest_label" class="text-base font-semibold text-gray-900">Daily Digest</h3>
						<span
							class="inline-flex items-center rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-600"
						>
							Up to multiple times per day
						</span>
					</div>
					<p class="text-sm text-gray-600 mt-1">
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
					class="flex items-center gap-2"
				>
					<TimePicker
						:inputId="`daily_digest_notification_time_${index}`"
						:inputName="`daily_digest_notification_time_${index}`"
						:initialTime="time"
						:disabled="timePickerDisabled"
						@time-change="emit('time-change', index, $event)"
					/>
					<button
						v-if="dailyDigestTimes.length > 1"
						type="button"
						class="btn btn-sm btn-ghost text-error-text hover:bg-error-bg hover:text-error-text shrink-0"
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
					class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
					:disabled="!canAddTime"
					@click="emit('add-time')"
				>
					<PlusIcon class="size-4 shrink-0" aria-hidden="true" />
					Add time
				</button>
			</div>
		</fieldset>
		<p v-if="!needsChannelSelection" class="mt-3 text-sm text-gray-600">
			<template v-if="isHydrated && countdownText">
				Will be sent {{ countdownText }}. Want to receive it earlier?
			</template>
			<template v-else>
				Want to receive it earlier?
			</template>
			<button
				type="button"
				class="link-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
				:disabled="sendNowDisabled"
				:aria-busy="isSending"
				@click="emit('send-now')"
			>
				<ArrowPathIcon
					v-if="isSending"
					class="animate-spin size-4 shrink-0 inline align-middle"
					aria-hidden="true"
				/>
				{{ isSending ? "sending…" : "send digest notification now" }}
			</button>.
		</p>
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
	sendNowDisabled: boolean;
	isSending: boolean;
	countdownText: string | null;
}

const props = defineProps<Props>();

const isHydrated = ref(false);

const emit = defineEmits<{
	(event: "update:enabled", value: boolean): void;
	(event: "send-now"): void;
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
