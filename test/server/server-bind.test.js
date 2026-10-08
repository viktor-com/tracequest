import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "../../src/server/server-http.js";

function listening(server) {
  return new Promise((resolve) => server.once("listening", resolve));
}

test("serve listens on 127.0.0.1 unless a bind address is given", async () => {
  const server = serve(0, null, {});
  await listening(server);
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    server.close();
  }
});

test("serve honours an explicit bind address", async () => {
  const server = serve(0, null, {}, { bind: "::1" });
  await listening(server);
  try {
    assert.equal(server.address().address, "::1");
  } finally {
    server.close();
  }
});
