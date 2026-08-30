import { PublicKey } from '@solana/web3.js';
const PUMP=new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const buyer=new PublicKey('ssssswdk4RR8HqkE3uwUWzDbd6mXFTTPjcXBKNzQ57E');
const [p]=PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'),buyer.toBuffer()],PUMP);
console.log('PDA["user_volume_accumulator", BUYER ssssswdk] =',p.toBase58());
console.log('30bps (395,512) recipient in that tx      = 2wzXMxGx4sdwNUk9DpRR17B9wj16jY1B6n6Yeiokf5yi');
