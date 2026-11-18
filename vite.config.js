import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds one self-contained dist/index.html (inlined JS/CSS), so it can still be
// published as a Claude artifact or dropped on any static host.
export default defineConfig({
  plugins: [viteSingleFile()],
});
