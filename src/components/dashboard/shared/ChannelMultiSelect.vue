<template>
	<div class="relative">
		<button
			ref="triggerRef"
			type="button"
			:id="triggerId"
			aria-haspopup="listbox"
			:aria-expanded="isOpen ? 'true' : 'false'"
			:aria-controls="listboxId"
			:aria-labelledby="labelledby ? `${labelledby} ${triggerId}` : undefined"
			:disabled="disabled"
			class="inline-flex min-w-44 cursor-pointer items-center justify-between gap-2 rounded-lg border border-edge-strong bg-surface px-3 py-2 text-sm text-heading transition-colors hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
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
			ref="listboxRef"
			v-show="isOpen"
			:id="listboxId"
			role="listbox"
			aria-multiselectable="true"
			:aria-labelledby="labelledby"
			:tabindex="isOpen ? 0 : -1"
			:aria-activedescendant="isOpen && activeOptionId ? activeOptionId : undefined"
			class="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border border-edge bg-surface shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
			@keydown="handleListboxKeydown"
		>
			<li
				v-for="(option, index) in options"
				:key="option.value"
				:id="optionId(index)"
				role="option"
				:aria-selected="option.selected"
				:aria-disabled="option.disabled ? 'true' : undefined"
				:title="option.disabled ? option.disabledTitle : undefined"
				class="flex items-center gap-2.5 px-3 py-2 text-sm"
				:class="[
					option.disabled
						? 'cursor-not-allowed text-faint opacity-50'
						: 'cursor-pointer text-label hover:bg-info-bg',
					index === activeIndex && !option.disabled ? 'bg-info-bg' : '',
				]"
				@click="toggleOption(option)"
				@mousemove="activeIndex = index"
			>
				<span
					aria-hidden="true"
					class="flex size-4 shrink-0 items-center justify-center rounded border"
					:class="
						option.selected
							? option.disabled
								? 'border-faint bg-faint text-white'
								: 'border-primary bg-primary text-white'
							: option.disabled
								? 'border-faint bg-disabled-bg'
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
import { computed, nextTick, onMounted, ref } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import CheckIcon from "../../../icons/check.svg?component";
import ChevronDownIcon from "../../../icons/chevron-down.svg?component";
import type { ChannelOption } from "../types";

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

function optionId(index: number): string {
	return `${props.idPrefix}-channel-option-${index}`;
}

const selectedLabels = computed(() =>
	props.options.filter((option) => option.selected).map((option) => option.label),
);

const summaryText = computed(() =>
	selectedLabels.value.length > 0 ? selectedLabels.value.join(", ") : props.placeholder,
);

const isOpen = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listboxRef = ref<HTMLUListElement | null>(null);

/**
 * Roving "active" option for keyboard navigation. The listbox itself holds DOM focus
 * (focus management pattern), and `aria-activedescendant` points the AT at the active
 * <li> so screen readers announce the currently-highlighted option without moving
 * focus onto each one. `-1` means nothing is active (e.g. before any keyboard input).
 */
const activeIndex = ref(-1);
const activeOptionId = computed(() =>
	activeIndex.value >= 0 && activeIndex.value < props.options.length
		? optionId(activeIndex.value)
		: null,
);

function firstFocusableIndex(): number {
	return props.options.findIndex((option) => !option.disabled);
}

function lastFocusableIndex(): number {
	for (let i = props.options.length - 1; i >= 0; i -= 1) {
		if (!props.options[i].disabled) return i;
	}
	return -1;
}

/** Move the active index by `direction` (±1), skipping disabled options, no wrap. */
function moveActive(direction: 1 | -1) {
	const count = props.options.length;
	if (count === 0) return;
	let next = activeIndex.value;
	// When nothing is active yet, seed from the appropriate end so the first
	// Arrow press lands on a real option.
	if (next < 0) {
		next = direction === 1 ? firstFocusableIndex() : lastFocusableIndex();
		if (next >= 0) activeIndex.value = next;
		return;
	}
	for (let step = next + direction; step >= 0 && step < count; step += direction) {
		if (!props.options[step].disabled) {
			activeIndex.value = step;
			return;
		}
	}
}

async function open() {
	if (props.disabled || isOpen.value) return;
	isOpen.value = true;
	// Land the roving highlight on the first selected option, else the first
	// enabled one, so keyboard users start somewhere meaningful.
	const selected = props.options.findIndex((option) => option.selected && !option.disabled);
	activeIndex.value = selected >= 0 ? selected : firstFocusableIndex();
	await nextTick();
	listboxRef.value?.focus();
}

function close(returnFocus = false) {
	if (!isOpen.value) return;
	isOpen.value = false;
	activeIndex.value = -1;
	if (returnFocus) triggerRef.value?.focus();
}

function toggleOpen() {
	if (props.disabled) return;
	if (isOpen.value) {
		close();
	} else {
		void open();
	}
}

function toggleOption(option: ChannelOption) {
	if (option.disabled) return;
	emit("toggle", option.value, !option.selected);
}

function toggleActiveOption() {
	if (activeIndex.value < 0) return;
	const option = props.options[activeIndex.value];
	if (option) toggleOption(option);
}

function handleTriggerKeydown(event: KeyboardEvent) {
	switch (event.key) {
		case "Escape":
			if (isOpen.value) {
				event.preventDefault();
				close(true);
			}
			break;
		case "ArrowDown":
		case "ArrowUp":
		case "Enter":
		case " ":
			// Open and move focus into the listbox; ArrowUp lands on the last option.
			event.preventDefault();
			if (!isOpen.value) {
				void open().then(() => {
					if (event.key === "ArrowUp") activeIndex.value = lastFocusableIndex();
				});
			}
			break;
		default:
			break;
	}
}

function handleListboxKeydown(event: KeyboardEvent) {
	switch (event.key) {
		case "ArrowDown":
			event.preventDefault();
			moveActive(1);
			break;
		case "ArrowUp":
			event.preventDefault();
			moveActive(-1);
			break;
		case "Home":
			event.preventDefault();
			activeIndex.value = firstFocusableIndex();
			break;
		case "End":
			event.preventDefault();
			activeIndex.value = lastFocusableIndex();
			break;
		case "Enter":
		case " ":
			event.preventDefault();
			toggleActiveOption();
			break;
		case "Escape":
		case "Tab":
			// Escape returns focus to the trigger; Tab lets focus move on naturally
			// (don't preventDefault) but still closes the open listbox.
			if (event.key === "Escape") {
				event.preventDefault();
				close(true);
			} else {
				close();
			}
			break;
		default:
			break;
	}
}

onMounted(() => {
	// Watch the listbox itself, not the container: the container div stretches to
	// the full row width in flex-col layouts, which made clicks in the empty strip
	// beside the trigger count as "inside" and never dismiss. The trigger is
	// ignored because its own click handler already toggles open/closed.
	onClickOutside(listboxRef, () => close(), { ignore: [triggerRef] });
});
</script>
