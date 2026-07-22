import { describe, it, expect } from "vitest";
import { normalizeReq, buildLocalWheelResolver, type WheelManifest } from "./wheel-index.js";

const manifest: WheelManifest = {
  pyodideProvided: ["lxml", "Pillow"],
  closures: {
    "python-pptx": ["python-pptx", "XlsxWriter", "typing_extensions"],
    openpyxl: ["openpyxl", "et_xmlfile"],
  },
  wheels: {
    "python-pptx": { version: "1.0.2", file: "python_pptx-1.0.2-py3-none-any.whl", url: "u", sha256: "s" },
    XlsxWriter: { version: "3.2.9", file: "xlsxwriter-3.2.9-py2.py3-none-any.whl", url: "u", sha256: "s" },
    typing_extensions: { version: "4.16.0", file: "typing_extensions-4.16.0-py3-none-any.whl", url: "u", sha256: "s" },
    openpyxl: { version: "3.1.5", file: "openpyxl-3.1.5-py2.py3-none-any.whl", url: "u", sha256: "s" },
    et_xmlfile: { version: "2.0.0", file: "et_xmlfile-2.0.0-py3-none-any.whl", url: "u", sha256: "s" },
  },
};

describe("normalizeReq", () => {
  it("strips version specifiers/extras and folds case + underscores", () => {
    expect(normalizeReq("python-pptx==1.0.2")).toBe("python-pptx");
    expect(normalizeReq("Python_PPTX")).toBe("python-pptx");
    expect(normalizeReq("openpyxl>=3")).toBe("openpyxl");
    expect(normalizeReq("typing_extensions")).toBe("typing-extensions");
  });
});

describe("buildLocalWheelResolver", () => {
  const resolve = buildLocalWheelResolver(manifest, "https://app.example");

  it("resolves a bundled top package to its closure of same-origin wheel URLs", () => {
    expect(resolve("python-pptx")).toEqual([
      "https://app.example/wheels/python_pptx-1.0.2-py3-none-any.whl",
      "https://app.example/wheels/xlsxwriter-3.2.9-py2.py3-none-any.whl",
      "https://app.example/wheels/typing_extensions-4.16.0-py3-none-any.whl",
    ]);
  });

  it("resolves a version-pinned request the same way", () => {
    expect(resolve("openpyxl==3.1.5")?.[0]).toBe("https://app.example/wheels/openpyxl-3.1.5-py2.py3-none-any.whl");
  });

  it("resolves a bundled leaf (not a closure key) to just its own wheel", () => {
    expect(resolve("typing-extensions")).toEqual(["https://app.example/wheels/typing_extensions-4.16.0-py3-none-any.whl"]);
  });

  it("returns null for an unbundled package (falls through to loadPackage/micropip)", () => {
    expect(resolve("requests")).toBeNull();
  });

  it("trims a trailing slash on origin", () => {
    const r = buildLocalWheelResolver(manifest, "https://app.example/");
    expect(r("openpyxl")?.[0]).toBe("https://app.example/wheels/openpyxl-3.1.5-py2.py3-none-any.whl");
  });

  it("fails fast if a closure references a wheel the manifest does not pin", () => {
    const broken: WheelManifest = { ...manifest, closures: { pkg: ["pkg", "ghost"] }, wheels: { pkg: manifest.wheels.openpyxl! } };
    expect(() => buildLocalWheelResolver(broken, "https://x")("pkg")).toThrow(/no wheel for "ghost"/);
  });
});
