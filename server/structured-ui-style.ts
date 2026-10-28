/** Canonical style validator. scripts/sync-ui-style.mjs embeds this exact function in the iframe. */
export function validateStructuredUiStyle(raw: any, version = 1): Record<string, any> {
  const fail = (message: string): never => { throw new Error('Invalid structured UI style: ' + message); };
  const plain = (x: any) => x && typeof x === 'object' && !Array.isArray(x)
    && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
  if (!plain(raw)) fail('expected object');
  const enums: Record<string, string[]> = {direction:['row','column'],tone:['default','muted','accent'],align:['start','center','end']};
  const ranges: Record<string, number[]> = {gap:[0,32],padding:[0,32],columns:[1,4]};
  if (version === 2) {
    Object.assign(enums,{fontFamily:['sans','serif','mono']});
    Object.assign(ranges,{width:[160,1920],maxWidth:[160,1920],widthPercent:[20,100],span:[1,4],radius:[0,32],borderWidth:[0,2],fontSize:[16,36],fontWeight:[400,700],lineHeight:[1.3,2],height:[180,640],aspectRatio:[.5,3]});
  }
  const result: Record<string, any> = {};
  for (const [key,value] of Object.entries(raw)) {
    if (Object.hasOwn(enums,key)) {
      if (typeof value !== 'string' || !enums[key].includes(value)) fail(key);
    } else if (Object.hasOwn(ranges,key)) {
      const [min,max] = ranges[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
        || !['lineHeight','aspectRatio','widthPercent'].includes(key) && !Number.isInteger(value)) fail(key);
      if (key === 'fontWeight' && Number(value) % 100 !== 0) fail(key);
    } else if (version === 2 && ['color','background','borderColor'].includes(key)) {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(key);
    } else if (version === 2 && key === 'columnWeights') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<.25||n>4)) fail(key);
    } else if (version === 2 && key === 'mobile') {
      if (!plain(value) || Object.hasOwn(value as object,'mobile')) fail('nested mobile');
      result.mobile = validateStructuredUiStyle(value,2); continue;
    } else fail('unsupported property '+key);
    result[key] = Array.isArray(value) ? [...value] : value;
  }
  if (result.width !== undefined && result.widthPercent !== undefined) fail('choose width or widthPercent');
  if (result.columnWeights && result.columns !== undefined && result.columns !== result.columnWeights.length) fail('columns must match columnWeights');
  if (result.color && result.background) {
    const luminance = (hex: string) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const a=luminance(result.color),b=luminance(result.background);
    if ((Math.max(a,b)+.05)/(Math.min(a,b)+.05)<4.5) fail('text/background contrast');
  }
  return result;
}
