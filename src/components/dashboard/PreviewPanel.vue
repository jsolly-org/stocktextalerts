<template>
	<div
		v-if="showSection"
		class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mt-8"
	>
		<h2
			:id="DASHBOARD_SECTION_IDS.preview"
			class="text-2xl font-bold text-gray-900 mb-2"
		>
			Preview Notifications
		</h2>

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<p class="text-gray-600 mb-6">
			Send a preview notification to verify your settings. These will be sent
			immediately, regardless of your daily digest schedule.
		</p>

		<div class="flex gap-4">
			<div v-if="emailEnabled">
				<form method="POST" action="/api/notifications/preview" @submit="submitEmail">
					<input type="hidden" name="type" value="email" />
					<button
						type="submit"
						class="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="emailSubmitting"
						:aria-busy="emailSubmitting"
					>
						<ArrowPathIcon
							v-if="emailSubmitting"
							class="animate-spin size-4 shrink-0"
							aria-hidden="true"
						/>
						<span>{{ emailSubmitting ? "Sending..." : "Send Preview Email" }}</span>
					</button>
				</form>
			</div>
			<div v-if="smsReady">
				<form method="POST" action="/api/notifications/preview" @submit="submitSms">
					<input type="hidden" name="type" value="sms" />
					<button
						type="submit"
						class="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="smsSubmitting"
						:aria-busy="smsSubmitting"
					>
						<ArrowPathIcon
							v-if="smsSubmitting"
							class="animate-spin size-4 shrink-0"
							aria-hidden="true"
						/>
						<span>{{ smsSubmitting ? "Sending..." : "Send Preview SMS" }}</span>
					</button>
				</form>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../icons/arrow-path.svg?component";
import { buildDashboardRedirect, DASHBOARD_SECTION_IDS } from "../../lib/constants";
import StatusMessage from "../StatusMessage.vue";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
	flashMessages?: { tone: "success" | "error" | "warning"; message: string }[];
}

const props = withDefaults(defineProps<Props>(), {
	flashMessages: () => [],
});
const { emailEnabled, phoneVerified, smsEnabled, smsOptedOut, flashMessages } =
	toRefs(props);

const emailSubmitting = ref(false);
const smsSubmitting = ref(false);

const smsReady = computed(
	() => smsEnabled.value && !smsOptedOut.value && phoneVerified.value,
);
const showSection = computed(() => emailEnabled.value || smsReady.value);
const previewErrorRedirect = buildDashboardRedirect({
	error: "preview_failed",
	section: "preview",
});
const previewEmailSuccessRedirect = buildDashboardRedirect({
	success: "preview_email_sent",
	section: "preview",
});
const previewSmsSuccessRedirect = buildDashboardRedirect({
	success: "preview_sms_sent",
	section: "preview",
});

async function submitPreview(
	event: SubmitEvent,
	successRedirect: string,
	setSubmitting: (value: boolean) => void,
) {
	event.preventDefault();
	setSubmitting(true);

	try {
		const formData = new FormData(event.target as HTMLFormElement);
		const response = await fetch("/api/notifications/preview", {
			method: "POST",
			body: formData,
		});

		if (response.redirected) {
			window.location.href = response.url;
		} else if (!response.ok) {
			window.location.href = previewErrorRedirect;
		} else {
			window.location.href = successRedirect;
		}
	} catch (_error) {
		window.location.href = previewErrorRedirect;
	} finally {
		setSubmitting(false);
	}
}

async function submitEmail(event: SubmitEvent) {
	await submitPreview(
		event,
		previewEmailSuccessRedirect,
		(value) => {
			emailSubmitting.value = value;
		},
	);
}

async function submitSms(event: SubmitEvent) {
	await submitPreview(
		event,
		previewSmsSuccessRedirect,
		(value) => {
			smsSubmitting.value = value;
		},
	);
}
</script>
