import { MissionTree, type MissionNode } from "../domain/mission-tree";

export interface MissionSnapshot {
  id: string;
  nodes: MissionNode[];
}

export class MissionRegistry {
  private readonly trees = new Map<string, MissionTree>();

  create(root: MissionNode): MissionSnapshot {
    if (this.trees.has(root.id)) throw new Error(`Mission already exists: ${root.id}`);
    const tree = new MissionTree(root);
    this.trees.set(root.id, tree);
    return { id: root.id, nodes: tree.list() };
  }

  list(): MissionSnapshot[] {
    return [...this.trees.entries()].map(([id, tree]) => ({ id, nodes: tree.list() }));
  }

  split(id: string, parentId: string, children: MissionNode[]): MissionSnapshot {
    const tree = this.require(id);
    tree.split(parentId, children);
    return { id, nodes: tree.list() };
  }

  merge(id: string, nodeIds: string[], merged: MissionNode): MissionSnapshot {
    const tree = this.require(id);
    tree.merge(nodeIds, merged);
    return { id, nodes: tree.list() };
  }

  promote(id: string, nodeId: string, output: string): MissionSnapshot {
    const tree = this.require(id);
    tree.promote(nodeId, output);
    return { id, nodes: tree.list() };
  }

  collapse(id: string, parentId: string): MissionSnapshot {
    const tree = this.require(id);
    tree.collapse(parentId);
    return { id, nodes: tree.list() };
  }

  private require(id: string): MissionTree {
    const tree = this.trees.get(id);
    if (!tree) throw new Error(`Unknown mission: ${id}`);
    return tree;
  }
}
