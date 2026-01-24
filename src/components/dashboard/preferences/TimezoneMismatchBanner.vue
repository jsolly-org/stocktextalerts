<template>
	<div
		v-if="isClient"
		id="timezone-mismatch-banner"
		class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-900 hidden"
		role="alert"
	>
		<div class="space-y-3">
			<div>
				<p class="font-medium">
					We detected your timezone is
					<span id="detected-timezone" class="font-mono"></span>,
					but your account is set to
					<span id="saved-timezone" class="font-mono"></span>.
				</p>
				<p class="text-sm text-yellow-800 mt-1">
					Would you like to update your default timezone?
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<form method="POST" action="/api/preferences/timezone">
					<input type="hidden" name="timezone" id="timezone-update-value" value="" />
					<button
						type="submit"
						class="px-3 py-1.5 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 transition-colors cursor-pointer"
					>
						Update timezone
					</button>
				</form>
				<button
					type="button"
					id="dismiss-timezone-banner"
					class="px-3 py-1.5 bg-white border border-yellow-300 text-yellow-900 rounded-md hover:bg-yellow-100 transition-colors cursor-pointer"
				>
					Not now
				</button>
				<button
					type="button"
					id="dismiss-timezone-banner-permanently"
					class="px-3 py-1.5 bg-white border border-yellow-300 text-yellow-900 rounded-md hover:bg-yellow-100 transition-colors cursor-pointer"
				>
					Don't ask me again
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
interface Props {
	isClient: boolean;
}

defineProps<Props>();
</script>
