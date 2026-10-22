// Resolves the Vite/tsconfig "@/..." alias to src/ for `node --test`, so
// lib modules that import siblings via "@/lib/..." can be unit-tested
// with native TypeScript stripping. Extensionless specifiers get ".ts".
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.resolve(import.meta.dirname, "../src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      let target = path.join(SRC, specifier.slice(2));
      if (!path.extname(target)) target += ".ts";
      return nextResolve(pathToFileURL(target).href, context);
    }
    return nextResolve(specifier, context);
  },
});
