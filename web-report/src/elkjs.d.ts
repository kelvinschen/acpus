declare module "elkjs/lib/elk.bundled.js" {
  type ElkNode = {
    id: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    children?: ElkNode[];
    edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
    layoutOptions?: Record<string, string>;
  };

  export default class ELK {
    layout(graph: ElkNode): Promise<ElkNode>;
  }
}
