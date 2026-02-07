import { type InjectionKey, inject, provide, type Ref, ref, watch } from "vue";
import type { User } from "../../../lib/db";

const DASHBOARD_USER_KEY: InjectionKey<Ref<User>> = Symbol("dashboard-user");

/**
 * Provide a shared mutable User ref to all dashboard descendants.
 * Call once in the top-level DashboardPanels component.
 */
export function provideDashboardUser(userProp: Ref<User>): Ref<User> {
	const user = ref<User>({ ...userProp.value });

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
 * Inject the shared dashboard User ref.
 * Must be called within a component that is a descendant of the provider.
 */
export function useDashboardUser(): Ref<User> {
	const user = inject(DASHBOARD_USER_KEY);
	if (!user) {
		throw new Error(
			"useDashboardUser() requires provideDashboardUser() in an ancestor component",
		);
	}
	return user;
}
