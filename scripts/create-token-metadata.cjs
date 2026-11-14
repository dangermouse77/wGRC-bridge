const { AnchorProvider, Program } = require("@anchor-lang/core");
const { readFileSync } = require("node:fs");
const { fetchMetadata, mplTokenMetadata, updateV1 } = require("@metaplex-foundation/mpl-token-metadata");
const { keypairIdentity, publicKey, some } = require("@metaplex-foundation/umi");
const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
const { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const idl = require("../target/idl/wgrc_bridge.json");

async function main() {
  const uri = process.argv[2];
  if (process.argv.length !== 3 || !uri.startsWith("https://") || Buffer.byteLength(uri) > 200) {
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
  console.log(`Metadata account: ${metadata}`);
  if (await provider.connection.getAccountInfo(metadata, "confirmed")) {
    const umi = createUmi(provider.connection.rpcEndpoint).use(mplTokenMetadata());
    const current = await fetchMetadata(umi, publicKey(metadata.toBase58()), {
      commitment: "confirmed",
    });
    console.log(`Current URI: ${current.uri}\nUpdate authority: ${current.updateAuthority}`);
    if (current.uri === uri) {
      console.log("The metadata already points to this URL.");
      return;
    }
    if (!current.isMutable || current.updateAuthority !== provider.wallet.publicKey.toBase58()) {
      throw new Error("Updating the URI requires mutable metadata and its update authority wallet.");
    }
    const secretKey = Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET, "utf8")));
    umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secretKey)));
    await updateV1(umi, {
      mint: publicKey(mint.toBase58()),
      authority: umi.identity,
      data: some({
        name: current.name,
        symbol: current.symbol,
        uri,
        sellerFeeBasisPoints: current.sellerFeeBasisPoints,
        creators: current.creators,
      }),
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    const updated = await fetchMetadata(umi, publicKey(metadata.toBase58()), {
      commitment: "confirmed",
    });
    if (updated.uri !== uri) throw new Error(`Unexpected URI after update: ${updated.uri}`);
    console.log(`Updated URI: ${updated.uri}`);
    return;
  }
  const signature = await program.methods.createTokenMetadata(uri).accountsStrict({
    admin: provider.wallet.publicKey,
    bridge,
    mint,
    metadata,
    metadataProgram,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }).rpc();
  console.log(`Devnet transaction: ${signature}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
