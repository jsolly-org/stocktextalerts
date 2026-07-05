import { type InjectionKey, inject, provide, type Ref, ref, watch } from "vue";
import type { DashboardUser } from "../../../lib/db/types";

const DASHBOARD_USER_KEY: InjectionKey<Ref<DashboardUser>> = Symbol("dashboard-user");

/**
 * Provide a reactive dashboard user ref for descendant components.
 *
 * The provided ref is a shallow copy of the incoming prop and stays in sync with prop changes.
 * The user carries per-option email prefs reconstructed from notification_preferences
 * (see dashboard.astro), so panels keep reading `user.<field>` for those controls.
 */
export function provideDashboardUser(userProp: Ref<DashboardUser>): Ref<DashboardUser> {
	const user = ref<DashboardUser>({ ...userProp.value });

	// Sync with prop changes (e.g., after page reload)
	watch(
		userProp,
		(newUser) => {
			user.value = { ...newUser };
		},
		{ deep: true },
	);

	provide(DASHBOARD_USER_KEY, user);
	return user;
}

/**
 * Consume the provided dashboard user ref.
 *
 * Throws when called outside a component tree that has run `provideDashboardUser()`.
 */
export function useDashboardUser(): Ref<DashboardUser> {
	const user = inject(DASHBOARD_USER_KEY);
	if (!user) {
		throw new Error("useDashboardUser() requires provideDashboardUser() in an ancestor component");
	}
	return user;
}
