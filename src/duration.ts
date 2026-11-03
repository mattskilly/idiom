/** Renders a wall-clock bound for failure wording: "10 minutes", "45 seconds". */
export function formatCritiqueTimeout(ms: number): string {
  const minute = 60 * 1000;
  if (ms >= minute && ms % minute === 0) {
    const minutes = ms / minute;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (ms >= 1000) {
    const seconds = Math.ceil(ms / 1000);
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${ms} ms`;
}
