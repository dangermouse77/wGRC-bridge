const { AnchorProvider, Program } = require("@anchor-lang/core");
const { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const idl = require("../target/idl/wgrc_bridge.json");

async function main() {
  const uri = process.argv[2];
  if (process.argv.length !== 3 || !uri.startsWith("https://")) {
    throw new Error("Usage: node scripts/create-token-metadata.cjs <HTTPS metadata JSON URL>");
  }
  if (process.env.ANCHOR_PROVIDER_URL !== "https://api.devnet.solana.com") {
    throw new Error("Set ANCHOR_PROVIDER_URL to https://api.devnet.solana.com.");
  }

  const environment = AnchorProvider.env();
  const provider = new AnchorProvider(environment.connection, environment.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const metadataProgram = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [bridge] = PublicKey.findProgramAddressSync([Buffer.from("bridge")], program.programId);
  const [mint] = PublicKey.findProgramAddressSync([Buffer.from("mint")], program.programId);
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), metadataProgram.toBuffer(), mint.toBuffer()],
    metadataProgram,
  );
  const signature = await program.methods.createTokenMetadata(uri).accountsStrict({
    admin: provider.wallet.publicKey,
    bridge,
    mint,
    metadata,
    metadataProgram,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }).rpc();
  console.log(`Metadata account: ${metadata}\nDevnet transaction: ${signature}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
