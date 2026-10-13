// Fresh module instances per case (spec 5.4, REC-02). Imports only node:*.
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export type QueryHook = { set(rootUrl: string, query: string): void };

let installed: QueryHook | null = null;

/**
 * One resolve hook per process. While a query such as `?la=3` is current, a file URL under `rootUrl` resolved from a
 * parent that carries that query gets the same query, so statically imported files inside the target are fresh too.
 */
export function registerQueryHook(): QueryHook {
  if (installed) return installed;
  let root = "";
  let current = "";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (current === "" || root === "") return resolved;
      const parent = context.parentURL ?? "";
      if (!parent.endsWith(current)) return resolved;
      if (!resolved.url.startsWith(root) || resolved.url.includes("?")) return resolved;
      return { ...resolved, url: resolved.url + current };
    },
  });
  installed = {
    set(rootUrl: string, query: string): void {
      root = rootUrl;
      current = query;
    },
  };
  return installed;
}

export function kindOf(modulePath: string, moduleKind: "commonjs" | "module"): "commonjs" | "module" {
  if (/\.m[jt]s$/.test(modulePath)) return "module";
  if (/\.c[jt]s$/.test(modulePath)) return "commonjs";
  return moduleKind;
}

function rootUrlOf(targetRoot: string): string {
  const href = pathToFileURL(targetRoot).href;
  return href.endsWith("/") ? href : href + "/";
}

/**
 * CommonJS: purges every require.cache entry under the target and requires the module again; the result is a live
 * view of module.exports with `default` meaning module.exports itself (a primitive export becomes `{ default }`).
 * ESM: imports the module with `?la=<loadIndex>`.
 */
export async function loadModule(opts: { modulePath: string; kind: "commonjs" | "module"; targetRoot: string; loadIndex: number; hook: QueryHook }): Promise<Record<string, unknown>> {
  if (opts.kind === "commonjs") {
    opts.hook.set("", "");
    const prefix = opts.targetRoot.endsWith("/") ? opts.targetRoot : opts.targetRoot + "/";
    for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key];
    const exported: unknown = createRequire(opts.modulePath)(opts.modulePath);
    if ((typeof exported === "object" && exported !== null) || typeof exported === "function") {
      // A proxy instead of a copy: steps that change module.exports are seen by later steps and by stateAfter.
      return new Proxy(exported as Record<string, unknown>, {
        get(target, key, receiver) {
          if (key === "default" && !Object.hasOwn(target, "default")) return target;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    }
    return { default: exported };
  }
  const query = `?la=${opts.loadIndex}`;
  opts.hook.set(rootUrlOf(opts.targetRoot), query);
  return (await import(pathToFileURL(opts.modulePath).href + query)) as Record<string, unknown>;
}
