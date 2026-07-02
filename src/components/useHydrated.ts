import { onMounted, type Ref, ref } from "vue";

/**
 * Tracks whether the component has mounted on the client.
 *
 * Starts `false` (matching SSR) and flips to `true` after `onMounted`, so
 * client-only rendering can be gated behind it to avoid hydration mismatches.
 * Use with `v-if`, computeds, or watchers that must only run post-hydration.
 */
export function useHydrated(): Ref<boolean> {
	const isHydrated = ref(false);
	onMounted(() => {
		isHydrated.value = true;
	});
	return isHydrated;
}
