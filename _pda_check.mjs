import { PublicKey } from '@solana/web3.js';
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
for (const seed of ['fee_config','fee-config','global_config']) {
  try {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed), PUMP.toBuffer()], FEE_PROGRAM);
    console.log(seed, '->', pda.toBase58(), 'bump', bump);
  } catch(e){ console.log(seed, 'ERR', e.message); }
}
