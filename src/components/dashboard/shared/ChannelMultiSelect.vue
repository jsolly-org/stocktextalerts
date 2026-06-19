<template>
	<div class="relative" ref="containerRef">
		<button
			type="button"
			:id="triggerId"
			aria-haspopup="listbox"
			:aria-expanded="isOpen ? 'true' : 'false'"
			:aria-controls="listboxId"
			:aria-labelledby="labelledby ? `${labelledby} ${triggerId}` : undefined"
			:disabled="disabled"
			class="inline-flex min-w-44 items-center justify-between gap-2 rounded-lg border border-edge-strong bg-surface px-3 py-2 text-sm text-heading transition-colors hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
			@click="toggleOpen"
			@keydown="handleTriggerKeydown"
		>
			<span class="truncate text-left" :class="selectedLabels.length ? 'text-heading' : 'text-muted'">
				{{ summaryText }}
			</span>
			<ChevronDownIcon
				class="size-4 shrink-0 text-body-secondary transition-transform duration-150"
				:class="{ 'rotate-180': isOpen }"
				aria-hidden="true"
			/>
		</button>

		<ul
			v-show="isOpen"
			:id="listboxId"
			role="listbox"
			aria-multiselectable="true"
			:aria-labelledby="labelledby"
			class="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border border-edge bg-surface shadow-lg"
		>
			<li
				v-for="option in options"
				:key="option.value"
				role="option"
				:aria-selected="option.selected"
				:aria-disabled="option.disabled ? 'true' : undefined"
				:title="option.disabled ? option.disabledTitle : undefined"
				class="flex items-center gap-2.5 px-3 py-2 text-sm"
				:class="
					option.disabled
						? 'cursor-not-allowed text-muted'
						: 'cursor-pointer text-label hover:bg-info-bg'
				"
				@click="toggleOption(option)"
			>
				<span
					aria-hidden="true"
					class="flex size-4 shrink-0 items-center justify-center rounded border"
					:class="
						option.selected
							? 'border-primary bg-primary text-white'
							: 'border-edge-strong bg-surface'
					"
				>
					<CheckIcon v-if="option.selected" class="size-3" />
				</span>
				<span class="truncate">{{ option.label }}</span>
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { onClickOutside } from "@vueuse/core";
import { computed, onMounted, ref } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import CheckIcon from "../../../icons/check.svg?component";
import ChevronDownIcon from "../../../icons/chevron-down.svg?component";

/**
 * A single selectable channel inside the multiselect. `disabled` keeps the option
 * visible (so the user understands the channel exists) but blocks toggling, with
 * `disabledTitle` explaining why — mirroring the legacy per-channel checkbox hints.
 */
export interface ChannelOption {
	value: string;
	label: string;
	selected: boolean;
	disabled?: boolean;
	disabledTitle?: string;
}

interface Props {
	options: ChannelOption[];
	/** id of the option's text label, for the trigger's accessible name. */
	labelledby?: string;
	/** Unique slug used to derive stable trigger/listbox element ids. */
	idPrefix: string;
	disabled?: boolean;
	/** Shown when no channel is selected. */
	placeholder?: string;
}

const props = withDefaults(defineProps<Props>(), {
	labelledby: undefined,
	disabled: false,
	placeholder: "Off",
});

const emit = defineEmits<(event: "toggle", value: string, selected: boolean) => void>();

const triggerId = computed(() => `${props.idPrefix}-channel-trigger`);
const listboxId = computed(() => `${props.idPrefix}-channel-listbox`);

const selectedLabels = computed(() =>
	props.options.filter((option) => option.selected).map((option) => option.label),
);

const summaryText = computed(() =>
	selectedLabels.value.length > 0 ? selectedLabels.value.join(", ") : props.placeholder,
);

const isOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);

function toggleOpen() {
	if (props.disabled) return;
	isOpen.value = !isOpen.value;
}

function toggleOption(option: ChannelOption) {
	if (option.disabled) return;
	emit("toggle", option.value, !option.selected);
}

function handleTriggerKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && isOpen.value) {
		event.preventDefault();
		isOpen.value = false;
	}
}

onMounted(() => {
	onClickOutside(containerRef, () => {
		isOpen.value = false;
	});
});
</script>
