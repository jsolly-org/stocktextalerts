<template>
	<!--
		A single styled box. `live` controls whether the box is also its own live
		region:

		- live=true (default): the box carries role/aria-live/aria-atomic. For
		  callers that mount the component only when there's a message (`v-if`) with
		  a tone fixed for its lifetime, so the live attributes are correct at
		  insertion and never mutate.
		- live=false: no region attributes. The box sits inside a persistent, static
		  live region the caller owns (TimeFormatSection/TimezoneSection and the
		  flash lists) — that is what makes a later change announce, without a nested
		  region or an aria-live value that re-races the text as it appears.

		The box renders only when there's content, so an empty caller-owned region
		stays genuinely empty (no box, no margin).
	-->
	<div
		v-if="hasContent"
		:class="boxClasses"
		:role="live ? toneLive[tone].role : undefined"
		:aria-live="live ? toneLive[tone].ariaLive : undefined"
		:aria-atomic="live ? 'true' : undefined"
	>
		<component :is="toneIcons[tone]" class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
		<p><slot>{{ message }}</slot></p>
	</div>
</template>

<script lang="ts" setup>
import { type Component, computed, useSlots } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles these to Vue components.
import CheckCircleIcon from "../icons/check-circle-24.svg?component";
import ExclamationCircleIcon from "../icons/exclamation-circle-24.svg?component";
import ExclamationTriangleIcon from "../icons/exclamation-triangle-24.svg?component";
import InformationCircleIcon from "../icons/information-circle-20.svg?component";
import { STATUS_TONE_CLASSES } from "./constants";
import type { StatusTone } from "./types";

const props = withDefaults(
	defineProps<{
		message?: string;
		tone?: StatusTone;
		/**
		 * Render the box as its own live region. Set `false` when the box sits
		 * inside a live region the caller already owns, to avoid a nested region
		 * announcing twice.
		 */
		live?: boolean;
	}>(),
	{
		tone: "info",
		live: true,
	},
);

const slots = useSlots();
const hasContent = computed(
	() => (props.message != null && props.message !== "") || slots.default != null,
);
const boxClasses = computed(() => [
	"rounded-lg border p-4 text-sm font-medium flex items-start gap-3",
	STATUS_TONE_CLASSES[props.tone],
]);

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
