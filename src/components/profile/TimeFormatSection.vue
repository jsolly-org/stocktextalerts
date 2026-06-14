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
				/>
			</div>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";

import ClockIcon from "../../icons/clock.svg?component";
import { createSaveSequencer, type SequencedResult } from "../../lib/async/save-sequencer";
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
// Last value the server acknowledged — the revert target if a save fails.
let confirmedValue = props.user.use_24_hour_time ?? false;
// Suppresses the watch while we programmatically revert the toggle.
let applyingProgrammaticValue = false;
const statusMessage = ref<string | null>(null);
const statusTone = ref<"success" | "error">("success");

// Last-write-wins: a newer toggle aborts and supersedes the in-flight save, so a
// stale/out-of-order response can never flip the switch back to an old value.
const sequencer = createSaveSequencer();

watch(
	use24HourTime,
	() => {
		if (applyingProgrammaticValue) return;
		void saveTimeFormat();
	},
	// Sync flush so `revertTo` (which flips the value with the suppression flag
	// set, then clears it) is observed within the same tick. With the default
	// async flush the flag would already be cleared when the watcher runs, so a
	// failed save's revert would re-trigger a spurious save that overwrites its
	// own error message.
	{ flush: "sync" },
);

async function saveTimeFormat() {
	const intended = use24HourTime.value;
	statusMessage.value = null;

	let outcome: SequencedResult<{ ok: boolean }>;
	try {
		outcome = await sequencer.run(async (signal) => {
			const formData = new FormData();
			formData.set("use_24_hour_time", intended ? "on" : "off");
			const response = await fetch("/api/profile/time-format", {
				method: "POST",
				body: formData,
				signal,
			});
			const data = await response.json();
			return { ok: response.ok && data.ok };
		});
	} catch (error) {
		// Only the latest request's genuine failure reaches here — superseded
		// saves resolve to "stale" instead of throwing.
		rootLogger.error(
			"Failed to update time format from profile",
			{ action: "update_time_format" },
			error,
		);
		revertTo(confirmedValue, "Failed to update time format. Please try again.");
		return;
	}

	// A newer toggle superseded this save — it owns the final state; do nothing.
	if (outcome.status !== "applied") return;

	if (outcome.value.ok) {
		confirmedValue = intended;
		statusMessage.value = "Time format updated.";
		statusTone.value = "success";
	} else {
		revertTo(confirmedValue, "Failed to update time format. Please try again.");
	}
}

/** Programmatically set the toggle without re-triggering a save, and show an error. */
function revertTo(value: boolean, message: string) {
	applyingProgrammaticValue = true;
	use24HourTime.value = value;
	applyingProgrammaticValue = false;
	statusMessage.value = message;
	statusTone.value = "error";
}
</script>
