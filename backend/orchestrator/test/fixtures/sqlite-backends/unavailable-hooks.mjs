// Module hooks for a runtime without node:sqlite (the Gateway bundle targets
// node20, where it does not exist): importing it fails as there.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:sqlite") {
    const error = new Error(`No such built-in module: ${specifier}`);
    error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
    throw error;
  }
  return nextResolve(specifier, context);
}
