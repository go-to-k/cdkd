import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { buildProgram } from "../../../src/cli/program.js";
import { setPasteableRunFlags } from "../../../src/utils/pasteable-run-context.js";
import { ensureNoEchoMacKey } from "../../../src/cli/commands/bootstrap-noecho-mac-key.js";
import { skippedDestroyMessage } from "../../../src/cli/commands/destroy-skip-message.js";
import { nonInteractiveBrowseRefusal } from "../../../src/cli/commands/state-browse.js";
import {
  lockReadFailedReason,
  stateListPointer,
  stateReadReasons,
} from "../../../src/cli/commands/state/refs.js";
import { stackRegionDescribedNote } from "../../../src/cli/commands/rollback/render.js";
import { unsettledCommandMessage } from "../../../src/cli/run-cli.js";

/**
 * go-to-k/cdkd#6262 (lane: CLI state / destroy / bootstrap): the remedies these
 * messages tell the operator to run carry the run's typed `--aws-emulator`,
 * and print byte-identically when no flag was typed.
 */
const EMU = "https://127.0.0.1:4599";
const FLAG = `--aws-emulator=${EMU}`;

beforeEach(() => {
  buildProgram();
  setPasteableRunFlags({});
});
afterEach(() => {
  setPasteableRunFlags({});
});

describe("bootstrap: the NoEcho MAC key warning", () => {
  const warnings = async (): Promise<string> => {
    const warn = vi.fn();
    const kms = {
      send: vi.fn().mockResolvedValue({
        KeyMetadata: {
          KeySpec: "SYMMETRIC_DEFAULT",
          KeyUsage: "ENCRYPT_DECRYPT",
          KeyState: "Enabled",
        },
      }),
    };
    await ensureNoEchoMacKey({
      kms,
      region: "us-east-1",
      accountId: "123456789012",
      partition: "aws",
      report: vi.fn(),
      warn,
    });
    return String(warn.mock.calls[0]?.[0]);
  };

  it("carries --aws-emulator on the re-run", async () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    expect(await warnings()).toContain(`re-run 'cdkd bootstrap ${FLAG}'.`);
  });

  it("is unchanged without a flag", async () => {
    expect(await warnings()).toContain("re-run 'cdkd bootstrap'.");
  });
});

describe("destroy: skippedDestroyMessage", () => {
  it("carries --aws-emulator on the re-run and the orphan remedy", () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    const text = skippedDestroyMessage(1, 0, "cdkd destroy");
    expect(text).toContain(`re-run 'cdkd destroy ${FLAG}'`);
    expect(text).toContain(
      `cdkd state orphan '<stack>' --stack-region '<region>' ${FLAG}.`,
    );
  });

  it("is unchanged without a flag", () => {
    const text = skippedDestroyMessage(1, 0, "cdkd state destroy");
    expect(text).toContain("re-run 'cdkd state destroy'");
    expect(text).toContain(
      "cdkd state orphan '<stack>' --stack-region '<region>'.",
    );
  });
});

describe("state: shared reason text", () => {
  it("carries --aws-emulator on the state show / list pointers", () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    expect(stateReadReasons()["read-failed"]).toBe(
      `state record could not be read; run \`cdkd state show ${FLAG}\` for the error`,
    );
    expect(stateReadReasons()["resources-malformed"]).toContain(
      `run \`cdkd state show --json ${FLAG}\` to see the record`,
    );
    expect(lockReadFailedReason()).toContain(`run \`cdkd state show ${FLAG}\``);
    expect(stateListPointer()).toBe(
      `'cdkd state list --long ${FLAG}' shows the records as stored.`,
    );
  });

  it("is unchanged without a flag", () => {
    expect(stateReadReasons()["read-failed"]).toBe(
      "state record could not be read; run `cdkd state show` for the error",
    );
    expect(stateListPointer()).toBe(
      "'cdkd state list --long' shows the records as stored.",
    );
  });
});

describe("state browse: the non-interactive refusal", () => {
  it("carries --aws-emulator on each command", () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    expect(nonInteractiveBrowseRefusal().message).toBe(
      `cdkd state browse needs an interactive terminal. Without one, use cdkd state list ${FLAG}, ` +
        `cdkd state resources '<stack>' ${FLAG} and cdkd state show '<stack>' ${FLAG}.`,
    );
  });

  it("is unchanged without a flag except the quoted placeholder", () => {
    expect(nonInteractiveBrowseRefusal().message).toBe(
      "cdkd state browse needs an interactive terminal. Without one, use cdkd state list, cdkd state resources '<stack>' and cdkd state show '<stack>'.",
    );
  });
});

describe("rollback: the described-name note", () => {
  it("carries --aws-emulator on state list --long", () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    expect(stackRegionDescribedNote()).toContain(
      `'cdkd state list --long ${FLAG}'`,
    );
  });

  it("is unchanged without a flag", () => {
    expect(stackRegionDescribedNote()).toContain("'cdkd state list --long'.)");
  });
});

describe("force-unlock: the unsettled-command message", () => {
  it("carries --aws-emulator on the force-unlock command", () => {
    setPasteableRunFlags({ awsEmulator: EMU });
    expect(unsettledCommandMessage()).toContain(
      `release it with: cdkd force-unlock '<stack-name>' ${FLAG}\n`,
    );
  });

  it("is unchanged without a flag except the quoted placeholder", () => {
    expect(unsettledCommandMessage()).toContain(
      "release it with: cdkd force-unlock '<stack-name>'\n",
    );
  });
});
