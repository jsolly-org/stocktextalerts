const createdUserIds: string[] = [];

export function registerTestUserForCleanup(userId: string): void {
	createdUserIds.push(userId);
}

export function takeTestUserIdsForCleanup(): string[] {
	return createdUserIds.splice(0, createdUserIds.length);
}
