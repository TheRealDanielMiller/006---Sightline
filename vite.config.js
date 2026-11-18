import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two builds:
//  * npm run build           -> dist/           GitHub Pages site with the real map (MapLibre + OpenFreeMap).
//  * npm run build:artifact  -> dist-artifact/  one self-contained index.html for the Claude artifact.
//    Artifacts can't load outside map tiles, so this build drops the map code (MODE === "artifact")
//    and shows the crossing diagram only.
export default defineConfig(({ mode }) =>
  mode === "artifact"
    ? { base: "./", plugins: [viteSingleFile()], build: { outDir: "dist-artifact" } }
    : { base: "./", build: { outDir: "dist", chunkSizeWarningLimit: 1500 } },
);
