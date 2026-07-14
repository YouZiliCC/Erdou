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
      to: { path: "^packages/(runtime-browser|conformance|model-gateway)/src" },
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
