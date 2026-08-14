<template>
	<div class="grid grid-cols-subgrid !border-t-0">
		<div class="col-span-2 pt-4 pb-1">
			<h3 class="subsection-title">Asset events</h3>
			<p class="subsection-desc">
				Calendar, IPO, analyst, insider, SEC filing, and short interest updates bundled into
				the same daily message.
			</p>
		</div>

		<div class="col-span-2 grid grid-cols-subgrid items-center gap-x-3 border-t border-divider py-3">
			<span class="select-all-text inline-flex h-4 items-center text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
			<label class="inline-flex items-center justify-self-end gap-1.5 leading-none">
				<input
					ref="selectAllRef"
					type="checkbox"
					:checked="allChecked"
					class="select-all-checkbox"
					aria-label="Select all asset events"
					@change="toggleAll"
				/>
				<span class="select-all-text text-xs font-semibold text-body-secondary leading-none">All</span>
			</label>
		</div>

		<div
			v-for="eventType in ASSET_EVENT_TYPES"
			:key="eventType.key"
			class="col-span-2 grid grid-cols-subgrid items-center gap-x-3 border-t border-divider py-3"
		>
			<div class="min-w-0">
				<input
					type="hidden"
					:name="`asset_events_include_${eventType.key}`"
					:value="models[eventType.key] ? 'on' : 'off'"
				/>
				<div class="flex items-center gap-2">
					<span
						:id="`asset_events_${eventType.key}_label`"
						class="option-title"
					>
						{{ eventType.label }}
					</span>
					<MassiveLogoIcon
						v-if="eventType.massive"
						class="h-4.5 w-auto shrink-0"
						aria-label="Powered by Massive"
						role="img"
					/>
					<FinnhubLogoIcon
						v-if="eventType.finnhub"
						class="h-4.5 w-auto shrink-0"
						aria-label="Powered by Finnhub"
						role="img"
					/>
					<NewspaperIcon
						v-if="eventType.plainIcon === 'newspaper'"
						class="h-4.5 w-4.5 shrink-0 text-body-secondary"
						aria-hidden="true"
					/>
					<ChartBarIcon
						v-if="eventType.plainIcon === 'chart-bar'"
						class="h-4.5 w-4.5 shrink-0 text-body-secondary"
						aria-hidden="true"
					/>
				</div>
				<p
					:id="`asset_events_${eventType.key}_description`"
					class="option-desc"
				>
					<template v-if="eventType.key === 'insider' || eventType.key === 'analyst'">
						{{ eventType.description }}
						<span class="text-faint"> Stocks only.</span>
					</template>
					<template v-else>
						{{ eventType.description }}
					</template>
				</p>
			</div>
			<div class="shrink-0 justify-self-end">
				<ToggleSwitch
					:model-value="models[eventType.key]"
					:sr-label="`Toggle ${eventType.label}`"
					:aria-labelledby="`asset_events_${eventType.key}_label`"
					:aria-describedby="`asset_events_${eventType.key}_description`"
					:disabled="isAssetEventBlocked(eventType.key, hasTrackedAssets) && !models[eventType.key]"
					@update:model-value="setModel(eventType.key, $event)"
				/>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watchEffect } from "vue";
import ChartBarIcon from "../../../icons/chart-bar.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import NewspaperIcon from "../../../icons/newspaper.svg?component";
import ToggleSwitch from "../../ToggleSwitch.vue";
import {
	ASSET_EVENT_TYPES,
	type AssetEventKey,
	isAssetEventBlocked,
	selectableAssetEventKeys,
} from "./asset-event-types";

interface Props {
	hasTrackedAssets: boolean;
	models: Record<AssetEventKey, boolean>;
}

const props = defineProps<Props>();
const emit = defineEmits<(event: "update:models", value: Record<AssetEventKey, boolean>) => void>();
const { hasTrackedAssets, models } = toRefs(props);

const selectableKeys = computed(() => selectableAssetEventKeys(hasTrackedAssets.value));

const allChecked = computed(
	() =>
		selectableKeys.value.length > 0 &&
		selectableKeys.value.every((key) => models.value[key]),
);
const someChecked = computed(() => selectableKeys.value.some((key) => models.value[key]));

const selectAllRef = ref<HTMLInputElement | null>(null);

watchEffect(() => {
	if (selectAllRef.value) {
		selectAllRef.value.indeterminate = someChecked.value && !allChecked.value;
	}
});

function setModel(key: AssetEventKey, value: boolean) {
	emit("update:models", { ...models.value, [key]: value });
}

function toggleAll() {
	const next = !allChecked.value;
	const updated = { ...models.value };
	if (next) {
		for (const key of selectableKeys.value) {
			updated[key] = true;
		}
	} else {
		for (const eventType of ASSET_EVENT_TYPES) {
			updated[eventType.key] = false;
		}
	}
	emit("update:models", updated);
}
</script>
