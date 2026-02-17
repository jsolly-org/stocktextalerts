export function createScheduleRequest(cronSecret: string): Request {
	return new Request("http://localhost/api/schedule", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${cronSecret}`,
		},
	});
}
