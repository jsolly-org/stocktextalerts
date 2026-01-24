<template>
	<div
		:class="[
			'mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4',
			{ 'opacity-60': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<div class="flex items-start justify-between gap-4">
			<div>
				<div class="flex items-center gap-3">
					<h3 class="text-base font-semibold text-gray-900">Daily Digest</h3>
					<span
						class="inline-flex items-center rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-600"
					>
						Once per day
					</span>
				</div>
				<p class="text-sm text-gray-600 mt-1">
					A summary of your tracked stocks, delivered using your selected
					notification channels.
				</p>
			</div>

			<label
				:class="[
					'inline-flex items-center gap-2 select-none',
					needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer',
				]"
			>
				<input
					type="hidden"
					name="daily_digest_enabled"
					:value="enabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					name="daily_digest_enabled"
					value="on"
					id="daily_digest_enabled"
					class="h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
					v-model="enabledValue"
					:disabled="needsChannelSelection"
				/>
				<span class="text-sm font-medium text-slate-700">Enabled</span>
			</label>
		</div>

		<slot name="setup" />

		<div class="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
			<div>
				<label
					for="daily_digest_notification_time"
					class="block text-sm font-medium text-slate-700 mb-1"
				>
					Delivery time
				</label>
				<TimePicker
					inputId="daily_digest_notification_time"
					inputName="daily_digest_notification_time"
					:initialTime="dailyDigestTime"
					:disabled="timePickerDisabled"
					@time-change="emit('time-change', $event)"
				/>
			</div>

			<div class="sm:text-right">
				<button
					type="button"
					class="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed"
					:disabled="sendNowDisabled"
					@click="emit('send-now')"
				>
					Send now
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";

import TimePicker from "./TimePicker.vue";

interface Props {
	enabled: boolean;
	dailyDigestTime: string;
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	sendNowDisabled: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	(event: "update:enabled", value: boolean): void;
	(event: "send-now"): void;
	(event: "time-change", value: string): void;
}>();

const enabledValue = computed({
	get: () => props.enabled,
	set: (value: boolean) => emit("update:enabled", value),
});

</script>
