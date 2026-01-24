<template>
	<div
		:class="`bg-white rounded-lg shadow-sm border border-gray-200 p-6 mt-8 ${showSection ? '' : 'hidden'}`"
	>
		<h2 class="text-2xl font-bold text-gray-900 mb-4">Preview Notifications</h2>
		<p class="text-gray-600 mb-6">
			Send a preview notification to verify your settings. These will be sent
			immediately, regardless of your daily digest schedule.
		</p>

		<div class="flex gap-4">
			<div :class="emailEnabled ? '' : 'hidden'">
				<form method="POST" action="/api/notifications/preview" @submit="submitEmail">
					<input type="hidden" name="type" value="email" />
					<button
						type="submit"
						class="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="emailSubmitting"
					>
						Send Preview Email
					</button>
				</form>
			</div>
			<div :class="smsReady ? '' : 'hidden'">
				<form method="POST" action="/api/notifications/preview" @submit="submitSms">
					<input type="hidden" name="type" value="sms" />
					<button
						type="submit"
						class="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="smsSubmitting"
					>
						Send Preview SMS
					</button>
				</form>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs } from "vue";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const { emailEnabled, phoneVerified, smsEnabled, smsOptedOut } = toRefs(props);

const emailSubmitting = ref(false);
const smsSubmitting = ref(false);

const smsReady = computed(
	() => smsEnabled.value && !smsOptedOut.value && phoneVerified.value,
);
const showSection = computed(() => emailEnabled.value || smsReady.value);

async function submitEmail(event: SubmitEvent) {
	event.preventDefault();
	emailSubmitting.value = true;

	try {
		const formData = new FormData(event.target as HTMLFormElement);
		const response = await fetch("/api/notifications/preview", {
			method: "POST",
			body: formData,
		});

		if (response.redirected) {
			window.location.href = response.url;
		} else if (!response.ok) {
			window.location.href = "/dashboard?error=preview_failed";
		} else {
			window.location.href = "/dashboard?success=preview_email_sent";
		}
	} catch (error) {
		window.location.href = "/dashboard?error=preview_failed";
	} finally {
		emailSubmitting.value = false;
	}
}

async function submitSms(event: SubmitEvent) {
	event.preventDefault();
	smsSubmitting.value = true;

	try {
		const formData = new FormData(event.target as HTMLFormElement);
		const response = await fetch("/api/notifications/preview", {
			method: "POST",
			body: formData,
		});

		if (response.redirected) {
			window.location.href = response.url;
		} else if (!response.ok) {
			window.location.href = "/dashboard?error=preview_failed";
		} else {
			window.location.href = "/dashboard?success=preview_sms_sent";
		}
	} catch (error) {
		window.location.href = "/dashboard?error=preview_failed";
	} finally {
		smsSubmitting.value = false;
	}
}
</script>
