<template>
	<div
		v-if="isOpen"
		class="fixed inset-0 z-50 flex items-center justify-center p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="daily-digest-send-now-title"
	>
		<div class="absolute inset-0 bg-gray-900/50" @click="$emit('close')" />
		<div
			class="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-gray-200 p-5"
			@click.stop
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3
						id="daily-digest-send-now-title"
						class="text-base font-semibold text-gray-900"
					>
						Send daily digest early?
					</h3>
					<p class="mt-1 text-sm text-gray-600">
						This sends a daily digest immediately (earlier than your scheduled
						time). Your next digest is scheduled soon&mdash;do you want to skip it?
					</p>
				</div>
				<button
					type="button"
					class="shrink-0 rounded-md p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 cursor-pointer disabled:cursor-not-allowed"
					@click="$emit('close')"
					:disabled="isSending"
					aria-label="Close"
				>
					<span aria-hidden="true">×</span>
				</button>
			</div>

			<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
				<button
					type="button"
					class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					@click="$emit('send-without-skipping')"
					:disabled="isSending"
				>
					Send and don't skip next notification
				</button>
				<button
					type="button"
					class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-strong focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					@click="$emit('send-and-skip-next')"
					:disabled="isSending"
				>
					Send and skip next notification
				</button>
			</div>

			<div class="mt-3 text-right">
				<button
					type="button"
					class="text-sm font-medium text-gray-600 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded-md px-2 py-1 cursor-pointer disabled:cursor-not-allowed"
					@click="$emit('close')"
					:disabled="isSending"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
interface Props {
	isOpen: boolean;
	isSending: boolean;
}

defineProps<Props>();

defineEmits<{
	close: [];
	"send-and-skip-next": [];
	"send-without-skipping": [];
}>();
</script>
