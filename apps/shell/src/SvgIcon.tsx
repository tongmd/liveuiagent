import { SvgXml } from 'react-native-svg';

export function SvgIcon({ svg, size = 48 }: { svg: string; size?: number }) {
  return <SvgXml xml={svg} width={size} height={size} />;
}
