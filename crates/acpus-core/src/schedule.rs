use crate::{AcpusIr, IrNode, ScheduleBranch, ScheduleNode, ScheduleSummary};

pub fn create_schedule(ir: &AcpusIr) -> ScheduleSummary {
    ScheduleSummary {
        workflow: ir.name.clone(),
        nodes: ir.root.children.iter().map(schedule_node).collect(),
    }
}

fn schedule_node(node: &IrNode) -> ScheduleNode {
    ScheduleNode {
        id: node.id.clone(),
        kind: node.kind.clone(),
        node_path: node.node_path.join("/"),
        output_merge: node.output_merge.clone(),
        children: node.children.iter().map(schedule_node).collect(),
        branches: node
            .branches
            .iter()
            .map(|branch| ScheduleBranch {
                id: branch.id.clone(),
                when: branch.when.clone(),
                children: vec![schedule_node(&branch.child)],
            })
            .collect(),
    }
}
