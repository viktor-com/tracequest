import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isIndexDiskExpectedErr,
  isProcRaceErr,
  isScanSkippableErr,
} from "../../src/utils/fs-expected-err.js";

describe("isIndexDiskExpectedErr", () => {
  test("returns true for ENOENT", () => {
    assert.equal(isIndexDiskExpectedErr({ code: "ENOENT" }), true);
  });

  test("returns false for other errno codes", () => {
    assert.equal(isIndexDiskExpectedErr({ code: "EACCES" }), false);
    assert.equal(isIndexDiskExpectedErr({ code: "EIO" }), false);
    assert.equal(isIndexDiskExpectedErr({ code: "ESRCH" }), false);
  });

  test("returns false for null, undefined, and missing err", () => {
    assert.equal(isIndexDiskExpectedErr(null), false);
    assert.equal(isIndexDiskExpectedErr(undefined), false);
  });

  test("returns false when err has no code or empty code", () => {
    assert.equal(isIndexDiskExpectedErr({}), false);
    assert.equal(isIndexDiskExpectedErr({ code: "" }), false);
    assert.equal(isIndexDiskExpectedErr({ code: null }), false);
    assert.equal(isIndexDiskExpectedErr({ message: "ENOENT" }), false);
  });
});

describe("isProcRaceErr", () => {
  test("returns true for ENOENT, ESRCH, EPERM, EINVAL, EACCES", () => {
    for (const code of ["ENOENT", "ESRCH", "EPERM", "EINVAL", "EACCES"]) {
      assert.equal(isProcRaceErr({ code }), true, code);
    }
  });

  test("returns false for unrelated errno codes", () => {
    assert.equal(isProcRaceErr({ code: "EIO" }), false);
    assert.equal(isProcRaceErr({ code: "ENOSPC" }), false);
  });

  test("returns false for null, undefined, and missing err", () => {
    assert.equal(isProcRaceErr(null), false);
    assert.equal(isProcRaceErr(undefined), false);
  });

  test("returns false when err has no code or empty code", () => {
    assert.equal(isProcRaceErr({}), false);
    assert.equal(isProcRaceErr({ code: "" }), false);
    assert.equal(isProcRaceErr({ code: null }), false);
    assert.equal(isProcRaceErr({ message: "ENOENT" }), false);
  });
});
describe("isScanSkippableErr", () => {
  test("is true for every error that makes one directory entry unreadable", () => {
    for (const code of [
      "ENOENT",
      "ENOTDIR",
      "EACCES",
      "EPERM",
      "ELOOP",
      "EMFILE",
      "ENFILE",
      "ENAMETOOLONG",
    ]) {
      assert.equal(isScanSkippableErr({ code }), true, `${code} should skip the subtree`);
    }
  });

  test("is false for errors that mean the scan itself is broken", () => {
    // EIO is a failing disk and ENOMEM is a failing process: neither is one
    // bad directory, and swallowing them would hide a real fault as an
    // apparently short session list.
    assert.equal(isScanSkippableErr({ code: "EIO" }), false);
    assert.equal(isScanSkippableErr({ code: "ENOMEM" }), false);
  });

  test("is false for null, undefined, and a missing code", () => {
    assert.equal(isScanSkippableErr(null), false);
    assert.equal(isScanSkippableErr(undefined), false);
    assert.equal(isScanSkippableErr({}), false);
    assert.equal(isScanSkippableErr({ code: "" }), false);
    assert.equal(isScanSkippableErr({ message: "EACCES" }), false);
  });
});
