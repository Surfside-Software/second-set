/**
 * Render the application icon rasters from their SVG sources with resvg:
 * `desktop/icons/icon.png`, `icon.icns` and `icon.ico`. Usage: `bun scripts/build-icons.ts`.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = join(import.meta.dir, "..", "desktop", "icons");

const render = (svg: string, size: number) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

/** An ICO file of PNG entries, which Windows reads from Vista on. */
const ico = (images: ReadonlyArray<{ size: number; png: Uint8Array }>) => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;

  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => Buffer.from(png))]);
};

const icon = await readFile(join(directory, "icon.svg"), "utf8");
const fullBleed = await readFile(join(directory, "icon-full-bleed.svg"), "utf8");

await writeFile(join(directory, "icon.png"), render(icon, 1024));

const icns = await mkdtemp(join(tmpdir(), "second-set-icns-"));

try {
  for (const size of [16, 32, 64, 128, 256, 512, 1024])
    await writeFile(join(icns, `${size}.png`), render(icon, size));

  const packer = Bun.spawn(
    [process.execPath, join(import.meta.dir, "build-icns.ts"), icns, join(directory, "icon.icns")],
    { stdout: "inherit", stderr: "inherit" },
  );

  if ((await packer.exited) !== 0) throw new Error("The ICNS file could not be written.");
} finally {
  await rm(icns, { recursive: true, force: true });
}

await writeFile(
  join(directory, "icon.ico"),
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: render(fullBleed, size) }))),
);
