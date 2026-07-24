import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const wrapper = path.join(root, "scripts/governance-python.sh");

function executable(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function fakePython(file, { dependency = true } = {}) {
  executable(
    file,
    `#!/bin/sh
if [ "$1" = "-c" ]; then
  case "$2" in
    *"print(f"*) echo "3.12.0 (PyYAML 6.0.3)"; exit 0 ;;
    *"yaml.__version__"*) exit ${dependency ? "0" : "1"} ;;
    *"sys.version_info"*) exit 0 ;;
  esac
fi
printf 'EXEC:'
printf ' %s' "$@"
printf '\\n'
`,
  );
}

test("wrapper selects the first compatible governance Python", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reflo-governance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "missing");
  const compatible = path.join(directory, "compatible");
  mkdirSync(missing);
  mkdirSync(compatible);
  fakePython(path.join(missing, "python3"), { dependency: false });
  fakePython(path.join(compatible, "python3"));

  const result = spawnSync("/bin/sh", [wrapper, "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      REFLO_GOVERNANCE_PYTHON_DIRS: `${missing}:${compatible}`,
      REFLO_GOVERNANCE_ROOT: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `governance python: ${compatible.replaceAll("/", "\\/")}\\/python3`,
    ),
  );
  assert.match(result.stdout, /3\.12\.0 \(PyYAML 6\.0\.3\)/);
});

test("wrapper fails early with one pinned dependency remediation", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reflo-governance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, "python3");
  fakePython(python, { dependency: false });

  const result = spawnSync("/bin/sh", [wrapper, "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      REFLO_GOVERNANCE_PYTHON: python,
      REFLO_GOVERNANCE_ROOT: root,
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /governance Python requires Python >=3\.10 with PyYAML==6\.0\.3/,
  );
  assert.match(
    result.stderr,
    new RegExp(
      `Run: "${python.replaceAll("/", "\\/")}" -m pip install --requirement`,
    ),
  );
  assert.doesNotMatch(result.stdout, /EXEC:/);
});

test("wrapper forwards governance command arguments to the selected runtime", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reflo-governance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, "python3");
  fakePython(python);

  const result = spawnSync(
    "/bin/sh",
    [wrapper, "scripts/validate_adrs.py", "--resolve", "0018"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        REFLO_GOVERNANCE_PYTHON: python,
        REFLO_GOVERNANCE_ROOT: root,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "EXEC: scripts/validate_adrs.py --resolve 0018\n",
  );
});
