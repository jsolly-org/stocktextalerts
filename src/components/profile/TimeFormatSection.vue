<template>
	<section
		class="card"
		aria-labelledby="time-format-heading"
	>
		<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
		<div class="card-body">
			<div class="flex items-center gap-3 mb-2">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-active">
					<ClockIcon class="size-5 text-body-secondary" aria-hidden="true" />
				</div>
				<h2 id="time-format-heading" class="text-2xl font-bold text-heading">Time Format</h2>
			</div>
			<p class="text-body-secondary text-sm mb-6">
				Choose how times are displayed throughout the app.
			</p>

			<StatusMessage
				v-if="statusMessage"
				:tone="statusTone"
				class="mb-4"
			>
				{{ statusMessage }}
			</StatusMessage>

			<div class="flex items-center justify-between gap-3 py-3">
				<div class="min-w-0">
					<span
						id="use_24_hour_time_label"
						class="text-base font-semibold text-heading"
					>
						Use 24-hour time
					</span>
					<p
						id="use_24_hour_time_description"
						class="text-sm text-body-secondary mt-0.5"
					>
						e.g. 14:30 instead of 2:30 PM
					</p>
				</div>
				<ToggleSwitch
					v-model="use24HourTime"
					sr-label="Use 24-hour time"
					aria-labelledby="use_24_hour_time_label"
					aria-describedby="use_24_hour_time_description"
					:disabled="isSaving"
				/>
			</div>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { nextTick, ref, watch } from "vue";

import ClockIcon from "../../icons/clock.svg?component";
import { CARD_GRADIENT_ACCENTS } from "../../lib/constants";
import type { User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import StatusMessage from "../StatusMessage.vue";
import ToggleSwitch from "../ToggleSwitch.vue";

interface Props {
	user: User;
}

const props = defineProps<Props>();

const use24HourTime = ref(props.user.use_24_hour_time ?? false);
const isSaving = ref(false);
const isReverting = ref(false);
const statusMessage = ref<string | null>(null);
const statusTone = ref<"success" | "error">("success");

watch(use24HourTime, () => {
	if (isReverting.value) return;
	void saveTimeFormat();
});

async function saveTimeFormat() {
	isSaving.value = true;
	statusMessage.value = null;

	try {
		const formData = new FormData();
		formData.set("use_24_hour_time", use24HourTime.value ? "on" : "off");

		const response = await fetch("/api/profile/time-format", {
			method: "POST",
			body: formData,
		});

		const data = await response.json();

		if (!response.ok || !data.ok) {
			statusMessage.value = "Failed to update time format. Please try again.";
			statusTone.value = "error";
			isReverting.value = true;
			use24HourTime.value = !use24HourTime.value;
			await nextTick();
			isReverting.value = false;
			return;
		}

		statusMessage.value = "Time format updated.";
		statusTone.value = "success";
	} catch (error) {
		rootLogger.error(
			"Failed to update time format from profile",
			{ action: "update_time_format" },
			error,
		);
		statusMessage.value = "Failed to update time format. Please try again.";
		statusTone.value = "error";
		isReverting.value = true;
		use24HourTime.value = !use24HourTime.value;
		await nextTick();
		isReverting.value = false;
	} finally {
		isSaving.value = false;
	}
}
</script>
