declare module "*.css" {
  const source: string;
  export default source;
}

declare module "*.svg" {
  const dataUrl: string;
  export default dataUrl;
}
