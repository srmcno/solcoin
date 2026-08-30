import { PublicKey } from '@solana/web3.js';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const FEEP = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const creator = new PublicKey('FFPmqVLMj9TNbQXcrXyevcM3pxGaK4ApaAT4oLq2b3S7');
const mint = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
const TARGET='8xU1ScBQRXKB8B5VMrTZoNkEqGCu8yLSvLT8V3DDnuzv';
const seeds=['creator-vault','creator_vault','creator-fee','creator_fee','user-volume-accumulator','user_volume_accumulator','creator-fee-vault','fee-vault','creator','vault','creator-fee-config','fee_recipient'];
for (const prog of [PUMP,FEEP]) for (const s of seeds) for (const extra of [[creator.toBuffer()],[creator.toBuffer(),mint.toBuffer()],[mint.toBuffer()],[]]) {
  try{
    const [pda]=PublicKey.findProgramAddressSync([Buffer.from(s),...extra],prog);
    if(pda.toBase58()===TARGET) console.log('MATCH!',prog.toBase58(),'seed=',s,'extra=',extra.length);
  }catch(e){}
}
console.log('brute force done');
