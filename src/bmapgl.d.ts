/** 百度 GL JS API 最小声明：地图层只在浏览器端使用，宽松 any 即可 */

declare const BMapGL: any;

interface Window {
  BMapGL?: any;
  [key: string]: any;
}
