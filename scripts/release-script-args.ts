export type ReleaseScriptArgs = {
  readonly flags: Set<string>;
  readonly options: Map<string, string>;
  readonly manifestArg: string;
};

export type ReleaseScriptArgResult =
  | {
    readonly ok: true;
    readonly args: ReleaseScriptArgs;
  }
  | {
    readonly ok: false;
    readonly exitCode: 0 | 1;
    readonly message: string;
  };

export function parseReleaseScriptArgs(
  argv: string[],
  options: {
    readonly usage: string;
    readonly allowedFlags?: readonly string[];
    readonly allowedValueOptions?: readonly string[];
  }
): ReleaseScriptArgResult {
  const args = argv.filter((arg) => arg !== "--");
  const allowedFlags = new Set(options.allowedFlags ?? []);
  const allowedValueOptions = new Set(options.allowedValueOptions ?? []);

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: false, exitCode: 0, message: options.usage };
  }

  if (args.length === 0) {
    return { ok: false, exitCode: 1, message: options.usage };
  }

  if (args.includes("--help") || args.includes("-h")) {
    return {
      ok: false,
      exitCode: 1,
      message: `help must be requested without other arguments\n${options.usage}`
    };
  }

  const flags = new Set<string>();
  const valueOptions = new Map<string, string>();
  const manifestArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("-")) {
      if (allowedValueOptions.has(arg)) {
        if (valueOptions.has(arg)) {
          return {
            ok: false,
            exitCode: 1,
            message: `duplicate option: ${arg}\n${options.usage}`
          };
        }

        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          return {
            ok: false,
            exitCode: 1,
            message: `missing value for option: ${arg}\n${options.usage}`
          };
        }

        valueOptions.set(arg, value);
        index += 1;
        continue;
      }

      if (!allowedFlags.has(arg)) {
        return {
          ok: false,
          exitCode: 1,
          message: `unknown option: ${arg}\n${options.usage}`
        };
      }

      if (flags.has(arg)) {
        return {
          ok: false,
          exitCode: 1,
          message: `duplicate option: ${arg}\n${options.usage}`
        };
      }

      flags.add(arg);
      continue;
    }

    manifestArgs.push(arg);
  }

  if (manifestArgs.length !== 1) {
    return {
      ok: false,
      exitCode: 1,
      message: `expected exactly one release manifest path\n${options.usage}`
    };
  }
  const manifestArg = manifestArgs[0];
  if (!manifestArg) {
    return {
      ok: false,
      exitCode: 1,
      message: `expected exactly one release manifest path\n${options.usage}`
    };
  }

  return {
    ok: true,
    args: {
      flags,
      options: valueOptions,
      manifestArg
    }
  };
}
