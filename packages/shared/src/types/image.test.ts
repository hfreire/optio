import { describe, it, expect } from "vitest";
import { isValidCustomImage, repoImageConfig } from "./image.js";

const DIGEST = "a".repeat(64);

describe("isValidCustomImage", () => {
  it.each([
    "ubuntu",
    "ubuntu:24.04",
    "ghcr.io/org/agent:v1",
    "zot.k8s1.se.home/optio-agent-esp-idf:v5.2",
    `zot.k8s1.se.home/optio-agent-esp-idf:v5.2@sha256:${DIGEST}`,
    `registry.local:5000/team/agent@sha256:${DIGEST}`,
    "registry.local:5000/team/agent:1",
  ])("accepts %s", (ref) => {
    expect(isValidCustomImage(ref)).toBe(true);
  });

  it.each([
    "",
    "has space:1",
    "img\nname",
    "-leading-dash",
    "/abs/path",
    "name@sha256:short",
    "name@md5:" + DIGEST,
    "a".repeat(300),
    "name;rm -rf /",
  ])("rejects %j", (ref) => {
    expect(isValidCustomImage(ref)).toBe(false);
  });
});

describe("repoImageConfig", () => {
  it("prefers the custom image over the preset", () => {
    expect(repoImageConfig({ imagePreset: "node", customImage: "reg/x:1" })).toEqual({
      customImage: "reg/x:1",
    });
  });

  it("uses the preset when no custom image is set", () => {
    expect(repoImageConfig({ imagePreset: "node", customImage: null })).toEqual({
      preset: "node",
    });
  });

  it("falls back to the base preset", () => {
    expect(repoImageConfig({ imagePreset: null })).toEqual({ preset: "base" });
  });
});
