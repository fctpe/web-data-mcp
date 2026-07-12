/**
 * Input adjustments applied on quality-gated retries, in order. Attempt 1 is
 * the caller's original input; attempt N merges ESCALATIONS[N-2] on top.
 * Residential proxies first (defeats most IP blocks), then a browser crawler
 * with longer waits (defeats JS walls) where the actor supports it.
 */
const ESCALATIONS: ReadonlyArray<Record<string, unknown>> = [
  { proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } },
  {
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    crawlerType: 'playwright:firefox',
    dynamicContentWaitSecs: 10,
  },
];

export function escalateInput(
  original: Record<string, unknown>,
  attempt: number,
): Record<string, unknown> {
  const escalation = ESCALATIONS[attempt - 2];
  if (attempt <= 1 || !escalation) return original;
  return { ...original, ...escalation };
}

export const MAX_QUALITY_ATTEMPTS = ESCALATIONS.length + 1;
