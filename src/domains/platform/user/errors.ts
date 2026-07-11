// No domain errors yet: the profile endpoints are upsert-based and GET returns
// (unpersisted) defaults with `onboarded: false` rather than 404ing. Add
// `{Domain}Reason` entries here when a real error path appears.
export const UserReason = {} as const;
