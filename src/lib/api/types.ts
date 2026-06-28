/** JSON body shape for dashboard API routes consumed by the Vue client. */
export type ApiJsonBody = { ok: boolean; message: string } & Record<string, unknown>;
