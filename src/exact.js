// JSON-safe rational arithmetic. Display rounding never feeds back into game state.
const gcd = (a, b) => b ? gcd(b, a % b) : a < 0n ? -a : a;
export function fraction(value, denominator = 1) {
  if (value && typeof value === 'object' && 'n' in value) return fraction(value.n, value.d);
  if (typeof value === 'number' && !Number.isInteger(value)) {
    if (!Number.isFinite(value) || /e/i.test(String(value))) throw new Error('请使用明确的整数或分数。');
    const digits = String(value).split('.')[1].length; return fraction(String(value).replace('.', ''), 10n ** BigInt(digits));
  }
  let n = BigInt(value), d = BigInt(denominator); if (d === 0n) throw new Error('分母不能为0。');
  if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n;
  return { n: String(n / g), d: String(d / g) };
}
export function add(a, b) { a = fraction(a); b = fraction(b); return fraction(BigInt(a.n)*BigInt(b.d)+BigInt(b.n)*BigInt(a.d),BigInt(a.d)*BigInt(b.d)); }
export const negate = a => { a = fraction(a); return { ...a, n: String(-BigInt(a.n)) }; };
export function multiply(a, b) { a = fraction(a); b = fraction(b); return fraction(BigInt(a.n)*BigInt(b.n),BigInt(a.d)*BigInt(b.d)); }
export const divide = (a,b) => { b=fraction(b); return multiply(a, fraction(b.d,b.n)); };
export function compare(a,b) { a=fraction(a); b=fraction(b); const v=BigInt(a.n)*BigInt(b.d)-BigInt(b.n)*BigInt(a.d); return v<0n?-1:v>0n?1:0; }
export function floor(a) { a=fraction(a); const n=BigInt(a.n),d=BigInt(a.d); return Number(n/d-(n<0n&&n%d!==0n?1n:0n)); }
export const ceil = a => -floor(negate(a));
export const clampResource = (a,max) => compare(a,0)<0?fraction(0):compare(a,max)>0?fraction(max):fraction(a);
export function integer(n,min=0,max=Number.MAX_SAFE_INTEGER) { if(!Number.isSafeInteger(n)||n<min||n>max) throw new Error(`需要 ${min}—${max} 的整数。`); return n; }
export function ratioModifier(a,b) { integer(a,1);integer(b,1); if(a<=b)return 0; if(BigInt(a)*2n<BigInt(b)*3n)return 2; if(BigInt(a)<BigInt(b)*2n)return 4; if(BigInt(a)<BigInt(b)*3n)return 6; return 8; }
export function randomDie(sides, random = a => crypto.getRandomValues(a)) {
  integer(sides,1,0xffffffff); if(sides===1)return 1;
  const cap=0x100000000-(0x100000000%sides), data=new Uint32Array(1);
  do { random(data); } while(data[0]>=cap); return data[0]%sides+1;
}
export function sampleDice(p, random) {
  integer(p.sides??20,1,0xffffffff);integer(p.count??1,1,1000);
  if(!p.purpose?.trim())throw new Error('检定必须先说明用途。');
  for(const m of p.modifiers||[]) { if(!m.source||!Number.isFinite(m.value))throw new Error('修正必须有来源及有限数值。'); }
  const raw=Array.from({length:p.count??1},()=>randomDie(p.sides??20,random)), rawTotal=raw.reduce((a,b)=>a+b,0), modifierTotal=(p.modifiers||[]).reduce((a,b)=>a+b.value,0);
  return {raw,rawTotal,modifierTotal,total:rawTotal+modifierTotal};
}
export function ordinary(roll) { if(roll.raw.length!==1||roll.parameters.sides!==20)throw new Error('普通检定必须使用单个D20。');return roll.raw[0]===1?'critical-failure':roll.raw[0]===20?'critical-success':roll.total>=10?'success':'failure'; }
