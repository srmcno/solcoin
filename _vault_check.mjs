import { PublicKey } from '@solana/web3.js';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const payer = new PublicKey('FFPmqVLMj9TNbQXcrXyevcM3pxGaK4ApaAT4oLq2b3S7');
const mint  = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
for (const seed of ['creator-vault','creator_vault']) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from(seed), payer.toBuffer()], PUMP);
  console.log(`${seed} (payer/creator) ->`, pda.toBase58());
}
const [bc] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
console.log('bonding-curve ->', bc.toBase58());
const [g] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP);
console.log('global ->', g.toBase58());
