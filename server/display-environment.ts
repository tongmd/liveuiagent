export function normalizeDisplayEnvironment(value: unknown) {
  const size = (v: any) => v && typeof v === 'object' && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width>=240 && v.width<=3840 && v.height>=240 && v.height<=2160
    ? {width:Math.round(v.width),height:Math.round(v.height)} : null;
  const input=value && typeof value==='object' ? value as any : {};
  return {browserViewport:size(input.browserViewport),appViewport:size(input.appViewport)};
}
