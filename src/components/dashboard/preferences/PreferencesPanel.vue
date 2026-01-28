<template>
	<div
		class="relative mb-6 bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden"
		data-notification-preferences-card
		:data-form-id="DASHBOARD_FORM_ID"
	>
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="statusMessage"
				:id="DASHBOARD_STATUS_ID"
				class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10"
				:class="[statusTone === 'error' ? 'bg-error-bg text-error-text' : 'bg-info-bg text-info-text']"
				role="status"
				aria-live="polite"
				:aria-busy="isSaving"
				:data-tone="statusTone"
			>
				<ArrowPathIcon
					v-show="isSaving"
					class="animate-spin size-3 shrink-0"
					aria-hidden="true"
				/>
				{{ statusMessage }}
			</div>
		</Transition>

		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.primary}`"></div>
		<div class="p-6" :id="DASHBOARD_SECTION_IDS.preferences">

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<NotificationChannelsSection
			v-model:email-enabled="emailEnabled"
			v-model:sms-enabled="smsEnabled"
			:user="user"
			:can-save-sms-enabled="canSaveSmsEnabled"
			:is-editing-phone="isEditingPhone"
			:send-verification-disabled="sendVerificationDisabled"
			:success-message="successMessage"
			:is-verifying-code="isVerifyingCode"
			:is-sending-verification="isSendingVerification"
			@phone-validity-changed="handlePhoneValidityChanged"
		/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DASHBOARD_STATUS_ID,
} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import { rootLogger } from "../../../lib/logging";
import StatusMessage from "../../StatusMessage.vue";
import NotificationChannelsSection from "./NotificationChannelsSection.vue";

interface Props {
	user: User;
	isEditingPhone: boolean;
	emailEnabled: boolean;
	smsEnabled: boolean;
	onFormChanged: () => void;
	successMessage?: string | null;
	flashMessages?: { tone: "success" | "error" | "warning"; message: string }[];
	statusMessage?: string | null;
	statusTone?: "error" | "info";
	isSaving?: boolean;
	isVerifyingCode?: boolean;
	isSendingVerification?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	flashMessages: () => [],
	statusMessage: null,
	statusTone: "info",
	isSaving: false,
	isVerifyingCode: false,
	isSendingVerification: false,
});
const {
	emailEnabled: emailEnabledProp,
	smsEnabled: smsEnabledProp,
	isEditingPhone,
	isVerifyingCode,
	isSendingVerification,
	onFormChanged,
	flashMessages,
	statusMessage,
	statusTone,
	isSaving,
	successMessage,
	user,
} = toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "preferences-updated"): void;
}>();

const sendVerificationDisabled = ref(true);
let cleanupNavigationWarning: (() => void) | undefined;

const PENDING_SMS_STORAGE_KEY = "pending_sms_enabled";

const pendingSmsStorageKey = computed(() => {
	return `${PENDING_SMS_STORAGE_KEY}:${user.value.id}`;
});

const emailEnabled = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => smsEnabledProp.value,
	set: (value: boolean) => emit("update:smsEnabled", value),
});
const canSaveSmsEnabled = computed(() => {
	if (!smsEnabled.value) {
		return true;
	}
	return user.value.phone_verified === true;
});

const hasPendingSmsChanges = computed(() => {
	return smsEnabled.value && !user.value.phone_verified;
});

function savePendingSmsState() {
	try {
		if (hasPendingSmsChanges.value) {
			sessionStorage.setItem(pendingSmsStorageKey.value, "true");
		} else {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		}
	} catch (error) {
		rootLogger.warn(
			"Unable to update session storage for pending SMS changes.",
			{
				storageKey: pendingSmsStorageKey.value,
				error,
			},
		);
	}
}

function restorePendingSmsState() {
	let pendingSmsState: string | null = null;
	try {
		pendingSmsState = sessionStorage.getItem(pendingSmsStorageKey.value);
	} catch (error) {
		rootLogger.warn("Unable to read session storage for pending SMS changes.", {
			storageKey: pendingSmsStorageKey.value,
			error,
		});
		return;
	}

	if (user.value.phone_verified && pendingSmsState === "true") {
		smsEnabled.value = true;
		try {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		} catch (error) {
			rootLogger.warn(
				"Unable to clear session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
		}
	} else if (isEditingPhone.value && pendingSmsState === "true") {
		// Restore pending SMS state when entering change phone mode
		smsEnabled.value = true;
	}
}

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

function handlePreferencesUpdated() {
	emit("preferences-updated");
}

watch([emailEnabled, smsEnabled], () => {
	notifyFormChanged();
});

watch(hasPendingSmsChanges, () => {
	savePendingSmsState();
});

watch(
	[() => user.value.phone_verified, isEditingPhone],
	([isVerified, editingPhone]) => {
		if (isVerified || editingPhone) {
			restorePendingSmsState();
		}
	},
	{ immediate: true },
);

function handlePhoneValidityChanged(isValid: boolean) {
	sendVerificationDisabled.value = !isValid;
}

function setupNavigationWarning() {
	if (!hasPendingSmsChanges.value) {
		return;
	}

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		// Allow navigation to change_phone=1 without warning
		const win = window as Window & { __allowChangePhoneNavigation?: boolean };
		if (win.__allowChangePhoneNavigation) {
			delete win.__allowChangePhoneNavigation;
			return;
		}
		event.preventDefault();
		event.returnValue = "";
		return "";
	}

	window.addEventListener("beforeunload", handleBeforeUnload);

	return () => {
		window.removeEventListener("beforeunload", handleBeforeUnload);
	};
}

onMounted(() => {
	if (user.value.phone_verified && smsEnabled.value) {
		try {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		} catch (error) {
			rootLogger.warn(
				"Unable to clear session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
		}
	}

	cleanupNavigationWarning = setupNavigationWarning();
});

watch(hasPendingSmsChanges, (hasPending) => {
	if (cleanupNavigationWarning) {
		cleanupNavigationWarning();
	}
	if (hasPending) {
		cleanupNavigationWarning = setupNavigationWarning();
	} else {
		cleanupNavigationWarning = undefined;
	}
});

onUnmounted(() => {
	if (cleanupNavigationWarning) {
		cleanupNavigationWarning();
	}
});
</script>
