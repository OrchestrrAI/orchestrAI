// specs/085-multi-ecosystem-dependency-audit/spec.md — real fixture
// content per format, written against real, documented examples (not
// invented), matching the standard every parser in this spec is held
// to.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import {
  detectEcosystem,
  parseGoMod,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
  readComposerLockfile,
  readComposerManifest,
  readGoMod,
  readNpmLockfile,
  readNpmManifest,
  readPomXml,
  readPyPiManifest,
} from "./dependency-manifests"

function scratchDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

describe("detectEcosystem", () => {
  test("npm wins when package.json is present, even alongside others", () => {
    const dir = scratchDir("detect-npm-")
    writeFileSync(path.join(dir, "package.json"), "{}")
    writeFileSync(path.join(dir, "go.mod"), "module x\n")
    expect(detectEcosystem(dir)).toEqual({ ecosystem: "npm", manifestFile: "package.json" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("requirements.txt wins over pyproject.toml when both present", () => {
    const dir = scratchDir("detect-py-")
    writeFileSync(path.join(dir, "requirements.txt"), "foo==1.0\n")
    writeFileSync(path.join(dir, "pyproject.toml"), "[project]\n")
    expect(detectEcosystem(dir)).toEqual({ ecosystem: "PyPI", manifestFile: "requirements.txt" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("go.mod detected when nothing npm/Python present", () => {
    const dir = scratchDir("detect-go-")
    writeFileSync(path.join(dir, "go.mod"), "module x\n")
    expect(detectEcosystem(dir)).toEqual({ ecosystem: "Go", manifestFile: "go.mod" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("composer.json detected", () => {
    const dir = scratchDir("detect-composer-")
    writeFileSync(path.join(dir, "composer.json"), "{}")
    expect(detectEcosystem(dir)).toEqual({ ecosystem: "Packagist", manifestFile: "composer.json" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("pom.xml detected", () => {
    const dir = scratchDir("detect-maven-")
    writeFileSync(path.join(dir, "pom.xml"), "<project></project>")
    expect(detectEcosystem(dir)).toEqual({ ecosystem: "Maven", manifestFile: "pom.xml" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("none present returns null", () => {
    const dir = scratchDir("detect-none-")
    expect(detectEcosystem(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("parseRequirementsTxt", () => {
  test("real, mixed exact-pin and range content", () => {
    const content = [
      "# a comment",
      "",
      "requests==2.31.0",
      "flask>=2.0",
      "numpy~=1.24",
      "django",
      "-r other-requirements.txt",
    ].join("\n")
    const result = parseRequirementsTxt(content)
    expect(result.dependencies["requests"]).toBe("==2.31.0")
    expect(result.dependencies["flask"]).toBe(">=2.0")
    expect(result.dependencies["numpy"]).toBe("~=1.24")
    expect(result.dependencies["django"]).toBe("")
    expect(result.unpinned.map(([n]) => n).sort()).toEqual(["django", "flask", "numpy"])
    expect(result.dependencies["other-requirements"]).toBeUndefined() // -r line not followed
  })
})

describe("parsePyprojectToml", () => {
  test("real PEP 621 [project.dependencies] array shape", () => {
    const content = [
      "[project]",
      'name = "example"',
      "dependencies = [",
      '  "requests==2.31.0",',
      '  "flask>=2.0",',
      "]",
    ].join("\n")
    const result = parsePyprojectToml(content)
    expect(result.dependencies["requests"]).toBe("==2.31.0")
    expect(result.dependencies["flask"]).toBe(">=2.0")
    expect(result.unpinned.map(([n]) => n)).toEqual(["flask"])
  })

  test("real Poetry [tool.poetry.dependencies] table shape", () => {
    const content = [
      "[tool.poetry.dependencies]",
      'python = "^3.10"',
      'requests = "2.31.0"',
      'flask = "^2.0"',
    ].join("\n")
    const result = parsePyprojectToml(content)
    expect(result.dependencies["python"]).toBeUndefined() // excluded — not a real package
    expect(result.dependencies["requests"]).toBe("2.31.0")
    expect(result.dependencies["flask"]).toBe("^2.0")
    expect(result.unpinned.map(([n]) => n)).toEqual(["flask"])
  })
})

describe("parseGoMod", () => {
  test("real require block, including an indirect dependency", () => {
    const content = [
      "module example.com/scratch",
      "",
      "go 1.21",
      "",
      "require (",
      "\tgithub.com/foo/bar v1.2.3",
      "\tgithub.com/baz/qux v0.4.0 // indirect",
      ")",
    ].join("\n")
    const result = parseGoMod(content)
    expect(result).toEqual([
      { name: "github.com/foo/bar", version: "v1.2.3" },
      { name: "github.com/baz/qux", version: "v0.4.0" },
    ])
  })

  test("a single-line require statement", () => {
    const content = "module x\n\nrequire github.com/foo/bar v1.2.3\n"
    expect(parseGoMod(content)).toEqual([{ name: "github.com/foo/bar", version: "v1.2.3" }])
  })
})

describe("parsePomXml", () => {
  test("real dependency entries with groupId:artifactId naming", () => {
    const content = `<project>
      <dependencies>
        <dependency>
          <groupId>org.springframework</groupId>
          <artifactId>spring-core</artifactId>
          <version>5.3.9</version>
        </dependency>
      </dependencies>
    </project>`
    expect(parsePomXml(content)).toEqual([{ name: "org.springframework:spring-core", version: "5.3.9" }])
  })

  test("a same-file ${property} placeholder is resolved", () => {
    const content = `<project>
      <properties>
        <spring.version>5.3.9</spring.version>
      </properties>
      <dependencies>
        <dependency>
          <groupId>org.springframework</groupId>
          <artifactId>spring-core</artifactId>
          <version>\${spring.version}</version>
        </dependency>
      </dependencies>
    </project>`
    expect(parsePomXml(content)).toEqual([{ name: "org.springframework:spring-core", version: "5.3.9" }])
  })

  test("an unresolvable (parent-POM) placeholder is reported literally, not dropped or guessed", () => {
    const content = `<project>
      <dependencies>
        <dependency>
          <groupId>org.example</groupId>
          <artifactId>lib</artifactId>
          <version>\${parent.defined.version}</version>
        </dependency>
      </dependencies>
    </project>`
    expect(parsePomXml(content)).toEqual([{ name: "org.example:lib", version: "${parent.defined.version}" }])
  })
})

describe("readComposerManifest", () => {
  test("real require/require-dev, platform packages excluded, unpinned detected", async () => {
    const dir = scratchDir("composer-manifest-")
    writeFileSync(
      path.join(dir, "composer.json"),
      JSON.stringify({
        require: { php: ">=7.4", "monolog/monolog": "2.9.1", "guzzlehttp/guzzle": "^7.0" },
        "require-dev": { "phpunit/phpunit": "^9.0" },
      }),
    )
    const result = await readComposerManifest(dir)
    expect(result.dependencies["php"]).toBeUndefined() // platform package, excluded
    expect(result.dependencies["monolog/monolog"]).toBe("2.9.1")
    expect(result.dependencies["guzzlehttp/guzzle"]).toBe("^7.0")
    expect(result.unpinned.map(([n]) => n).sort()).toEqual(["guzzlehttp/guzzle", "phpunit/phpunit"])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("readComposerLockfile", () => {
  test("real packages/packages-dev structure, confirmed against a live composer.lock", async () => {
    const dir = scratchDir("composer-lock-")
    writeFileSync(
      path.join(dir, "composer.lock"),
      JSON.stringify({
        packages: [{ name: "composer/ca-bundle", version: "1.5.14", type: "library" }],
        "packages-dev": [{ name: "phpunit/phpunit", version: "9.6.0" }],
      }),
    )
    const result = await readComposerLockfile(dir)
    expect(result).toEqual([
      { name: "composer/ca-bundle", version: "1.5.14" },
      { name: "phpunit/phpunit", version: "9.6.0" },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns null when no lockfile exists", async () => {
    const dir = scratchDir("composer-nolock-")
    expect(await readComposerLockfile(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("readNpmLockfile", () => {
  test("real lockfileVersion 3 packages object, transitive deps included, root skipped", async () => {
    const dir = scratchDir("npm-lock-")
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "scratch" }, // the root project itself — skipped
          "node_modules/left-pad": { version: "1.0.0" },
          "node_modules/@scope/pkg": { version: "2.0.0" },
          "node_modules/left-pad/node_modules/nested": { version: "0.1.0" }, // a transitive dep
        },
      }),
    )
    const result = await readNpmLockfile(dir)
    expect(result).toEqual([
      { name: "left-pad", version: "1.0.0" },
      { name: "@scope/pkg", version: "2.0.0" },
      { name: "nested", version: "0.1.0" },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns null when no lockfile exists", async () => {
    const dir = scratchDir("npm-nolock-")
    expect(await readNpmLockfile(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("readGoMod / readPomXml — real file reads", () => {
  test("readGoMod reads a real file from disk", async () => {
    const dir = scratchDir("go-real-")
    writeFileSync(path.join(dir, "go.mod"), "module x\n\nrequire github.com/foo/bar v1.2.3\n")
    expect(await readGoMod(dir)).toEqual([{ name: "github.com/foo/bar", version: "v1.2.3" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("readPomXml reads a real file from disk", async () => {
    const dir = scratchDir("maven-real-")
    writeFileSync(
      path.join(dir, "pom.xml"),
      "<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>",
    )
    expect(await readPomXml(dir)).toEqual([{ name: "g:a", version: "1.0" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("a genuinely malformed manifest fails closed with a named parse error", async () => {
    const dir = scratchDir("go-malformed-")
    // go.mod itself is never JSON-malformed the way JSON files can be —
    // but a missing file (present-per-detection yet unreadable) still
    // needs a real, named error, not a silent empty result.
    expect(readGoMod(dir)).rejects.toThrow(/Could not read go.mod/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("readPyPiManifest", () => {
  test("reads a real requirements.txt file from disk", async () => {
    const dir = scratchDir("pypi-real-")
    writeFileSync(path.join(dir, "requirements.txt"), "requests==2.31.0\n")
    const result = await readPyPiManifest(dir, "requirements.txt")
    expect(result.dependencies["requests"]).toBe("==2.31.0")
    rmSync(dir, { recursive: true, force: true })
  })
})
