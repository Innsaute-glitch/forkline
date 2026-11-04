/** True when `served` is the requested id, or that id plus `-YYYYMMDD`. Nothing else matches. */
export function servedModelMatches(requested: string, served: string): boolean {
  return served === requested || (served.startsWith(`${requested}-`) && /^\d{8}$/.test(served.slice(requested.length + 1)));
}
