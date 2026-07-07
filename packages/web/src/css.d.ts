declare module "*.css" {}
declare module "*.css?inline" {}

declare module "lucide-react/dist/esm/icons/*.js" {
  import type { ComponentType, SVGProps } from "react";

  const Icon: ComponentType<SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number | string;
  }>;
  export default Icon;
}
