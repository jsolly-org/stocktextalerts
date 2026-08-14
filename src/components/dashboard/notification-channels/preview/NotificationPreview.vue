<template>
	<EmailNotificationPreview v-if="channel === 'email'" :assets="assets" />
	<TelegramNotificationPreview v-else-if="channel === 'telegram'" :assets="assets" />
</template>

<script lang="ts" setup>
import EmailNotificationPreview from "./EmailNotificationPreview.vue";
import TelegramNotificationPreview from "./TelegramNotificationPreview.vue";
import type { NotificationPreviewChannel, PreviewAsset } from "./types";

interface Props {
	assets: PreviewAsset[];
	channel: NotificationPreviewChannel;
}

defineProps<Props>();
</script>
