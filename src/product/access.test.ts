import { describe, expect, it } from "vitest";

import { brand } from "../brand/index.ts";

import { productErrorHint } from "./access.ts";

const refused = (scope: string) => ({
  code: "forbidden",
  message: `This credential is not granted the ${scope} scope`,
});

describe("productErrorHint", () => {
  it("names Publish and run scripts for a script or run scope", () => {
    expect(productErrorHint(refused("scripts:write"))).toBe(
      `Sign in again with \`${brand.name} login\` and choose Publish and run scripts.`,
    );
    expect(productErrorHint(refused("runs:write"))).toContain(
      "Publish and run scripts",
    );
  });

  it("names Full access for any other scope", () => {
    expect(productErrorHint(refused("secrets:write"))).toContain(
      "choose Full access.",
    );
  });

  it("says nothing for other refusals", () => {
    expect(
      productErrorHint({ code: "forbidden", message: "Owners only" }),
    ).toBeNull();
    expect(
      productErrorHint({ code: "not_found", message: "No script" }),
    ).toBeNull();
  });
});
