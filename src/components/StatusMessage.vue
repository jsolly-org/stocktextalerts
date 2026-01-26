<template>
	<div
		class="rounded-lg border p-4 text-sm font-medium flex items-start gap-3"
		:class="STATUS_TONE_CLASSES[tone]"
		role="alert"
	>
		<component :is="toneIcons[tone]" class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
		<span><slot>{{ message }}</slot></span>
	</div>
</template>

<script lang="ts" setup>
import type { Component } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles these to Vue components.
import CheckCircleIcon from "../icons/check-circle-24.svg?component";
import ExclamationCircleIcon from "../icons/exclamation-circle-24.svg?component";
import ExclamationTriangleIcon from "../icons/exclamation-triangle-24.svg?component";
import InformationCircleIcon from "../icons/information-circle-20.svg?component";
import type { StatusTone } from "../lib/constants";
import { STATUS_TONE_CLASSES } from "../lib/constants";

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
</script>
