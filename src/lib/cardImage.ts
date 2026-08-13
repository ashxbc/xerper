import { sparklinePoints, type Point } from "./sparkline";

const BLUE = "#1E2AEB";
const SCALE = 2; // draw at 2x so the PNG stays crisp on retina and when zoomed

const CARD_W = 440;
const PAD = 24;
const MARGIN = 28; // blue border around the card, so it reads as a finished image
const PLOT_H = 84;

export type CardData = {
  name: string;
  handle: string;
  avatar: string;
  projectAvatar: string | null;
  project: string;
  impressions: number;
  postCount: number;
  series: Point[];
  fontFamily: string;
};

/** Route remote avatars through Next's image endpoint: it is same-origin, so
 *  drawing them does not taint the canvas and block toBlob(). */
function sameOrigin(url: string, size: number) {
  return `/_next/image?url=${encodeURIComponent(url)}&w=${size}&q=75`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // a missing avatar must not kill the export
    img.src = src;
  });
}

function circleImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  // Cover-fit: crop the long edge rather than squashing the image
  const ratio = Math.max(size / img.width, size / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
  ctx.restore();
}

function formatMonth(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

export async function renderCardPng(data: CardData): Promise<Blob | null> {
  const hasPlot = data.series.length > 1;
  const cardH = PAD * 2 + 40 + 20 + 66 + (hasPlot ? PLOT_H + 26 : 0);
  const width = CARD_W + MARGIN * 2;
  const height = cardH + MARGIN * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);

  const [avatar, projectIcon] = await Promise.all([
    data.avatar ? loadImage(sameOrigin(data.avatar, 128)) : null,
    data.projectAvatar ? loadImage(sameOrigin(data.projectAvatar, 128)) : null,
  ]);

  // backdrop
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, 0, width, height);

  // card
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(MARGIN, MARGIN, CARD_W, cardH, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.clip();

  const left = MARGIN + PAD;
  let y = MARGIN + PAD;

  // identity
  if (avatar) {
    circleImage(ctx, avatar, left, y, 40);
  } else {
    ctx.beginPath();
    ctx.arc(left + 20, y + 20, 20, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.1)";
    ctx.fill();
  }

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111111";
  ctx.font = `600 14px ${data.fontFamily}`;
  ctx.fillText(data.name, left + 52, y + 17);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.font = `400 12px ${data.fontFamily}`;
  ctx.fillText(`@${data.handle}`, left + 52, y + 34);

  // project mark
  const iconRight = MARGIN + CARD_W - PAD;
  if (projectIcon) {
    circleImage(ctx, projectIcon, iconRight - 32, y + 4, 32);
    ctx.beginPath();
    ctx.arc(iconRight - 16, y + 20, 16, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.font = `600 11px ${data.fontFamily}`;
    const label = data.project;
    const w = ctx.measureText(label).width + 20;
    ctx.beginPath();
    ctx.roundRect(iconRight - w, y + 8, w, 24, 12);
    ctx.fillStyle = "rgba(30,42,235,0.08)";
    ctx.fill();
    ctx.fillStyle = BLUE;
    ctx.fillText(label, iconRight - w + 10, y + 24);
  }

  // headline
  y += 40 + 20;
  ctx.fillStyle = "#111111";
  ctx.font = `600 44px ${data.fontFamily}`;
  ctx.fillText(data.impressions.toLocaleString(), left, y + 38);

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.font = `400 12px ${data.fontFamily}`;
  ctx.fillText(`Impressions generated for ${data.project}`, left, y + 60);

  // plot, flush to the card edges
  if (hasPlot) {
    const plotTop = MARGIN + cardH - 26 - PLOT_H;
    const { points, right } = sparklinePoints(
      data.series,
      CARD_W,
      PLOT_H,
      3.5,
    );

    ctx.save();
    ctx.translate(MARGIN, plotTop);

    ctx.beginPath();
    points.forEach(([px, py], i) =>
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py),
    );
    const line = new Path2D();
    points.forEach(([px, py], i) =>
      i === 0 ? line.moveTo(px, py) : line.lineTo(px, py),
    );

    ctx.lineTo(right, PLOT_H);
    ctx.lineTo(0, PLOT_H);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, PLOT_H);
    gradient.addColorStop(0, "rgba(30,42,235,0.18)");
    gradient.addColorStop(1, "rgba(30,42,235,0)");
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(line);

    const [lastX, lastY] = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.font = `400 11px ${data.fontFamily}`;
    ctx.fillText(
      `${formatMonth(data.series[0].t)} - ${formatMonth(data.series[data.series.length - 1].t)}`,
      left,
      MARGIN + cardH - 10,
    );
  }

  ctx.restore();

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
