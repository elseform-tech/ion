const EPSILON = 0.01;

/**
 * Ratchet: every metric is "lower is better". Worse than the baseline fails; better is reported so the
 * baseline can be tightened with `pnpm health:update`.
 * @param {Record<string, number>} baseline
 * @param {Record<string, number>} current
 */
export function compareHealth(baseline, current) {
  const worse = [];
  const better = [];
  for (const [metric, now] of Object.entries(current)) {
    const was = baseline[metric] ?? 0;
    if (now > was + EPSILON) worse.push({ metric, was, now });
    else if (now < was - EPSILON) better.push({ metric, was, now });
  }
  return { ok: worse.length === 0, worse, better };
}
