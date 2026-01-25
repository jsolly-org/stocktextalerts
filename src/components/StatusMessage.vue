<template>
	<div
		class="rounded-lg border p-4 text-sm font-medium"
		:class="toneClasses[tone]"
		role="alert"
	>
		<slot>{{ message }}</slot>
	</div>
</template>

<script lang="ts" setup>
type StatusTone = "success" | "error" | "warning" | "info";

withDefaults(
	defineProps<{
		message?: string;
		tone?: StatusTone;
	}>(),
	{
		tone: "info",
	},
);

const toneClasses: Record<StatusTone, string> = {
	success: "status-tone-success",
	error: "status-tone-error",
	warning: "status-tone-warning",
	info: "status-tone-info",
};
</script>
