<template>
	<section :id="DASHBOARD_SECTION_IDS.notificationChannels" class="space-y-4">
		<header>
			<h2 class="text-xl sm:text-2xl font-bold text-heading">
				Notification Channels
			</h2>
			<p :id="props.notificationChannelsDescId" class="text-sm text-body-secondary mt-1.5">
				Choose how to receive alerts. Content toggles in each section stay the same — this only picks the delivery pipe.
			</p>
		</header>

		<fieldset :aria-describedby="props.notificationChannelsDescId">
			<legend :id="deliveryChannelLegendId" class="sr-only">Notification delivery channel</legend>

			<input type="hidden" name="delivery_channel" :value="selectedChannel" />

			<div
				class="inline-flex w-full flex-col gap-2 sm:flex-row sm:rounded-lg sm:border sm:border-edge sm:bg-surface sm:p-1"
				role="radiogroup"
				:aria-labelledby="deliveryChannelLegendId"
			>
				<label
					v-for="option in channelOptions"
					:key="option.value"
					class="relative flex flex-1 cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors sm:border-0 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface"
					:class="
						selectedChannel === option.value
							? 'border-primary bg-primary text-white sm:bg-primary has-[:focus-visible]:ring-offset-2'
							: option.disabled
								? 'cursor-not-allowed border-edge bg-disabled-bg text-faint opacity-60'
								: 'border-edge bg-surface text-heading hover:bg-surface-alt'
					"
					:title="option.disabledTitle"
				>
					<input
						type="radio"
						class="sr-only"
						name="delivery_channel_radio"
						:value="option.value"
						:checked="selectedChannel === option.value"
						:disabled="option.disabled"
						:aria-describedby="
							option.value === 'telegram' && !telegramConnected
								? telegramUnavailableDescId
								: undefined
						"
						@change="selectChannel(option.value)"
					/>
					{{ option.label }}
				</label>
			</div>
			<p
				v-if="!telegramConnected"
				:id="telegramUnavailableDescId"
				class="sr-only"
			>
				Connect Telegram below to select this channel.
			</p>

			<div v-if="!telegramConnected" class="border-t border-edge pt-4 pb-4 mt-4">
				<ConnectTelegramCard />
			</div>
			<div v-else class="mt-3 flex items-center gap-2 text-sm text-body-secondary">
				<span
					class="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-text"
				>
					<CheckCircleIcon class="size-3.5" aria-hidden="true" />
					Telegram connected
				</span>
			</div>
		</fieldset>

		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pt-2">
			<div class="min-w-0">
				<span
					id="daily_digest_time_label"
					class="text-base font-semibold text-heading"
				>
					Daily notification delivery time
				</span>
				<p
					id="daily_digest_time_description"
					class="text-sm text-body-secondary mt-0.5"
				>
					Always 9:00 AM Eastern — 30 minutes before the US cash open — on session days.
					Shown as <span class="font-medium text-heading">{{ props.beforeOpenLabel }}</span> in your timezone.
					Weekends and full-day holidays are skipped.
					Controls when your <a :href="DASHBOARD_SECTION_HASHES.dailyNotifications" class="link-primary">Daily Notification</a> is sent.
				</p>
			</div>
		</div>

	</section>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import CheckCircleIcon from "../../../icons/check-circle-20.svg?component";
import type { DeliveryChannelMode } from "../../../lib/constants";
import { DASHBOARD_SECTION_HASHES, DASHBOARD_SECTION_IDS } from "../../../lib/constants";
import { useDashboardUser } from "../composables/useDashboardUser";
import ConnectTelegramCard from "./ConnectTelegramCard.vue";

interface Props {
	deliveryChannel: DeliveryChannelMode;
	notificationChannelsDescId: string;
	beforeOpenLabel: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<(event: "update:deliveryChannel", value: DeliveryChannelMode) => void>();

const user = useDashboardUser();
const telegramConnected = computed(() => user.value.telegram_chat_id != null);
const deliveryChannelLegendId = "notification-delivery-channel-legend";
const telegramUnavailableDescId = "notification-telegram-unavailable";

const selectedChannel = computed({
	get: () => props.deliveryChannel,
	set: (value: DeliveryChannelMode) => emit("update:deliveryChannel", value),
});

const channelOptions = computed(() => [
	{ value: "email" as const, label: "Email", disabled: false },
	{
		value: "telegram" as const,
		label: "Telegram",
		disabled: !telegramConnected.value,
		disabledTitle: telegramConnected.value
			? undefined
			: "Connect Telegram below to select this channel",
	},
	{ value: "disabled" as const, label: "Disabled", disabled: false },
]);

function selectChannel(value: DeliveryChannelMode) {
	const option = channelOptions.value.find((o) => o.value === value);
	if (option?.disabled) return;
	selectedChannel.value = value;
}
</script>
