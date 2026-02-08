import { type InjectionKey, inject, provide, type Ref, ref, watch } from "vue";
import type { User } from "../../../lib/db";

const DASHBOARD_USER_KEY: InjectionKey<Ref<User>> = Symbol("dashboard-user");

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

export function useDashboardUser(): Ref<User> {
	const user = inject(DASHBOARD_USER_KEY);
	if (!user) {
		throw new Error(
			"useDashboardUser() requires provideDashboardUser() in an ancestor component",
		);
	}
	return user;
}
