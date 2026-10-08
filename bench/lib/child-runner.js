/** Imports a bench module in a fresh process and runs one named export. */
const [, , modulePath, exportName] = process.argv;

process.on("message", async ({ payload }) => {
  try {
    const mod = await import(modulePath);
    const fn = mod[exportName];
    if (typeof fn !== "function") throw new Error(`no export ${exportName} in ${modulePath}`);
    const value = await fn(payload);
    process.send({ ok: true, value });
  } catch (err) {
    process.send({ ok: false, error: err?.stack ?? String(err) });
  }
});
