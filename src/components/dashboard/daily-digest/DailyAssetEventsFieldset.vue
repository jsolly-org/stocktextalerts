<template>
	<div class="!border-t-0 py-4">
		<h3 class="text-lg sm:text-xl font-bold text-heading mb-1">Asset events</h3>
		<p class="text-sm text-body-secondary mb-4">
			Calendar, IPO, analyst, insider, SEC filing, and short interest updates bundled into
			the same daily message.
		</p>

		<div class="space-y-4">
			<div class="flex flex-row items-center justify-between gap-3 px-4">
				<span class="text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
				<label class="inline-flex items-center gap-1.5">
					<input
						ref="selectAllRef"
						type="checkbox"
						:checked="allChecked"
						class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
						aria-label="Select all asset events"
						@change="toggleAll"
					/>
					<span class="text-sm font-medium text-body-secondary">All</span>
				</label>
			</div>

			<div
				v-for="eventType in ASSET_EVENT_TYPES"
				:key="eventType.key"
			>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
					<input
						type="hidden"
						:name="`asset_events_include_${eventType.key}`"
						:value="models[eventType.key] ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								:id="`asset_events_${eventType.key}_label`"
								class="text-base font-semibold text-heading"
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
							class="text-sm text-body-secondary mt-0.5"
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
					<div class="shrink-0">
						<ToggleSwitch
							:model-value="models[eventType.key]"
							:sr-label="`Toggle ${eventType.label}`"
							:aria-labelledby="`asset_events_${eventType.key}_label`"
							:aria-describedby="`asset_events_${eventType.key}_description`"
							:disabled="isEventTypeBlockedByAssets(eventType.key)"
							@update:model-value="setModel(eventType.key, $event)"
						/>
					</div>
				</div>
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
import { ASSET_EVENT_TYPES, type AssetEventKey } from "./asset-event-types";

interface Props {
	hasTrackedAssets: boolean;
	models: Record<AssetEventKey, boolean>;
}

const props = defineProps<Props>();
const emit = defineEmits<(event: "update:models", value: Record<AssetEventKey, boolean>) => void>();
const { hasTrackedAssets, models } = toRefs(props);

function isEventTypeBlockedByAssets(key: AssetEventKey): boolean {
	return !hasTrackedAssets.value && key !== "ipo";
}

const selectableEventTypes = computed(() =>
	ASSET_EVENT_TYPES.filter((t) => !isEventTypeBlockedByAssets(t.key)),
);

const allChecked = computed(
	() =>
		selectableEventTypes.value.length > 0 &&
		selectableEventTypes.value.every((t) => models.value[t.key]),
);
const someChecked = computed(() =>
	selectableEventTypes.value.some((t) => models.value[t.key]),
);

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
	for (const eventType of selectableEventTypes.value) {
		updated[eventType.key] = next;
	}
	emit("update:models", updated);
}
</script>
