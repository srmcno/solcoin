import { PublicKey } from '@solana/web3.js';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const creator = new PublicKey(Buffer.from('d3b37f72fd14eb6a44dd2e51f95ca4397aee04cd2ebd4ec1a56dd55ecafa1118','hex'));
console.log('creator pubkey stored in bonding curve:', creator.toBase58());
for (const seed of ['creator-vault','creator_vault']) {
  const [pda,b] = PublicKey.findProgramAddressSync([Buffer.from(seed), creator.toBuffer()], PUMP);
  console.log(`PDA["${seed}", creator] ->`, pda.toBase58(), 'bump', b);
}
