import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../../readme.md", import.meta.url), "utf8");
const home = await readFile(new URL("../app/routes/_index.tsx", import.meta.url), "utf8");
const repository = "https://github.com/JANERUBBISHTOEAT/W2W.SPACE";

test("README screenshot disclosures enable Jekyll Markdown rendering", () => {
  const disclosures = [...readme.matchAll(/<details\b([^>]*)>/g)];
  assert.equal(disclosures.length, 4);
  for (const disclosure of disclosures) {
    assert.match(disclosure[1], /\bmarkdown="1"/, "Jekyll must render the screenshot Markdown inside each disclosure");
  }
});

test("Why W2W footer uses Pages and a stable, unique README anchor", () => {
  const link = home.match(/href="([^"]+)">\| Why W2W\?<\/a>/);
  assert.ok(link, "The home page must include its Why W2W link");
  assert.equal(link[1], "https://janerubbishtoeat.github.io/W2W.SPACE/#why-w2w");
  const anchor = `<a id="${new URL(link[1]).hash.slice(1)}"></a>`;
  assert.equal(readme.split(anchor).length - 1, 1, "The fragment must target exactly one explicit anchor");
  assert.match(readme.slice(readme.indexOf(anchor)), /^<a id="why-w2w"><\/a>\s+### Why WebToWeb over alternatives\?/);
  assert.ok(home.includes(`href="${repository}">| View on GitHub</a>`));
});

test("README deploy badge reports main pushes and links to the deployment workflow", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const badge = readme.match(/\[!\[Deploy W2W\]\(([^)]+)\)\]\(([^)]+)\)/);
  assert.ok(badge, "A linked Deploy W2W badge must be present");
  const image = new URL(badge[1]);
  assert.equal(image.origin + image.pathname, `${repository}/actions/workflows/deploy.yml/badge.svg`);
  assert.equal(image.searchParams.get("branch"), "main");
  assert.equal(image.searchParams.get("event"), "push", "PR verification must not look like a production deployment");
  const target = new URL(badge[2]);
  assert.equal(target.origin + target.pathname, `${repository}/actions/workflows/deploy.yml`);
  assert.equal(target.searchParams.get("query"), "branch:main event:push");
  const title = readme.indexOf("# 🌐 WebToWeb (W2W)");
  assert.ok(title >= 0 && title < badge.index);
  assert.ok(badge.index < readme.indexOf("> A browser-based"));
  assert.match(workflow, /^name: Deploy W2W$/m);
  assert.match(workflow, /push:\s+branches: \[main\]/);
});
