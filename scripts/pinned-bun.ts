const pinFile = new URL("../.bun-version", import.meta.url);
const pinned = (await Bun.file(pinFile).text()).trim();

if (Bun.version !== pinned) {
  console.error(`Bun ${Bun.version} does not match .bun-version (${pinned}). Use Bun ${pinned}.`);
  process.exit(1);
}
