// Enforces the strict bottom-up layering from notice.md:
//   Agent depends on Runtime; Runtime never depends on Agent.
//   Agent binds to the Runtime Contract, not a concrete Runtime.
// Cross-package @erdou imports resolve to each package's src via its exports.
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "No circular dependencies between modules.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "contract-stays-pure",
      comment: "runtime-contract is the frozen boundary; it depends on no other @erdou package.",
      severity: "error",
      from: { path: "^packages/runtime-contract/src" },
      to: { path: "^packages/(runtime-browser|conformance|model-gateway|agent-tools|agent-core|lang-python|runtime-wasi|bundler)/src" },
    },
    {
      name: "adapters-are-lean",
      comment:
        "Language runtimes (lang-*) and runtime adapters (runtime-wasi) operate on the contract only, not a concrete Runtime. Tests may import one.",
      severity: "error",
      from: { path: "^packages/(lang-[^/]+|runtime-wasi|bundler)/src", pathNot: "\\.test\\.ts$" },
      to: { path: "^packages/(runtime-browser|model-gateway|agent-tools|agent-core)/src" },
    },
    {
      name: "agent-tools-is-lean",
      comment: "agent-tools operates on the Runtime contract only (not a concrete Runtime, model, or agent-core). Tests may import a concrete runtime.",
      severity: "error",
      from: { path: "^packages/agent-tools/src", pathNot: "\\.test\\.ts$" },
      to: { path: "^packages/(runtime-browser|model-gateway|agent-core)/src" },
    },
    {
      name: "agent-core-binds-to-contract",
      comment: "agent-core binds to the Runtime contract, not a concrete Runtime. Tests may import a concrete runtime.",
      severity: "error",
      from: { path: "^packages/agent-core/src", pathNot: "\\.test\\.ts$" },
      to: { path: "^packages/runtime-browser/src" },
    },
    {
      name: "runtime-browser-only-contract",
      comment: "runtime-browser may import only @erdou/runtime-contract.",
      severity: "error",
      from: { path: "^packages/runtime-browser/src" },
      to: { path: "^packages/(conformance|model-gateway)/src" },
    },
    {
      name: "runtime-never-imports-model-or-agent",
      comment: "Runtime layers must never depend on the model gateway or any agent layer.",
      severity: "error",
      from: { path: "^packages/runtime-(contract|browser)/src" },
      to: { path: "(model-gateway|agent-)" },
    },
    {
      name: "conformance-suite-only-contract",
      comment:
        "Conformance suite modules depend only on the contract. Only the glue test may import a concrete Runtime.",
      severity: "error",
      from: { path: "^packages/conformance/src/(suites/|types\\.ts|index\\.ts)" },
      to: { path: "^packages/runtime-browser/src" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.base.json" },
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};
