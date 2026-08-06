declare module "@letele/playing-cards/dist/index.esm.js" {
  import type { ComponentType, SVGProps } from "react";

  export const B1: ComponentType<SVGProps<SVGSVGElement>>;
  export const B2: ComponentType<SVGProps<SVGSVGElement>>;

  const cards: Record<string, ComponentType<SVGProps<SVGSVGElement>>>;
  export = cards;
}
