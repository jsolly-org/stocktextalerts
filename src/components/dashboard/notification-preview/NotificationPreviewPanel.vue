<template>
	<form
		ref="formatPreferencesFormElement"
		:id="DASHBOARD_FORMAT_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/format-preferences/update"
		class="space-y-6"
		aria-label="Format preferences"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card mb-6">
			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.gray}`"></div>
			<div class="card-body">
				<header class="mb-4">
					<h2
						:id="DASHBOARD_SECTION_IDS.preview"
						class="text-xl sm:text-2xl font-bold text-gray-900"
					>
						Notification Preview
					</h2>
					<p class="text-sm text-gray-600 mt-1">
						Customize how your stock notifications look. Changes apply to both SMS and email.
					</p>
				</header>

				<div v-if="statusMessage" class="mb-4">
					<StatusMessage :tone="statusTone">
						{{ statusMessage }}
					</StatusMessage>
				</div>

				<FormatToggles
					:showChangePercent="showChangePercent"
					:showCompanyName="showCompanyName"
					:detailedFormat="detailedFormat"
					@update:showChangePercent="showChangePercent = $event"
					@update:showCompanyName="showCompanyName = $event"
					@update:detailedFormat="detailedFormat = $event"
				/>

				<div class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
					<SmsPreview
						:stocks="previewStocks"
						:formatPreferences="formatPreferences"
					/>
					<EmailPreview
						:stocks="previewStocks"
						:formatPreferences="formatPreferences"
					/>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs } from "vue";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORMAT_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import type { FormatPreferences } from "../../../lib/messaging/types";
import StatusMessage from "../../StatusMessage.vue";
import {
	type FormatPreferencesData,
	useAutoSaveFormatPreferences,
} from "../composables/useAutoSaveFormatPreferences";
import type { InitialStock } from "../stocks/types";
import EmailPreview from "./EmailPreview.vue";
import FormatToggles from "./FormatToggles.vue";
import { DEMO_STOCKS, type PreviewStock } from "./preview-data";
import SmsPreview from "./SmsPreview.vue";

interface Props {
	user: User;
	initialStocks: InitialStock[];
}

const props = defineProps<Props>();

const { user, initialStocks } = toRefs(props);

const formatPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	statusMessage,
	statusTone,
} = useAutoSaveFormatPreferences<FormatPreferencesData>({
	formRef: formatPreferencesFormElement,
});

const showChangePercent = ref(user.value.show_change_percent);
const showCompanyName = ref(user.value.show_company_name);
const detailedFormat = ref(user.value.detailed_format);

const formatPreferences = computed<FormatPreferences>(() => ({
	show_change_percent: showChangePercent.value,
	show_company_name: showCompanyName.value,
	detailed_format: detailedFormat.value,
}));

const previewStocks = computed<PreviewStock[]>(() => {
	const stocks = initialStocks.value;
	if (stocks.length === 0) {
		return DEMO_STOCKS;
	}
	// Map user's actual tracked stocks to preview stocks with demo prices
	const demoPrices = [
		{ price: 195.5, changePercent: 2.4 },
		{ price: 178.2, changePercent: 1.8 },
		{ price: 248.3, changePercent: -0.5 },
	];
	return stocks.slice(0, 3).map((stock, i) => ({
		symbol: stock.symbol,
		name: stock.name,
		price: demoPrices[i % demoPrices.length].price,
		changePercent: demoPrices[i % demoPrices.length].changePercent,
	}));
});
</script>
