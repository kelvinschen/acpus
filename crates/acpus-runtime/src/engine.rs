use crate::{RunStore, interpreter};

#[derive(Clone, Debug)]
pub struct RuntimeEngine {
    store: RunStore,
}

impl RuntimeEngine {
    pub fn new(store: RunStore) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &RunStore {
        &self.store
    }

    pub async fn execute_run(&self, run_id: impl Into<String>) -> anyhow::Result<()> {
        interpreter::execute_ir(self.store.clone(), run_id.into()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_holds_runtime_store_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let engine = RuntimeEngine::new(store.clone());

        assert_eq!(engine.store().state_dir, store.state_dir);
    }
}
