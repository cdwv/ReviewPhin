import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/build-docker-readme.cjs");

describe("Docker Hub README generation", () => {
  it("keeps the source README Docker badge pointed at Docker Hub", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain(
      "[![Docker Image](https://img.shields.io/badge/docker-cdwv%2Freviewphin-blue?logo=docker)](https://hub.docker.com/r/cdwv/reviewphin)",
    );
  });

  it("rewrites the Docker Hub README Docker badge to a GitHub repository badge", async () => {
    const output = await generateDockerReadme(
      "[![Docker Image](https://img.shields.io/badge/docker-cdwv%2Freviewphin-blue?logo=docker)](https://hub.docker.com/r/cdwv/reviewphin)",
    );

    expect(output).toBe(
      "[![GitHub repository](https://img.shields.io/badge/github-cdwv%2FReviewPhin-blue?logo=github)](https://github.com/cdwv/ReviewPhin)",
    );
  });

  it("rewrites local README links and images to their public targets", async () => {
    const output = await generateDockerReadme(`
<div align="center">
  <img src="./public/favicon.png" alt="ReviewPhin" width="120" />
</div>

![Local diagram](docs/diagram.png)
[![Local badge](public/badge.png)](LICENSE)
[License](LICENSE)
[Example env](.env.example)
[Local docs](docs/deployment/storage/)
[Public asset](public/favicon.png)
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
      "[![Local badge](https://reviewphin.com/badge.png)](https://github.com/cdwv/ReviewPhin/blob/main/LICENSE)",
    );
    expect(output).toContain(
      "[License](https://github.com/cdwv/ReviewPhin/blob/main/LICENSE)",
    );
    expect(output).toContain(
      "[Example env](https://github.com/cdwv/ReviewPhin/blob/main/.env.example)",
    );
    expect(output).toContain(
      "[Local docs](https://reviewphin.com/docs/deployment/storage/)",
    );
    expect(output).toContain(
      "[Public asset](https://reviewphin.com/favicon.png)",
    );
    expect(output).toContain("[Docs](https://reviewphin.com/docs/)");
    expect(output).toContain("[Section](#quickstart)");
    expect(output).toContain("[Email](mailto:hello@example.com)");
    expect(output).toContain(
      "![External badge](https://img.shields.io/badge/example-ok-blue)",
    );
    expect(output).toContain("![Inline image](data:image/png;base64,abc)");
    expect(output).not.toContain("https://reviewphin.com/LICENSE");
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

  it("can target a different repository URL and ref", async () => {
    const output = await generateDockerReadme("[License](LICENSE)", {
      REPOSITORY_REF: "v1.2.3",
      REPOSITORY_URL: "https://github.example.test/acme/reviewphin/",
    });

    expect(output).toBe(
      "[License](https://github.example.test/acme/reviewphin/blob/v1.2.3/LICENSE)",
    );
  });
});

async function generateDockerReadme(
  readme: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "reviewphin-docker-readme-"));
  const baseEnv = { ...process.env };

  delete baseEnv.GITHUB_REF_NAME;
  delete baseEnv.GITHUB_REPOSITORY;
  delete baseEnv.GITHUB_SERVER_URL;

  try {
    await writeFile(join(tempDir, "README.md"), readme.trim(), "utf8");
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: tempDir,
      env: {
        ...baseEnv,
        PUBLIC_SITE_URL: "https://reviewphin.com",
        ...env,
      },
    });

    return await readFile(join(tempDir, "DOCKERHUB_README.md"), "utf8");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
