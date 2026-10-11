/** Export the fork's SVG artwork to install, notification and sharing assets. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const mark = readFileSync(join(root, "public/icons/saurons-eye.svg"), "utf8");
const badge = readFileSync(join(root, "public/icons/saurons-eye-badge.svg"), "utf8");
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  async function png(svg: string, size: number): Promise<Buffer> {
    const encoded = await page.evaluate(async ({ svg, size }) => {
      const image = new Image(); image.src = "data:image/svg+xml," + encodeURIComponent(svg); await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
      canvas.getContext("2d")!.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }, { svg, size });
    return Buffer.from(encoded, "base64");
  }
  function save(path: string, bytes: Buffer): void { writeFileSync(join(root, path), bytes); console.log(path); }
  mkdirSync(join(root, "public/icons"), { recursive: true });
  for (const size of [192, 512]) {
    save(`public/icons/icon-${size}.png`, await png(mark, size));
    // Full opaque background; every meaningful mark fits the central maskable safe zone.
    save(`public/icons/icon-maskable-${size}.png`, await png(mark.replace('rx="104"', 'rx="0"'), size));
  }
  save("public/icons/badge-96.png", await png(badge, 96));
  save("public/apple-touch-icon.png", await png(mark, 180));
  save("public/favicon.png", await png(mark, 64));
  const small = await png(mark, 32); const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header[6] = 32; header[7] = 32;
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(small.length, 14); header.writeUInt32LE(22, 18);
  save("public/favicon.ico", Buffer.concat([header, small]));
  const preview = await page.evaluate(async (svg) => {
    const image = new Image(); image.src = "data:image/svg+xml," + encodeURIComponent(svg); await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 640;
    const context = canvas.getContext("2d")!; context.fillStyle = "#181613"; context.fillRect(0, 0, 1280, 640);
    context.drawImage(image, 32, 64, 512, 512); context.fillStyle = "#ffcf73"; context.font = "bold 72px sans-serif"; context.fillText("Saurons eye", 600, 265);
    context.fillStyle = "#ddd6ca"; context.font = "28px sans-serif"; context.fillText("Your agents. Any screen.", 602, 320);
    context.font = "20px sans-serif"; context.fillText("CHAT  /  TERMINAL  /  PROJECT GUIDANCE", 603, 372);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, mark);
  save("public/social-preview.png", Buffer.from(preview, "base64"));
} finally { await browser.close(); }
