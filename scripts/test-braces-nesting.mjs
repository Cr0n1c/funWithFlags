import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockupPackage = path.join(workspaceRoot, "artifacts/mockup-sandbox/package.json");
const mockupRequire = createRequire(mockupPackage);
const fastGlobPath = mockupRequire.resolve("fast-glob");
const micromatchPath = createRequire(fastGlobPath).resolve("micromatch");
const bracesPath = createRequire(micromatchPath).resolve("braces");
const braces = createRequire(bracesPath)("braces");
const micromatch = createRequire(micromatchPath)("micromatch");

assert.deepEqual(braces.expand("{a,b}"), ["a", "b"]);
assert.equal(braces.compile("{a,b}"), "(a|b)");
assert.equal(braces.stringify("{a,b}"), "{a,b}");
assert.deepEqual(micromatch(["a.js", "b.ts", "c.txt"], "*.{js,ts}"), ["a.js", "b.ts"]);

const entryPoints = [
  ["parse", (pattern) => braces.parse(pattern)],
  ["compile", (pattern) => braces.compile(pattern)],
  ["expand", (pattern) => braces.expand(pattern)],
  ["stringify", (pattern) => braces.stringify(pattern)],
  ["default", (pattern) => braces(pattern)],
  ["array", (pattern) => braces([pattern])],
  ["micromatch", (pattern) => micromatch.braces(pattern)],
];

for (const [label, open, close] of [
  ["brace", "{", "}"],
  ["parenthesis", "(", ")"],
  ["mixed", "{(", ")}"],
]) {
  for (const [name, process] of entryPoints) {
    // Micromatch bypasses braces for patterns containing no brace groups.
    if (name === "micromatch" && label === "parenthesis") continue;
    // The root occupies one stack slot; 99 nested groups remain supported.
    const supportedDepth = Math.floor(99 / open.length);
    const supported = open.repeat(supportedDepth) + "x" + close.repeat(supportedDepth);
    assert.doesNotThrow(() => process(supported), `${name}: supported ${label} nesting`);

    for (const depth of [Math.ceil(100 / open.length), 1_000]) {
      const pattern = open.repeat(depth) + "x" + close.repeat(depth);
      assert.throws(
        () => process(pattern),
        (error) =>
          error instanceof RangeError &&
          error.message === "Nesting depth exceeds maximum (100)",
        `${name}: ${label} nesting must be rejected before recursive processing`,
      );
    }
  }
}

// Public walkers also accept caller-built ASTs, which do not pass through parse.
// Construct them iteratively so the test itself cannot exhaust the call stack.
const makeAst = (depth) => {
  const root = { type: "root", nodes: [] };
  let node = root;
  for (let i = 0; i < depth; i++) {
    const child = { type: "paren", nodes: [], parent: node };
    node.nodes.push(child);
    node = child;
  }
  node.nodes.push({ type: "text", value: "x", parent: node });
  return root;
};

for (const [name, expected] of [
  ["compile", "x"],
  ["expand", ["x"]],
  ["stringify", "x"],
]) {
  assert.deepEqual(braces[name](makeAst(99)), expected, `${name}: supported AST nesting`);
  for (const depth of [101, 1_000, 10_000]) {
    assert.throws(
      () => braces[name](makeAst(depth)),
      (error) =>
        error instanceof RangeError &&
        error.message === "Nesting depth exceeds maximum (100)",
      `${name}: caller-built AST nesting must be bounded`,
    );
  }
}

console.log("braces nesting security regression checks passed");
