export type Point = { t: string; v: number };

/** Plot geometry shared by the on-screen SVG and the downloadable PNG, so the
 *  two renderers cannot drift apart. */
export function sparklinePoints(
  series: Point[],
  width: number,
  height: number,
  dot: number,
) {
  // The end marker sits on the highest point, so the plot has to sit a full
  // radius (plus stroke) inside the box or the dot clips on the edges
  const pad = dot + 2;
  const right = width - pad;

  const values = series.map((p) => p.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;

  const points = series.map((point, i) => {
    const x = (i / (series.length - 1)) * right;
    const y = height - pad - ((point.v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  return { points, right, pad };
}
