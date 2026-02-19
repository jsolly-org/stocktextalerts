<template>
	<div
		class="rounded-lg border p-4 text-sm font-medium flex items-start gap-3"
		:class="STATUS_TONE_CLASSES[tone]"
		:role="toneLive[tone].role"
		:aria-live="toneLive[tone].ariaLive"
		aria-atomic="true"
	>
		<component :is="toneIcons[tone]" class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
		<p><slot>{{ message }}</slot></p>
	</div>
</template>

<script lang="ts" setup>
import type { Component } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles these to Vue components.
import CheckCircleIcon from "../icons/check-circle-24.svg?component";
import ExclamationCircleIcon from "../icons/exclamation-circle-24.svg?component";
import ExclamationTriangleIcon from "../icons/exclamation-triangle-24.svg?component";
import InformationCircleIcon from "../icons/information-circle-20.svg?component";
import { STATUS_TONE_CLASSES, type StatusTone } from "../lib/constants";

withDefaults(
	defineProps<{
		message?: string;
		tone?: StatusTone;
	}>(),
	{
		tone: "info",
	},
);

const toneIcons: Record<StatusTone, Component> = {
	success: CheckCircleIcon,
	error: ExclamationCircleIcon,
	warning: ExclamationTriangleIcon,
	info: InformationCircleIcon,
};
const toneLive = {
	success: { role: "status", ariaLive: "polite" },
	error: { role: "alert", ariaLive: "assertive" },
	warning: { role: "alert", ariaLive: "assertive" },
	info: { role: "status", ariaLive: "polite" },
} satisfies Record<
	StatusTone,
	{ role: "alert" | "status"; ariaLive: "assertive" | "polite" }
>;
</script>
