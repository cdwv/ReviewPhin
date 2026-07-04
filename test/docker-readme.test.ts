import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/build-docker-readme.cjs");

describe("Docker Hub README generation", () => {
  it("rewrites local README links and images to the public site", async () => {
    const output = await generateDockerReadme(`
<div align="center">
  <img src="./public/favicon.png" alt="ReviewPhin" width="120" />
</div>

![Local diagram](docs/diagram.png)
[![Local badge](public/badge.png)](LICENSE)
[License](LICENSE)
[Docs](https://reviewphin.com/docs/)
[Section](#quickstart)
[Email](mailto:hello@example.com)
![External badge](https://img.shields.io/badge/example-ok-blue)
![Inline image](data:image/png;base64,abc)
`);

    expect(output).toContain(
      '<img src="https://reviewphin.com/favicon.png" alt="ReviewPhin" width="120" />',
    );
    expect(output).toContain(
      "![Local diagram](https://reviewphin.com/docs/diagram.png)",
    );
    expect(output).toContain(
      "[![Local badge](https://reviewphin.com/badge.png)](https://reviewphin.com/LICENSE)",
    );
    expect(output).toContain("[License](https://reviewphin.com/LICENSE)");
    expect(output).toContain("[Docs](https://reviewphin.com/docs/)");
    expect(output).toContain("[Section](#quickstart)");
    expect(output).toContain("[Email](mailto:hello@example.com)");
    expect(output).toContain(
      "![External badge](https://img.shields.io/badge/example-ok-blue)",
    );
    expect(output).toContain("![Inline image](data:image/png;base64,abc)");
    expect(output).not.toContain("github.com/cdwv/reviewphin/blob");
  });

  it("can target a different public site URL", async () => {
    const output = await generateDockerReadme(
      "[Docs](https://reviewphin.com/docs/)",
      {
        PUBLIC_SITE_URL: "https://docs.example.test/base",
      },
    );

    expect(output).toBe("[Docs](https://docs.example.test/base/docs/)");
  });
});

async function generateDockerReadme(
  readme: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "reviewphin-docker-readme-"));

  try {
    await writeFile(join(tempDir, "README.md"), readme.trim(), "utf8");
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        PUBLIC_SITE_URL: "https://reviewphin.com",
        ...env,
      },
    });

    return await readFile(join(tempDir, "DOCKERHUB_README.md"), "utf8");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
