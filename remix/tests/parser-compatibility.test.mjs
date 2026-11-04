import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearCaches, parseForESLint } from "@typescript-eslint/parser";

const parserRequire = createRequire(import.meta.resolve("@typescript-eslint/parser"));
const estreeRequire = createRequire(parserRequire.resolve("@typescript-eslint/typescript-estree"));
const source = "const answer: number = 42;\n";

async function parserFixture(t, filename, allowDefaultProject) {
  clearCaches();
  const directory = await mkdtemp(join(tmpdir(), "w2w-parser-"));
  t.after(async () => {
    clearCaches();
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, filename);
  await Promise.all([
    writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022" },
      // The parsed file must stay outside this configured project so that
      // the real project service has to consult allowDefaultProject.
      files: ["included.ts"],
    })),
    writeFile(join(directory, "included.ts"), "export {};\n"),
    writeFile(filePath, source),
  ]);
  return {
    filePath,
    parse: () => parseForESLint(source, {
      filePath,
      tsconfigRootDir: directory,
      sourceType: "module",
      projectService: { allowDefaultProject },
    }),
  };
}

function assertTypedProgram(result, filePath) {
  assert.equal(result.ast.type, "Program");
  assert.equal(result.services.program?.getSourceFile(filePath)?.text, source);
  const identifier = result.ast.body[0].declarations[0].id;
  const node = result.services.esTreeNodeToTSNodeMap.get(identifier);
  const checker = result.services.program.getTypeChecker();
  assert.equal(checker.typeToString(checker.getTypeAtLocation(node)), "number");
}

test("parser project service accepts a matching default-project glob", async (t) => {
  // Resolve from the parser's own estree dependency; the unrelated ESLint
  // minimatch 3 copy must not stand in for the scoped replacement.
  assert.match(estreeRequire("minimatch/package.json").version, /^11\./);
  const fixture = await parserFixture(t, "allowed-example.ts", ["allowed-*.ts"]);
  assertTypedProgram(fixture.parse(), fixture.filePath);
});

test("parser project service rejects a file outside the allowed glob", async (t) => {
  const fixture = await parserFixture(t, "denied-example.ts", ["allowed-*.ts"]);
  assert.throws(fixture.parse, (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /was not found by the project service/);
    assert.match(error.message, /allowDefaultProject.*does not match 'denied-example\.ts'/s);
    return true;
  });
});

test("parser default-project glob preserves dot-file matching", async (t) => {
  const fixture = await parserFixture(t, ".hidden.ts", ["*.ts"]);
  assertTypedProgram(fixture.parse(), fixture.filePath);
});
