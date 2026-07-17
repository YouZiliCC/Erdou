import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { detectRunCommand, staticServeCommand } from "./run-detect.js";

describe("detectRunCommand", () => {
  it("detects a Flask WSGI app and suggests `python <file>`", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile(
      "/app.py",
      "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/')\ndef index():\n    return 'hi'\n",
    );
    expect(detectRunCommand(fs)).toBe("python /app.py");
  });

  it("detects a top-level `application =` WSGI callable in a nested file", () => {
    const fs = new BrowserRuntime().fs;
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/wsgi.py", "def make():\n    pass\n\napplication = make()\n");
    expect(detectRunCommand(fs)).toBe("python /src/wsgi.py");
  });

  it("detects a root index.html and suggests `erdou serve / --spa`", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/index.html", "<!doctype html><html><body>hi</body></html>");
    expect(detectRunCommand(fs)).toBe("erdou serve / --spa");
  });

  it("detects a dist/index.html and suggests `erdou serve /dist --spa`", () => {
    const fs = new BrowserRuntime().fs;
    fs.mkdir("/dist", { recursive: true });
    fs.writeFile("/dist/index.html", "<!doctype html><html><body>built</body></html>");
    expect(detectRunCommand(fs)).toBe("erdou serve /dist --spa");
  });

  it("returns null when nothing is detected", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/readme.txt", "just some notes, no app here");
    expect(detectRunCommand(fs)).toBeNull();
  });

  it("prefers a WSGI app over a coincidental index.html", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/index.html", "<!doctype html><html><body>hi</body></html>");
    fs.writeFile("/server.py", "from flask import Flask\napp = Flask(__name__)\n");
    expect(detectRunCommand(fs)).toBe("python /server.py");
  });
});

describe("staticServeCommand", () => {
  it("browser: the erdou serve builtin with --spa", () => {
    expect(staticServeCommand("browser", "/dist")).toBe("erdou serve /dist --spa");
  });

  it("vm: python3 http.server on 8080 bound 0.0.0.0 (no erdou binary in the guest)", () => {
    expect(staticServeCommand("vm", "/dist")).toBe("python3 -m http.server 8080 --bind 0.0.0.0 -d /dist");
  });
});

describe("detectRunCommand (vm kernel)", () => {
  it("does NOT prefill a root serve on the vm kernel (chroot root exposes skeleton dirs and /dev nodes)", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/index.html", "<!doctype html><html><body>hi</body></html>");
    expect(detectRunCommand(fs, "vm")).toBeNull();
  });

  it("suggests python3 http.server for /dist/index.html on the vm kernel", () => {
    const fs = new BrowserRuntime().fs;
    fs.mkdir("/dist", { recursive: true });
    fs.writeFile("/dist/index.html", "<!doctype html><html><body>built</body></html>");
    expect(detectRunCommand(fs, "vm")).toBe("python3 -m http.server 8080 --bind 0.0.0.0 -d /dist");
  });

  it("defaults to the browser kernel when kind is omitted (existing call sites)", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/index.html", "<!doctype html>");
    expect(detectRunCommand(fs)).toBe("erdou serve / --spa");
  });

  it("skips the WSGI prefill on the vm kernel (no flask in the bare guest python3) -> null", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/app.py", "from flask import Flask\napp = Flask(__name__)\n");
    expect(detectRunCommand(fs, "vm")).toBeNull();
  });

  it("WSGI file on the vm kernel falls through to the /dist static prefill when present", () => {
    const fs = new BrowserRuntime().fs;
    fs.writeFile("/server.py", "from flask import Flask\napp = Flask(__name__)\n");
    fs.mkdir("/dist", { recursive: true });
    fs.writeFile("/dist/index.html", "<!doctype html><html><body>built</body></html>");
    expect(detectRunCommand(fs, "vm")).toBe("python3 -m http.server 8080 --bind 0.0.0.0 -d /dist");
  });
});
