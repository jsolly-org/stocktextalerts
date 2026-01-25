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
				<span class="text-sm font-medium text-gray-700">Enabled</span>
			</label>
		</div>

		<slot name="setup" />

		<div class="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
			<div>
				<label
					for="daily_digest_notification_time"
					class="block text-sm font-medium text-gray-700 mb-1"
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
					class="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-strong focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					:disabled="sendNowDisabled"
					:aria-busy="isSending"
					@click="emit('send-now')"
				>
					<ArrowPathIcon
						v-if="isSending"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{{ isSending ? "Sending..." : "Send now" }}</span>
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../../icons/arrow-path.svg?component";
import TimePicker from "./TimePicker.vue";

interface Props {
	enabled: boolean;
	dailyDigestTime: string;
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	sendNowDisabled: boolean;
	isSending: boolean;
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
