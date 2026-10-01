import fs from "node:fs";
import path from "node:path";
import solc from "solc";

export function compile() {
  const sources = {};
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith(".sol"))
        sources[f] = { content: fs.readFileSync(f, "utf8") };
    }
  }
  walk("contracts");
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };
  const out = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (f) => {
        try {
          return {
            contents: fs.readFileSync(path.join("node_modules", f), "utf8"),
          };
        } catch {
          return { error: `Import not found: ${f}` };
        }
      },
    }),
  );
  for (const e of out.errors || []) console.error(e.formattedMessage);
  if (out.errors?.some((e) => e.severity === "error"))
    throw new Error("Solidity compilation failed");
  fs.mkdirSync("artifacts", { recursive: true });
  // Standard JSON input, kept for source verification on a block explorer.
  fs.writeFileSync("artifacts/solc-input.json", JSON.stringify(input) + "\n");
  fs.mkdirSync("public", { recursive: true });
  const abis = {};
  for (const [source, contracts] of Object.entries(out.contracts)) {
    if (!source.startsWith("contracts/")) continue;
    for (const [name, contract] of Object.entries(contracts)) {
      const bytecode = "0x" + contract.evm.bytecode.object;
      const runtimeBytes = contract.evm.deployedBytecode.object.length / 2;
      if (runtimeBytes > 24576) throw new Error(`${name} exceeds EIP-170`);
      fs.writeFileSync(
        `artifacts/${name}.json`,
        JSON.stringify(
          { name, abi: contract.abi, bytecode, runtimeBytes },
          null,
          2,
        ) + "\n",
      );
      abis[name] = contract.abi;
      console.log(`${name}: ${runtimeBytes} runtime bytes`);
    }
  }
  fs.writeFileSync("public/abis.json", JSON.stringify(abis) + "\n");
}
if (process.argv[1]?.endsWith("compile.mjs")) compile();
